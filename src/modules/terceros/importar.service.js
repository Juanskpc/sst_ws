import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { pool } from '../../config/db.js';
import { badRequest } from '../../utils/httpError.js';
import { CAMPOS_TERCERO, validarTercero } from './terceros.service.js';

/**
 * 7-oct-2026 (reunión con JD&D) · Cargue de terceros por Excel.
 *
 * Acepta dos formatos, que se reconocen solos por sus encabezados:
 *   · la PLANTILLA de ORBITA (`plantillaTerceros`), con todo lo que guarda la ficha;
 *   · la exportación «Búsqueda de terceros» de Siigo, tal como sale (encabezados en la
 *     fila 7, sin correo, sin departamento y con el nombre en una sola celda). Es lo
 *     que JD&D tiene hoy: 378 terceros que no hay que volver a digitar.
 *
 * Primero se REVISA (no guarda nada) y se muestra fila por fila qué entra, qué ya
 * existe y qué tiene un error. Al cargar entran solo las filas válidas: una fila mala
 * no detiene a las demás, pero queda dicha con su motivo. Un tercero que ya existe
 * (mismo tipo y número de documento) NO se toca: el cargue nunca pisa una ficha.
 *
 * Cada fila pasa por `validarTercero`, así que valida igual que el formulario.
 */

const COLUMNAS = [
  { clave: 'tipo_persona', titulo: 'Tipo de persona', ancho: 16, ayuda: 'NATURAL o JURIDICA (vacío: jurídica si es NIT, natural si no)' },
  { clave: 'tipo_documento', titulo: 'Tipo de identificación', ancho: 24, ayuda: 'NIT, Cédula de ciudadanía, Cédula de extranjería, Pasaporte…' },
  { clave: 'numero', titulo: 'Identificación', ancho: 16, ayuda: 'Sin puntos ni dígito de verificación' },
  { clave: 'dv', titulo: 'Dígito de verificación', ancho: 12, ayuda: 'Opcional: ORBITA lo calcula' },
  { clave: 'razon_social', titulo: 'Razón social', ancho: 34, ayuda: 'Personas jurídicas' },
  { clave: 'nombres', titulo: 'Nombres', ancho: 22, ayuda: 'Personas naturales' },
  { clave: 'apellidos', titulo: 'Apellidos', ancho: 22, ayuda: 'Personas naturales' },
  { clave: 'nombre_comercial', titulo: 'Nombre comercial', ancho: 24, ayuda: 'Opcional' },
  { clave: 'direccion', titulo: 'Dirección', ancho: 30, ayuda: 'Necesaria para facturarle' },
  { clave: 'departamento', titulo: 'Departamento', ancho: 18, ayuda: 'Opcional: desempata ciudades con el mismo nombre' },
  { clave: 'ciudad', titulo: 'Ciudad', ancho: 18, ayuda: 'Nombre del municipio; trae el código postal' },
  { clave: 'telefono', titulo: 'Teléfono', ancho: 16, ayuda: 'Opcional' },
  { clave: 'correo', titulo: 'Correo de facturación', ancho: 28, ayuda: 'A donde llega la factura' },
  { clave: 'regimen', titulo: 'Régimen de IVA', ancho: 20, ayuda: 'Responsable de IVA o No responsable' },
  { clave: 'cliente', titulo: 'Cliente', ancho: 9, ayuda: 'SI o NO' },
  { clave: 'proveedor', titulo: 'Proveedor', ancho: 10, ayuda: 'SI o NO' },
  { clave: 'empleado', titulo: 'Empleado', ancho: 10, ayuda: 'SI o NO' },
];

/** Encabezados de la exportación de Siigo → columna de ORBITA. */
const SIIGO = {
  'nombre tercero': 'nombre', 'tipo de identificacion': 'tipo_documento', identificacion: 'numero',
  'digito verificacion': 'dv', 'tipo de regimen iva': 'regimen', direccion: 'direccion', ciudad: 'ciudad',
  'telefono.': 'telefono', telefono: 'telefono', estado: 'estado',
};

const normalizar = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const si = (v) => /^(si|s|x|1|true|verdadero)$/i.test(normalizar(v));

/** Plantilla en blanco: encabezados, una fila de ayuda y dos ejemplos. */
export async function plantillaTerceros() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Terceros');
  ws.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }));
  ws.getRow(1).font = { bold: true };
  const ayuda = ws.addRow(Object.fromEntries(COLUMNAS.map((c) => [c.clave, c.ayuda])));
  ayuda.font = { italic: true, color: { argb: 'FF7F8C8D' } };
  ayuda.alignment = { wrapText: true, vertical: 'top' };
  ws.addRow({ tipo_persona: 'JURIDICA', tipo_documento: 'NIT', numero: '900123456', razon_social: 'EMPRESA DE EJEMPLO SAS',
    direccion: 'CL 18 25 40', departamento: 'Nariño', ciudad: 'Pasto', telefono: '6027300000', correo: 'facturacion@ejemplo.com',
    regimen: 'Responsable de IVA', cliente: 'SI', proveedor: 'NO', empleado: 'NO' });
  ws.addRow({ tipo_persona: 'NATURAL', tipo_documento: 'Cédula de ciudadanía', numero: '1085000000', nombres: 'MARIA FERNANDA',
    apellidos: 'ROSERO LOPEZ', direccion: 'CR 26 19 07', departamento: 'Nariño', ciudad: 'Pasto', telefono: '3140000000',
    correo: 'maria@ejemplo.com', regimen: 'No responsable', cliente: 'NO', proveedor: 'SI', empleado: 'NO' });
  return wb.xlsx.writeBuffer();
}

/**
 * Lee el Excel. Busca la fila de encabezados en las primeras 15 (la de Siigo trae
 * seis filas de título antes) y devuelve las filas ya con nombres de columna comunes.
 */
function leerFilas(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw badRequest('No se pudo leer el archivo. Use la plantilla o la exportación de terceros en Excel (.xlsx).');
  }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: false });
  const titulosPlantilla = new Map(COLUMNAS.map((c) => [normalizar(c.titulo), c.clave]));
  let cab = -1;
  let mapa = null;
  let formato = null;
  for (let i = 0; i < Math.min(filas.length, 15); i++) {
    const celdas = (filas[i] ?? []).map(normalizar);
    if (!celdas.includes('identificacion')) continue;
    const esSiigo = celdas.includes('nombre tercero');
    mapa = celdas.map((c) => (esSiigo ? SIIGO[c] : titulosPlantilla.get(c)) ?? null);
    cab = i;
    formato = esSiigo ? 'SIIGO' : 'PLANTILLA';
    break;
  }
  if (cab < 0) throw badRequest('No se encontró la fila de encabezados (falta la columna «Identificación»). Use la plantilla.');
  if (!mapa.includes('tipo_documento')) throw badRequest('Al Excel le falta la columna «Tipo de identificación».');

  const salida = [];
  for (let i = cab + 1; i < filas.length; i++) {
    const f = filas[i] ?? [];
    const r = { fila: i + 1 };
    mapa.forEach((clave, j) => { if (clave) r[clave] = f[j] == null ? '' : String(f[j]).trim(); });
    // Sin identificación no es un tercero: fila vacía. El pie «Procesado en: <fecha>» de
    // Siigo tampoco, aunque traiga texto en todas las columnas (celda combinada).
    if (!r.numero) continue;
    if (f.some((c) => /^procesado en\b/i.test(String(c ?? '').trim()))) continue;
    if (/^sin puntos/i.test(r.numero ?? '')) continue; // la fila de ayuda de la plantilla
    salida.push(r);
  }
  if (!salida.length) throw badRequest('El Excel no trae ningún tercero.');
  return { formato, filas: salida };
}

/** Partículas que van pegadas a la palabra siguiente: «DE LA CRUZ», «DEL CARMEN». */
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'da', 'van']);

/**
 * Nombre completo en una celda → nombres y apellidos. Se lee «NOMBRES APELLIDOS», que es
 * como viene la gran mayoría de personas en la exportación de terceros de JD&D (9-oct-2026:
 * de 157 cédulas, solo unas 5 venían con el apellido primero). Antes se suponía lo
 * contrario y casi todas quedaban invertidas. Las partículas se juntan con la palabra que
 * sigue («KAREN ALEJANDRA DE LA CRUZ RAMIREZ» → KAREN ALEJANDRA | DE LA CRUZ RAMIREZ).
 * 4 o más partes: dos nombres y el resto apellidos; 3: un nombre y dos apellidos.
 * Es una propuesta: la revisión del cargue la muestra y se corrige en Terceros.
 */
export function partirNombre(completo) {
  const palabras = String(completo).trim().split(/\s+/).filter(Boolean);
  const partes = [];
  let pendiente = [];
  for (const w of palabras) {
    pendiente.push(w);
    if (!PARTICULAS.has(w.toLowerCase())) { partes.push(pendiente.join(' ')); pendiente = []; }
  }
  if (pendiente.length) partes.push(pendiente.join(' '));
  if (partes.length === 1) return { nombres: partes[0], apellidos: '' };
  const nNombres = partes.length >= 4 ? 2 : 1;
  return { nombres: partes.slice(0, nNombres).join(' '), apellidos: partes.slice(nNombres).join(' ') };
}

/** Catálogos para resolver textos del Excel, una sola vez por cargue. */
async function catalogos(client) {
  const tipos = (await client.query(`SELECT id, codigo_dian, nombre FROM sst.tipos_documento_identidad WHERE activo`)).rows;
  const municipios = (await client.query(
    `SELECT m.id, m.nombre, m.codigo_dian, d.nombre AS departamento FROM sst.municipios m JOIN sst.departamentos d ON d.id = m.departamento_id WHERE m.activo`,
  )).rows.map((m) => ({ ...m, n: normalizar(m.nombre).replace(/,? ?d\.? ?c\.?$/, ''), dep: normalizar(m.departamento) }));
  const existentes = new Set((await client.query(`SELECT tipo_documento_id, numero_documento FROM sst.terceros`)).rows
    .map((t) => `${t.tipo_documento_id}|${t.numero_documento}`));
  return { tipos, municipios, existentes };
}

function tipoDocumento(texto, tipos) {
  const t = normalizar(texto);
  if (!t) return null;
  return tipos.find((x) => x.codigo_dian === t || normalizar(x.nombre) === t)
    ?? tipos.find((x) => (t.includes('nit') && x.codigo_dian === '31')
      || (t.includes('ciudadania') && x.codigo_dian === '13')
      || (t.includes('extranjeria') && t.includes('cedula') && x.codigo_dian === '22')
      || (t.includes('pasaporte') && x.codigo_dian === '41')
      || (t.includes('tarjeta de identidad') && x.codigo_dian === '12'))
    ?? null;
}

/** Municipio por nombre; con `departamento` se desempata. Devuelve { id } o { aviso }. */
function municipio(ciudad, departamento, municipios) {
  const c = normalizar(ciudad).replace(/,? ?d\.? ?c\.?$/, '');
  if (!c) return { id: null };
  const dep = normalizar(departamento);
  let candidatos = municipios.filter((m) => m.n === c);
  if (!candidatos.length) candidatos = municipios.filter((m) => m.n.endsWith(` ${c}`) || m.n.startsWith(`${c} `));
  if (dep) candidatos = candidatos.filter((m) => m.dep === dep).length ? candidatos.filter((m) => m.dep === dep) : candidatos;
  if (candidatos.length === 1) return { id: candidatos[0].id, nombre: `${candidatos[0].nombre} (${candidatos[0].departamento})` };
  if (!candidatos.length) return { id: null, aviso: `no se reconoció la ciudad «${ciudad}»: queda sin municipio` };
  // Varias con el mismo nombre y sin departamento: gana la capital de departamento (código …001).
  const capital = candidatos.filter((m) => m.codigo_dian.endsWith('001'));
  if (capital.length === 1) return { id: capital[0].id, nombre: `${capital[0].nombre} (${capital[0].departamento})` };
  return { id: null, aviso: `hay ${candidatos.length} municipios llamados «${ciudad}»: indique el departamento; queda sin municipio` };
}

/** Convierte una fila del Excel en el cuerpo que espera `validarTercero`, con sus avisos. */
function aCuerpo(r, cat, rolPorDefecto) {
  const avisos = [];
  const td = tipoDocumento(r.tipo_documento, cat.tipos);
  if (!td) throw badRequest(`El tipo de identificación «${r.tipo_documento || '(vacío)'}» no se reconoce. Use NIT, Cédula de ciudadanía, Cédula de extranjería, Pasaporte o Tarjeta de identidad.`);
  const esNit = td.codigo_dian === '31';
  const tipoPersona = /^(natural|juridica)$/.test(normalizar(r.tipo_persona)) ? normalizar(r.tipo_persona).toUpperCase() : (esNit ? 'JURIDICA' : 'NATURAL');

  let razon = r.razon_social || '';
  let nombres = r.nombres || '';
  let apellidos = r.apellidos || '';
  if (r.nombre) { // Siigo: el nombre viene en una sola celda
    if (tipoPersona === 'JURIDICA') razon = r.nombre;
    else ({ nombres, apellidos } = partirNombre(r.nombre));
  }

  const m = municipio(r.ciudad, r.departamento, cat.municipios);
  if (m.aviso) avisos.push(m.aviso);

  // Los teléfonos de Siigo vienen como «602-3146021948-» o «--»: se dejan los dígitos
  // y, si no forman un teléfono, se guarda sin él en vez de rechazar la fila.
  let telefono = String(r.telefono ?? '').replace(/\D/g, '');
  if (telefono.length > 10 && telefono.startsWith('60')) telefono = telefono.slice(-10);
  if (telefono && (telefono.length < 7 || telefono.length > 15 || /^0+$/.test(telefono))) {
    avisos.push(`teléfono «${r.telefono}» no válido: queda sin teléfono`);
    telefono = '';
  }

  // Lo que falta para usarlo: no impide cargarlo, pero se dice ya, fila por fila.
  if (!r.direccion) avisos.push('sin dirección: complétela en Terceros antes de facturarle o hacerle un documento soporte');
  if (!String(r.ciudad ?? '').trim()) avisos.push('sin ciudad: queda sin municipio; complételo en Terceros');

  const traeRoles = ['cliente', 'proveedor', 'empleado'].some((k) => r[k] !== undefined && r[k] !== '');
  const roles = traeRoles
    ? { es_cliente: si(r.cliente), es_proveedor: si(r.proveedor), es_empleado: si(r.empleado) }
    : {
      es_cliente: rolPorDefecto === 'CLIENTE' || rolPorDefecto === 'AMBOS' || (rolPorDefecto === 'AUTO' && esNit),
      es_proveedor: rolPorDefecto === 'PROVEEDOR' || rolPorDefecto === 'AMBOS' || (rolPorDefecto === 'AUTO' && !esNit),
      es_empleado: false,
    };

  if (roles.es_cliente && !r.correo) avisos.push('sin correo de facturación: hay que completarlo en Terceros antes de facturarle');

  return {
    cuerpo: {
      tipo_persona: tipoPersona,
      tipo_documento_id: td.id,
      numero_documento: esNit && r.dv !== undefined && r.dv !== '' ? `${String(r.numero).replace(/\D/g, '')}-${String(r.dv).replace(/\D/g, '')}` : r.numero,
      razon_social: razon, nombres, apellidos,
      nombre_comercial: r.nombre_comercial || '',
      direccion: r.direccion || '',
      municipio_id: m.id,
      telefono,
      correo_facturacion: r.correo || '',
      regimen: /no responsable/.test(normalizar(r.regimen)) ? 'NO_RESPONSABLE' : 'RESPONSABLE_IVA',
      ...roles, es_arl: false, es_acreedor: false,
    },
    avisos,
    municipio: m.nombre ?? null,
    tipo: td,
  };
}

/**
 * Revisa (`simular`) o carga. `rolPorDefecto` aplica a las filas que no traen roles
 * (la exportación de Siigo no los trae): AUTO = cliente si tiene NIT, proveedor si no.
 */
export async function importarTerceros(buffer, { usuarioId = null, simular = true, rolPorDefecto = 'AUTO', client: externo = null } = {}) {
  const rol = ['AUTO', 'CLIENTE', 'PROVEEDOR', 'AMBOS'].includes(String(rolPorDefecto).toUpperCase()) ? String(rolPorDefecto).toUpperCase() : 'AUTO';
  const { formato, filas } = leerFilas(buffer);
  // `client` (9-oct-2026): correr dentro de la transacción de quien llama (el script de
  // carga de producción, que confirma o deshace todo junto). Entonces aquí no se abre
  // ni se cierra nada y `simular` no aplica: lo decide quien llama.
  const client = externo ?? await pool.connect();
  const resultados = [];
  try {
    if (!externo) await client.query('BEGIN');
    const cat = await catalogos(client);
    const vistos = new Map();
    let n = 0;
    for (const r of filas) {
      const res = { fila: r.fila, nombre: r.nombre || r.razon_social || [r.nombres, r.apellidos].filter(Boolean).join(' ') || null,
        documento: r.numero || null, municipio: null, estado: 'NUEVO', avisos: [], error: null };
      const sp = `t_${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        if (r.estado && /inactivo/i.test(r.estado)) res.avisos.push('en el archivo figura inactivo: se carga como inactivo');
        const { cuerpo, avisos, municipio: mun, tipo } = aCuerpo(r, cat, rol);
        res.avisos.push(...avisos);
        res.municipio = mun;
        const campos = await validarTercero(cuerpo, client);
        res.documento = campos.dv != null ? `${campos.numero_documento}-${campos.dv}` : campos.numero_documento;
        res.nombre = campos.razon_social ?? [campos.nombres, campos.apellidos].filter(Boolean).join(' ');
        if (!campos.razon_social) { res.nombres = campos.nombres; res.apellidos = campos.apellidos; }
        const clave = `${tipo.id}|${campos.numero_documento}`;
        if (vistos.has(clave)) {
          const primera = vistos.get(clave);
          throw badRequest(`El documento ${res.documento} ya está en la fila ${primera.fila} (${primera.nombre}). ORBITA guarda un solo tercero `
            + 'por documento: se carga la primera y esta se omite. Si era una sucursal, sus datos se agregan a mano en esa ficha.');
        }
        vistos.set(clave, { fila: r.fila, nombre: res.nombre });
        if (cat.existentes.has(clave)) {
          res.estado = 'YA_EXISTE';
        } else {
          const ins = await client.query(
            `INSERT INTO sst.terceros (${CAMPOS_TERCERO.join(', ')}, activo, creado_por, actualizado_por)
             VALUES (${CAMPOS_TERCERO.map((_, i) => `$${i + 1}`).join(', ')}, $${CAMPOS_TERCERO.length + 1}, $${CAMPOS_TERCERO.length + 2}, $${CAMPOS_TERCERO.length + 2})
             RETURNING id`,
            [...CAMPOS_TERCERO.map((c) => campos[c]), !(r.estado && /inactivo/i.test(r.estado)), usuarioId],
          );
          res.id = ins.rows[0].id;
        }
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        res.estado = 'ERROR';
        // Los errores de la base no son frases para la persona: se traducen los conocidos.
        res.error = e.statusCode ? e.message
          : e.code === '23505' ? 'Ya existe un tercero con ese documento.'
            : `No se pudo guardar la fila (${e.message}).`;
      }
      resultados.push(res);
    }
    if (!externo) await client.query(simular ? 'ROLLBACK' : 'COMMIT');
    const cuenta = (e) => resultados.filter((x) => x.estado === e).length;
    return {
      formato, simulado: simular, filas: filas.length,
      nuevos: cuenta('NUEVO'), ya_existen: cuenta('YA_EXISTE'), errores: cuenta('ERROR'),
      con_avisos: resultados.filter((x) => x.estado !== 'ERROR' && x.avisos.length).length,
      cargados: simular ? 0 : cuenta('NUEVO'),
      resultados,
    };
  } catch (e) {
    if (!externo) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (!externo) client.release();
  }
}
