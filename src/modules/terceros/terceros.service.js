import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { calcularDv, separarNit } from '../../utils/nit.js';
import { textoPersona, validarNombre, validarCorreo, validarTelefono } from '../../utils/personas.js';

/**
 * A0-05 · Terceros (PAR-03): a quién se FACTURA o se PAGA.
 *
 * Un tercero NO es una empresa ni un profesional de Orbita: `empresas` sigue
 * siendo "dónde se ejecuta el servicio" y `profesionales` "quién lo ejecuta". El
 * tercero es la identidad fiscal, y se enlaza con ellos por `tercero_id`.
 */

/** Tipos de documento (código DIAN) cuyo número puede traer letras. */
const DOCUMENTOS_ALFANUMERICOS = new Set(['41', '42']); // pasaporte y documento extranjero
const CODIGO_NIT = '31';
const CODIGO_CEDULA = '13';

export { CODIGO_CEDULA };

/** Columnas + joins con los que la API devuelve un tercero (una sola forma para lista y ficha). */
export const TERCERO_SELECT = `
  t.id, t.tipo_persona, t.tipo_documento_id,
  td.codigo_dian AS tipo_documento_codigo, td.nombre AS tipo_documento_nombre,
  t.numero_documento, t.dv,
  t.razon_social, t.nombres, t.apellidos, t.nombre_comercial,
  COALESCE(t.razon_social, btrim(concat_ws(' ', t.nombres, t.apellidos))) AS nombre,
  t.direccion, t.municipio_id, t.codigo_postal,
  m.nombre AS municipio_nombre, m.codigo_dian AS municipio_codigo,
  dp.nombre AS departamento_nombre,
  t.telefono, t.correo_facturacion, t.responsabilidades_fiscales, t.regimen,
  t.es_cliente, t.es_proveedor, t.es_empleado, t.es_arl, t.es_acreedor, t.activo,
  t.creado_en, t.actualizado_en,
  (SELECT COALESCE(jsonb_agg(a.nombre ORDER BY a.nombre), '[]'::jsonb) FROM sst.arls a WHERE a.tercero_id = t.id) AS arls_enlazadas,
  (SELECT count(*)::int FROM sst.empresas e WHERE e.tercero_id = t.id) AS empresas_enlazadas,
  (SELECT p.nombre FROM sst.profesionales p WHERE p.tercero_id = t.id LIMIT 1) AS profesional_enlazado`;

export const TERCERO_FROM = `
  FROM sst.terceros t
  JOIN sst.tipos_documento_identidad td ON td.id = t.tipo_documento_id
  LEFT JOIN sst.municipios m ON m.id = t.municipio_id
  LEFT JOIN sst.departamentos dp ON dp.id = m.departamento_id`;

/**
 * Qué le falta a un tercero para poder FACTURARLE. No bloquea el guardado (una
 * ficha se puede crear a medias y completar después) pero la pantalla lo avisa y
 * la emisión (A1) lo exigirá.
 */
export function faltantesParaFacturar(t) {
  const faltan = [];
  if (!t.direccion) faltan.push('dirección');
  if (!t.municipio_id) faltan.push('municipio');
  if (!t.correo_facturacion) faltan.push('correo de facturación');
  return faltan;
}

export const conFaltantes = (fila) => ({ ...fila, faltantes: faltantesParaFacturar(fila) });

const limpiar = (v) => {
  const s = v == null ? '' : String(v).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
};

/** Texto en mayúsculas (razón social, dirección…) con tope de longitud; vacío → null. */
function mayusculas(v, campo, maximo = 200) {
  const t = textoPersona(v);
  if (!t) return null;
  if (t.length > maximo) throw badRequest(`${campo} no puede pasar de ${maximo} caracteres.`);
  return t;
}

/**
 * Número de documento normalizado y, si es NIT, su dígito de verificación.
 *
 * El DV NO lo teclea nadie: se calcula. Si quien captura pegó el NIT con su DV
 * marcado ("860.002.183-9") se comprueba que coincida y se rechaza si no, porque
 * un DV mal escrito hace que la DIAN rechace la factura entera. Si el DV viene
 * pegado sin separador no se adivina: es un NIT de un dígito más largo.
 */
export function resolverDocumento(tipoCodigo, valor) {
  const bruto = limpiar(valor);
  if (!bruto) throw badRequest('El número de documento es obligatorio.');

  if (DOCUMENTOS_ALFANUMERICOS.has(tipoCodigo)) {
    const doc = bruto.replace(/[\s.\-]/g, '').toUpperCase();
    if (!/^[0-9A-Z]{5,20}$/.test(doc)) {
      throw badRequest('El documento debe tener entre 5 y 20 letras o números, sin espacios ni símbolos.');
    }
    return { numero: doc, dv: null };
  }

  if (tipoCodigo === CODIGO_NIT) {
    const s = separarNit(bruto);
    if (!s.numero) throw badRequest('El NIT debe tener al menos un dígito.');
    if (s.numero.length < 5 || s.numero.length > 15) throw badRequest('El NIT debe tener entre 5 y 15 dígitos (sin el dígito de verificación).');
    if (s.coherente === false) {
      throw badRequest(`El dígito de verificación ${s.dv} no corresponde al NIT ${s.numero}: el correcto es ${s.dvCalculado}.`);
    }
    return { numero: s.numero, dv: calcularDv(s.numero) };
  }

  if (!/^[0-9.\s\-]+$/.test(bruto)) throw badRequest('Este tipo de documento solo admite números.');
  const numero = bruto.replace(/\D/g, '');
  if (numero.length < 5 || numero.length > 15) throw badRequest('El documento debe tener entre 5 y 15 dígitos.');
  return { numero, dv: null };
}

// 8-oct-2026 · El formulario ofrece «Acreedor» en vez de «ARL». `es_arl` sigue viajando en
// la ficha (la pantalla lo devuelve tal como lo recibió) para no quitárselo a las ARL.
const ROLES = ['es_cliente', 'es_proveedor', 'es_empleado', 'es_acreedor', 'es_arl'];
const REGIMENES = ['RESPONSABLE_IVA', 'NO_RESPONSABLE'];

/**
 * Valida y normaliza el cuerpo del formulario. Devuelve las columnas listas para
 * insertar. Es una sustitución completa (PUT): lo que no llega se vacía, porque
 * la pantalla manda siempre la ficha entera y así se puede BORRAR un dato
 * opcional, cosa que un COALESCE por campo no permite.
 */
export async function validarTercero(b = {}, client = pool) {
  const tipoPersona = String(b.tipo_persona || '').toUpperCase();
  if (!['NATURAL', 'JURIDICA'].includes(tipoPersona)) {
    throw badRequest('Indique si es persona natural o jurídica.');
  }

  if (!b.tipo_documento_id) throw badRequest('El tipo de documento es obligatorio.');
  const td = await client.query(`SELECT id, codigo_dian FROM sst.tipos_documento_identidad WHERE id = $1 AND activo`, [b.tipo_documento_id]);
  if (!td.rows[0]) throw badRequest('El tipo de documento no existe en el catálogo.');
  const { numero, dv } = resolverDocumento(td.rows[0].codigo_dian, b.numero_documento);

  let razonSocial = null;
  let nombres = null;
  let apellidos = null;
  if (tipoPersona === 'JURIDICA') {
    razonSocial = mayusculas(b.razon_social, 'La razón social');
    if (!razonSocial) throw badRequest('La razón social es obligatoria para una persona jurídica.');
  } else {
    nombres = validarNombre(b.nombres, 'Los nombres');
    apellidos = limpiar(b.apellidos) ? validarNombre(b.apellidos, 'Los apellidos') : null;
  }

  let municipioId = null;
  let postalDelMunicipio = null;
  if (limpiar(b.municipio_id)) {
    const m = await client.query(`SELECT id, codigo_postal FROM sst.municipios WHERE id = $1`, [b.municipio_id]);
    if (!m.rows[0]) throw badRequest('El municipio no existe en el catálogo.');
    municipioId = m.rows[0].id;
    postalDelMunicipio = m.rows[0].codigo_postal;
  }
  // 7-oct-2026 · El código postal sale del municipio; si el formulario trae otro (la
  // dirección cae en otra zona postal) se respeta. Seis dígitos, como los de 4-72.
  let codigoPostal = limpiar(b.codigo_postal);
  if (codigoPostal) {
    codigoPostal = codigoPostal.replace(/\D/g, '');
    if (codigoPostal.length !== 6) throw badRequest('El código postal tiene 6 dígitos.');
  } else {
    codigoPostal = municipioId ? postalDelMunicipio : null;
  }

  // Solo códigos que Factus acepta; sin esto un typo llegaría hasta la DIAN.
  const responsabilidades = [...new Set((Array.isArray(b.responsabilidades_fiscales) ? b.responsabilidades_fiscales : [])
    .map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
  if (responsabilidades.length) {
    const ok = await client.query(`SELECT codigo_dian FROM sst.responsabilidades_fiscales WHERE codigo_dian = ANY($1) AND activo`, [responsabilidades]);
    const validos = new Set(ok.rows.map((r) => r.codigo_dian));
    const malos = responsabilidades.filter((c) => !validos.has(c));
    if (malos.length) throw badRequest(`Responsabilidad fiscal no válida: ${malos.join(', ')}.`);
  }

  const regimen = String(b.regimen || 'RESPONSABLE_IVA').toUpperCase();
  if (!REGIMENES.includes(regimen)) throw badRequest('El régimen debe ser RESPONSABLE_IVA o NO_RESPONSABLE.');

  const roles = Object.fromEntries(ROLES.map((r) => [r, b[r] === true]));
  if (!ROLES.some((r) => roles[r])) {
    throw badRequest('Marque al menos un rol: cliente, proveedor, empleado o acreedor.');
  }

  return {
    tipo_persona: tipoPersona,
    tipo_documento_id: td.rows[0].id,
    numero_documento: numero,
    dv,
    razon_social: razonSocial,
    nombres,
    apellidos,
    nombre_comercial: mayusculas(b.nombre_comercial, 'El nombre comercial'),
    direccion: mayusculas(b.direccion, 'La dirección', 200),
    municipio_id: municipioId,
    codigo_postal: codigoPostal,
    telefono: validarTelefono(b.telefono),
    correo_facturacion: validarCorreo(b.correo_facturacion, { obligatorio: false }),
    responsabilidades_fiscales: responsabilidades,
    regimen,
    ...roles,
  };
}

/** Columnas de `sst.terceros` que escribe el formulario, en el orden de los parámetros. */
export const CAMPOS_TERCERO = [
  'tipo_persona', 'tipo_documento_id', 'numero_documento', 'dv',
  'razon_social', 'nombres', 'apellidos', 'nombre_comercial',
  'direccion', 'municipio_id', 'codigo_postal', 'telefono', 'correo_facturacion',
  'responsabilidades_fiscales', 'regimen',
  'es_cliente', 'es_proveedor', 'es_empleado', 'es_arl', 'es_acreedor',
];

/** ¿Ya hay OTRO tercero con ese documento? Devuelve su nombre, o null. */
export async function documentoOcupado(client, tipoDocumentoId, numero, excluirId = null) {
  const r = await client.query(
    `SELECT COALESCE(razon_social, btrim(concat_ws(' ', nombres, apellidos))) AS nombre
       FROM sst.terceros
      WHERE tipo_documento_id = $1 AND numero_documento = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [tipoDocumentoId, numero, excluirId],
  );
  return r.rows[0]?.nombre ?? null;
}
