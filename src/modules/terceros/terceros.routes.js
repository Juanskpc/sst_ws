import { Router } from 'express';
import { pool, withTransaction } from '../../config/db.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';
import { authRequired, requireRole } from '../../middleware/auth.js';
import {
  CAMPOS_TERCERO, CODIGO_CEDULA, TERCERO_FROM, TERCERO_SELECT,
  conFaltantes, documentoOcupado, validarTercero,
} from './terceros.service.js';
import { importarTerceros, plantillaTerceros } from './importar.service.js';
import { uploadImport } from '../../middleware/upload.js';

const router = Router();
router.use(authRequired);

/**
 * A0-05 · Terceros (PAR-03).
 *
 * Lectura: admin, contador y auditor (el auditor consulta, no edita).
 * Escritura: admin y contador. El `administrativo` no ve lo financiero.
 * La vista `terceros` de la matriz de permisos gobierna el menú; aquí el
 * servidor decide por rol, igual que el resto de módulos.
 */
const LEER = requireRole('admin', 'contador', 'auditor');
const ESCRIBIR = requireRole('admin', 'contador');

const ROLES_FILTRO = { cliente: 'es_cliente', proveedor: 'es_proveedor', empleado: 'es_empleado', arl: 'es_arl' };

async function cargar(client, id) {
  const r = await client.query(`SELECT ${TERCERO_SELECT} ${TERCERO_FROM} WHERE t.id = $1`, [id]);
  return r.rows[0] ? conFaltantes(r.rows[0]) : null;
}

// Listado. ?q= busca por documento (con o sin puntos/DV) o por nombre;
// ?rol=cliente|proveedor|empleado|arl; ?activo=true|false; ?page= y ?limit= son
// opcionales (sin ellos devuelve todo: la pantalla pagina en el cliente).
router.get('/', LEER, asyncHandler(async (req, res) => {
  const { q, rol, activo } = req.query;
  const params = [];
  const filtros = [];

  if (q && String(q).trim()) {
    const texto = String(q).trim();
    params.push(`%${texto}%`);
    const iNombre = params.length;
    const digitos = texto.replace(/\D/g, '');
    let porDocumento = '';
    if (digitos) {
      params.push(`${digitos}%`);
      porDocumento = ` OR t.numero_documento LIKE $${params.length}`;
    }
    filtros.push(`(COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) ILIKE $${iNombre}
                   OR t.nombre_comercial ILIKE $${iNombre}${porDocumento})`);
  }
  if (rol) {
    const columna = ROLES_FILTRO[String(rol)];
    if (!columna) throw badRequest('El rol debe ser cliente, proveedor, empleado o arl.');
    filtros.push(`t.${columna}`);
  }
  if (activo === 'true' || activo === 'false') {
    params.push(activo === 'true');
    filtros.push(`t.activo = $${params.length}`);
  }
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  const total = await pool.query(`SELECT count(*)::int AS n FROM sst.terceros t ${where}`, params);

  let paginacion = '';
  const limit = Number.parseInt(req.query.limit, 10);
  if (Number.isInteger(limit) && limit > 0) {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    params.push(Math.min(limit, 500), (page - 1) * Math.min(limit, 500));
    paginacion = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }

  const r = await pool.query(
    `SELECT ${TERCERO_SELECT} ${TERCERO_FROM} ${where}
      ORDER BY COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))), t.id ${paginacion}`,
    params,
  );
  res.json({ data: r.rows.map(conFaltantes), total: total.rows[0].n });
}));

// Datos con los que se propone crear el tercero de un profesional. Va ANTES de
// `/:id` para que "desde-profesional" no se lea como un id.
// 7-oct-2026 · Cargue por Excel (antes de /:id, que si no capturaría «plantilla.xlsx»).
router.get('/plantilla.xlsx', LEER, asyncHandler(async (_req, res) => {
  const buf = await plantillaTerceros();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-terceros.xlsx"');
  res.send(Buffer.from(buf));
}));

// ?simular=true revisa sin guardar. ?rol=AUTO|CLIENTE|PROVEEDOR|AMBOS para las filas sin roles
// (la exportación de Siigo no los trae). Carga las filas válidas; las que ya existen no se tocan.
router.post('/importar', ESCRIBIR, uploadImport.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Adjunte el Excel de terceros.');
  res.json({
    data: await importarTerceros(req.file.buffer, {
      usuarioId: req.user.sub, simular: req.query.simular === 'true', rolPorDefecto: req.query.rol || 'AUTO',
    }),
  });
}));

router.get('/desde-profesional/:profesionalId', LEER, asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT p.id, p.nombre, p.correo, p.telefono, p.tercero_id, u.documento_identidad
       FROM sst.profesionales p
       LEFT JOIN sst.usuarios u ON u.id = p.usuario_id
      WHERE p.id = $1`,
    [req.params.profesionalId],
  );
  const p = r.rows[0];
  if (!p) throw notFound('Profesional no encontrado');

  // La ficha del profesional guarda el nombre completo en un solo campo y partirlo
  // en nombres/apellidos es una suposición (los nombres compuestos no tienen regla):
  // se ofrece la mitad y mitad como PROPUESTA que la persona corrige en el formulario.
  const palabras = String(p.nombre).trim().split(/\s+/);
  const corte = Math.ceil(palabras.length / 2);
  res.json({
    data: {
      profesional_id: p.id,
      tercero_id: p.tercero_id,
      nombres: palabras.slice(0, corte).join(' '),
      apellidos: palabras.slice(corte).join(' '),
      numero_documento: p.documento_identidad || '',
      correo_facturacion: p.correo,
      telefono: p.telefono,
    },
  });
}));

router.get('/:id', LEER, asyncHandler(async (req, res) => {
  const t = await cargar(pool, req.params.id);
  if (!t) throw notFound('Tercero no encontrado');
  res.json({ data: t });
}));

async function insertar(client, campos, usuarioId) {
  const r = await client.query(
    `INSERT INTO sst.terceros (${CAMPOS_TERCERO.join(', ')}, creado_por, actualizado_por)
     VALUES (${CAMPOS_TERCERO.map((_, i) => `$${i + 1}`).join(', ')}, $${CAMPOS_TERCERO.length + 1}, $${CAMPOS_TERCERO.length + 1})
     RETURNING id`,
    [...CAMPOS_TERCERO.map((c) => campos[c]), usuarioId],
  );
  return r.rows[0].id;
}

// Alta. El DV se calcula aquí; un documento repetido se rechaza con 409.
router.post('/', ESCRIBIR, asyncHandler(async (req, res) => {
  const campos = await validarTercero(req.body);
  const dueno = await documentoOcupado(pool, campos.tipo_documento_id, campos.numero_documento);
  if (dueno) throw conflict(`El documento ${campos.numero_documento} ya está registrado a nombre de ${dueno}.`);

  const id = await insertar(pool, campos, req.user.sub);
  res.status(201).json({ data: await cargar(pool, id) });
}));

// Edición: sustituye la ficha completa (ver validarTercero).
router.put('/:id', ESCRIBIR, asyncHandler(async (req, res) => {
  const campos = await validarTercero(req.body);
  const dueno = await documentoOcupado(pool, campos.tipo_documento_id, campos.numero_documento, req.params.id);
  if (dueno) throw conflict(`El documento ${campos.numero_documento} ya está registrado a nombre de ${dueno}.`);

  const r = await pool.query(
    `UPDATE sst.terceros
        SET ${CAMPOS_TERCERO.map((c, i) => `${c} = $${i + 2}`).join(', ')}, actualizado_por = $${CAMPOS_TERCERO.length + 2}
      WHERE id = $1 RETURNING id`,
    [req.params.id, ...CAMPOS_TERCERO.map((c) => campos[c]), req.user.sub],
  );
  if (!r.rows[0]) throw notFound('Tercero no encontrado');
  res.json({ data: await cargar(pool, req.params.id) });
}));

// Activar / desactivar. Un tercero nunca se borra: cuelga de facturas y asientos.
router.patch('/:id/estado', ESCRIBIR, asyncHandler(async (req, res) => {
  if (typeof req.body?.activo !== 'boolean') throw badRequest('activo (boolean) es obligatorio');
  const r = await pool.query(
    `UPDATE sst.terceros SET activo = $2, actualizado_por = $3 WHERE id = $1 RETURNING id`,
    [req.params.id, req.body.activo, req.user.sub],
  );
  if (!r.rows[0]) throw notFound('Tercero no encontrado');
  res.json({ data: await cargar(pool, req.params.id) });
}));

/**
 * "Crear tercero desde el profesional": el documento soporte (A4) le compra
 * servicios a cada asesor y exige su documento, dirección y municipio, que la
 * ficha de profesional no tiene. Nace como PROVEEDOR y queda enlazado.
 *
 * Si ese documento ya es un tercero (p. ej. la misma persona ya era cliente), no
 * se duplica: se le suma el rol de proveedor y se enlaza, y la respuesta dice
 * `enlazado: true`.
 */
router.post('/desde-profesional/:profesionalId', ESCRIBIR, asyncHandler(async (req, res) => {
  const resultado = await withTransaction(async (client) => {
    const p = await client.query(
      `SELECT p.id, p.tercero_id, p.correo, p.telefono, u.documento_identidad
         FROM sst.profesionales p LEFT JOIN sst.usuarios u ON u.id = p.usuario_id
        WHERE p.id = $1 FOR UPDATE OF p`,
      [req.params.profesionalId],
    );
    const prof = p.rows[0];
    if (!prof) throw notFound('Profesional no encontrado');
    if (prof.tercero_id) throw conflict('Este profesional ya tiene un tercero enlazado.');

    // Lo que la persona no escribió se completa con lo que ya sabe la ficha.
    const cuerpo = req.body || {};
    let tipoDocumentoId = cuerpo.tipo_documento_id;
    if (!tipoDocumentoId) {
      const ced = await client.query(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = $1`, [CODIGO_CEDULA]);
      tipoDocumentoId = ced.rows[0]?.id;
    }
    const campos = await validarTercero({
      ...cuerpo,
      tipo_documento_id: tipoDocumentoId,
      numero_documento: cuerpo.numero_documento || prof.documento_identidad,
      correo_facturacion: cuerpo.correo_facturacion || prof.correo,
      telefono: cuerpo.telefono || prof.telefono,
      tipo_persona: 'NATURAL',
      es_proveedor: true,
    }, client);

    const existente = await client.query(
      `SELECT id FROM sst.terceros WHERE tipo_documento_id = $1 AND numero_documento = $2`,
      [campos.tipo_documento_id, campos.numero_documento],
    );
    let terceroId = existente.rows[0]?.id;
    const enlazado = Boolean(terceroId);
    if (enlazado) {
      await client.query(`UPDATE sst.terceros SET es_proveedor = true, actualizado_por = $2 WHERE id = $1`, [terceroId, req.user.sub]);
    } else {
      terceroId = await insertar(client, campos, req.user.sub);
    }
    await client.query(`UPDATE sst.profesionales SET tercero_id = $2 WHERE id = $1`, [prof.id, terceroId]);
    return { terceroId, enlazado };
  });

  res.status(resultado.enlazado ? 200 : 201).json({
    data: await cargar(pool, resultado.terceroId),
    enlazado: resultado.enlazado,
  });
}));

export default router;
