import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { textoPersona, validarCorreo, validarTelefono } from '../../utils/personas.js';
import { resolverDocumento } from '../terceros/terceros.service.js';
import { proveedorConfigurado, proveedorEsSandbox } from '../facturacion/index.js';

/**
 * A0-09 · Ficha del emisor (quien factura): una sola fila.
 *
 * Nada de esto vive en el código ni en una semilla: el NIT, la razón social y la
 * dirección de JD&D los escribe una persona desde la pantalla, para poder cambiar
 * de NIT (o de sociedad) sin tocar una línea (decisión 1 del §0 del plan, R-03).
 * Orbita tampoco custodia el certificado de firma ni su llave: los trae el paquete
 * del proveedor.
 */

const EMISOR_SELECT = `
  e.tipo_persona, e.nit, e.dv, e.razon_social, e.nombre_comercial, e.direccion,
  e.municipio_id, m.nombre AS municipio_nombre, m.codigo_dian AS municipio_codigo, dp.nombre AS departamento_nombre,
  e.correo, e.telefono, e.ciiu_principal, e.ciiu_secundarias, e.responsabilidades_rut, e.ambiente,
  to_char(e.paquete_proveedor_vence, 'YYYY-MM-DD') AS paquete_proveedor_vence,
  to_char(e.documentos_certificado_enviados_en, 'YYYY-MM-DD') AS documentos_certificado_enviados_en,
  (e.paquete_proveedor_vence - CURRENT_DATE) AS dias_para_vencer_paquete,
  e.actualizado_en`;

const EMISOR_FROM = `
  FROM sst.emisor e
  JOIN sst.municipios m ON m.id = e.municipio_id
  JOIN sst.departamentos dp ON dp.id = m.departamento_id`;

export async function obtenerEmisor(client = pool) {
  const r = await client.query(`SELECT ${EMISOR_SELECT} ${EMISOR_FROM} WHERE e.id = 1`);
  return r.rows[0] ?? null;
}

/**
 * Lo que la ficha declara contra lo que el servidor realmente usa. Una ficha en
 * PRODUCCION con la URL del sandbox (o al revés) emite facturas que no valen, así
 * que la pantalla lo avisa.
 */
export function estadoProveedor(emisor) {
  const configurado = proveedorConfigurado();
  const sandbox = configurado ? proveedorEsSandbox() : null;
  let aviso = null;
  if (!configurado) aviso = 'El proveedor de facturación no está configurado en el servidor (faltan las variables FACTUS_*).';
  else if (emisor?.ambiente === 'PRODUCCION' && sandbox) aviso = 'La ficha dice PRODUCCION pero el servidor apunta al sandbox del proveedor.';
  else if (emisor?.ambiente === 'PRUEBAS' && !sandbox) aviso = 'La ficha dice PRUEBAS pero el servidor apunta al ambiente real del proveedor.';
  return { configurado, sandbox, aviso };
}

function fecha(v, campo) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim();
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw badRequest(`${campo} debe ser una fecha válida (AAAA-MM-DD).`);
  }
  return s;
}

const lista = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean);

/** Valida el cuerpo del formulario y devuelve las columnas listas para guardar. */
export async function validarEmisor(b = {}, client = pool) {
  const tipoPersona = String(b.tipo_persona || 'JURIDICA').toUpperCase();
  if (!['NATURAL', 'JURIDICA'].includes(tipoPersona)) throw badRequest('Indique si el emisor es persona natural o jurídica.');

  const { numero, dv } = resolverDocumento('31', b.nit);

  const razonSocial = textoPersona(b.razon_social);
  if (!razonSocial) throw badRequest('La razón social es obligatoria.');
  const direccion = textoPersona(b.direccion);
  if (!direccion) throw badRequest('La dirección es obligatoria.');

  if (!b.municipio_id) throw badRequest('El municipio es obligatorio.');
  const m = await client.query(`SELECT id FROM sst.municipios WHERE id = $1`, [b.municipio_id]);
  if (!m.rows[0]) throw badRequest('El municipio no existe en el catálogo.');

  const ciiuPrincipal = String(b.ciiu_principal ?? '').trim() || null;
  const ciiuSecundarias = lista(b.ciiu_secundarias);
  for (const c of [ciiuPrincipal, ...ciiuSecundarias].filter(Boolean)) {
    if (!/^\d{4}$/.test(c)) throw badRequest(`La actividad económica "${c}" debe tener 4 dígitos (CIIU).`);
  }
  const responsabilidades = lista(b.responsabilidades_rut);
  for (const c of responsabilidades) {
    if (!/^\d{1,2}$/.test(c)) throw badRequest(`La responsabilidad del RUT "${c}" debe ser un código numérico (05, 07, 48…).`);
  }

  const ambiente = String(b.ambiente || 'PRUEBAS').toUpperCase();
  if (!['PRUEBAS', 'PRODUCCION'].includes(ambiente)) throw badRequest('El ambiente debe ser PRUEBAS o PRODUCCION.');

  return {
    tipo_persona: tipoPersona,
    nit: numero,
    dv,
    razon_social: razonSocial,
    nombre_comercial: textoPersona(b.nombre_comercial) || null,
    direccion,
    municipio_id: m.rows[0].id,
    correo: validarCorreo(b.correo),
    telefono: validarTelefono(b.telefono),
    ciiu_principal: ciiuPrincipal,
    ciiu_secundarias: [...new Set(ciiuSecundarias)],
    responsabilidades_rut: [...new Set(responsabilidades.map((c) => c.padStart(2, '0')))],
    ambiente,
    paquete_proveedor_vence: fecha(b.paquete_proveedor_vence, 'La fecha de vencimiento del paquete'),
    documentos_certificado_enviados_en: fecha(b.documentos_certificado_enviados_en, 'La fecha de envío de los documentos del certificado'),
  };
}

const CAMPOS = [
  'tipo_persona', 'nit', 'dv', 'razon_social', 'nombre_comercial', 'direccion', 'municipio_id',
  'correo', 'telefono', 'ciiu_principal', 'ciiu_secundarias', 'responsabilidades_rut', 'ambiente',
  'paquete_proveedor_vence', 'documentos_certificado_enviados_en',
];

/** Crea la ficha la primera vez y la sustituye después (siempre la fila id = 1). */
export async function guardarEmisor(campos, usuarioId, client = pool) {
  await client.query(
    `INSERT INTO sst.emisor (id, ${CAMPOS.join(', ')}, actualizado_por)
     VALUES (1, ${CAMPOS.map((_, i) => `$${i + 1}`).join(', ')}, $${CAMPOS.length + 1})
     ON CONFLICT (id) DO UPDATE
        SET ${CAMPOS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
            actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()`,
    [...CAMPOS.map((c) => campos[c]), usuarioId],
  );
  return obtenerEmisor(client);
}
