import XLSX from 'xlsx';
import { pool, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/httpError.js';

/**
 * B0-01 (CNT-01) · Plan de cuentas.
 *
 * El árbol se arma por el CÓDIGO: clase (1 dígito) → grupo (2) → cuenta (4) →
 * subcuenta (6) → auxiliar (8) → sub-auxiliar (10). Siigo numera así
 * (13050501, 2510100101) y la contadora lo lee así, de modo que el padre de una
 * cuenta es siempre la del nivel anterior con el mismo prefijo: no se elige, se
 * deduce, y una cuenta no puede colgar de donde su código no dice.
 *
 * Solo las cuentas con `acepta_movimiento` reciben asientos (B1-01). Lo normal es
 * que sean las hojas del árbol, pero no se impone: Siigo tiene subcuentas de 6
 * dígitos con movimiento (511030 Honorarios de Gerencia).
 */

/** Longitudes de código válidas, de la clase a la sub-auxiliar. */
export const LONGITUDES = [1, 2, 4, 6, 8, 10];

/** Código del padre: el prefijo del nivel anterior (null para una clase). */
export function codigoPadre(codigo) {
  const i = LONGITUDES.indexOf(codigo.length);
  return i > 0 ? codigo.slice(0, LONGITUDES[i - 1]) : null;
}

/**
 * Naturaleza por defecto según la clase del PUC (Decreto 2650 de 1993): activos,
 * gastos y costos son débito; pasivo, patrimonio e ingresos, crédito; las cuentas
 * de orden, según sean deudoras (8) o acreedoras (9). Las "contra" más comunes van
 * al revés que su clase (devoluciones en ventas, depreciación y provisiones
 * acumuladas). Es solo el valor sugerido: la contadora lo corrige cuenta a cuenta.
 */
const CONTRA = [[/^4175/, 'DEBITO'], [/^(1592|1399|1499|1699|1799|1899)/, 'CREDITO']];

export function naturalezaSugerida(codigo) {
  const contra = CONTRA.find(([re]) => re.test(codigo));
  if (contra) return contra[1];
  return ['2', '3', '4', '9'].includes(codigo[0]) ? 'CREDITO' : 'DEBITO';
}

/**
 * Naturaleza de una cuenta nueva cuando no se indica: la de su padre (casi siempre
 * coincide) salvo que sea una cuenta "contra", que va al revés que su rama — la
 * 4175 cuelga de Ingresos (crédito) y es débito.
 */
export function naturalezaPorDefecto(codigo, naturalezaPadre = null) {
  const contra = CONTRA.find(([re]) => re.test(codigo));
  if (contra) return contra[1];
  return naturalezaPadre ?? naturalezaSugerida(codigo);
}

const SELECT = `
  c.id, c.codigo, c.nombre, c.naturaleza, c.nivel, c.padre_id, p.codigo AS padre_codigo,
  c.acepta_movimiento, c.exige_tercero, c.exige_centro_costo, c.es_cartera, c.es_banco,
  c.renglon_esf, c.renglon_er, c.activa, c.creado_en, c.actualizado_en,
  (SELECT count(*)::int FROM sst.cuentas_contables h WHERE h.padre_id = c.id) AS n_hijas`;
const FROM = `FROM sst.cuentas_contables c LEFT JOIN sst.cuentas_contables p ON p.id = c.padre_id`;

/**
 * El plan completo, ordenado por código (que es el orden del árbol). `q` busca por
 * código (prefijo) o nombre; con búsqueda se devuelven también los ancestros de lo
 * encontrado, para que el árbol no quede con ramas sueltas.
 */
export async function listarCuentas({ q = '', soloActivas = false, soloMovimiento = false } = {}, db = pool) {
  const filtros = [];
  const params = [];
  if (soloActivas) filtros.push('c.activa');
  if (soloMovimiento) filtros.push('c.acepta_movimiento');
  const texto = String(q ?? '').trim();
  if (texto) {
    params.push(`${texto}%`, `%${texto}%`);
    // Coincidencias + sus ancestros (todos los prefijos de sus códigos).
    filtros.push(`c.codigo IN (
      SELECT left(m.codigo, n) FROM sst.cuentas_contables m, unnest(ARRAY[1,2,4,6,8,10]) AS n
       WHERE (m.codigo LIKE $1 OR m.nombre ILIKE $2) AND n <= length(m.codigo))`);
  }
  const r = await db.query(
    `SELECT ${SELECT} ${FROM} ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''} ORDER BY c.codigo`,
    params,
  );
  return r.rows;
}

export async function obtenerCuenta(id, db = pool) {
  const r = await db.query(`SELECT ${SELECT} ${FROM} WHERE c.id = $1`, [id]);
  if (!r.rows[0]) throw notFound('Esa cuenta no existe.');
  return r.rows[0];
}

// ─── Validación ───────────────────────────────────────────────────────────────

function validarCodigo(v) {
  const codigo = String(v ?? '').trim();
  if (!/^[0-9]+$/.test(codigo)) throw badRequest('El código de la cuenta solo lleva dígitos.');
  if (!LONGITUDES.includes(codigo.length)) {
    throw badRequest(`El código debe tener ${LONGITUDES.join(', ')} dígitos (clase, grupo, cuenta, subcuenta, auxiliar); "${codigo}" tiene ${codigo.length}.`);
  }
  return codigo;
}

const validarNaturaleza = (v, codigo) => {
  if (v == null || v === '') return naturalezaSugerida(codigo);
  const n = String(v).trim().toUpperCase();
  // El PUC exportado suele traer "D"/"C"; la pantalla manda la palabra completa.
  if (n === 'D' || n === 'DEBITO' || n === 'DÉBITO') return 'DEBITO';
  if (n === 'C' || n === 'CREDITO' || n === 'CRÉDITO') return 'CREDITO';
  throw badRequest('La naturaleza debe ser DEBITO o CREDITO.');
};

const validarCartera = (v) => {
  if (v == null || v === '') return null;
  const c = String(v).toUpperCase();
  if (!['CXC', 'CXP'].includes(c)) throw badRequest('La cartera debe ser CXC (por cobrar), CXP (por pagar) o vacía.');
  return c;
};

const texto = (v) => (v == null ? null : String(v).trim() || null);
const bool = (v, def = false) => (v == null ? def : v === true || v === 'true' || v === 1 || v === '1');

// ─── Alta, edición e inactivación ────────────────────────────────────────────

/**
 * Crea una cuenta. Su padre (el nivel anterior del código) debe existir: el plan
 * se arma de arriba abajo, igual que en Siigo. Al colgarle una cuenta, el padre
 * deja de recibir movimiento: un saldo repartido entre la cuenta y sus hijas no
 * cuadraría con la suma de las hijas en los informes.
 */
export async function crearCuenta(b = {}, usuarioId = null) {
  return withTransaction(async (client) => {
    const codigo = validarCodigo(b.codigo);
    const nombre = texto(b.nombre);
    if (!nombre) throw badRequest('El nombre de la cuenta es obligatorio.');
    const dup = await client.query(`SELECT id FROM sst.cuentas_contables WHERE codigo = $1`, [codigo]);
    if (dup.rows[0]) throw conflict(`Ya existe la cuenta ${codigo}.`);

    const codPadre = codigoPadre(codigo);
    let padre = null;
    if (codPadre) {
      padre = (await client.query(
        `SELECT id, naturaleza, exige_tercero, exige_centro_costo, activa FROM sst.cuentas_contables WHERE codigo = $1 FOR UPDATE`,
        [codPadre],
      )).rows[0];
      if (!padre) throw badRequest(`Primero cree la cuenta ${codPadre}: es la que agrupa a ${codigo}.`);
      if (!padre.activa) throw badRequest(`La cuenta ${codPadre} está inactiva; actívela antes de crearle subcuentas.`);
    }

    const r = await client.query(
      `INSERT INTO sst.cuentas_contables
         (codigo, nombre, naturaleza, padre_id, acepta_movimiento, exige_tercero, exige_centro_costo,
          es_cartera, es_banco, renglon_esf, renglon_er, creado_por, actualizado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
      [codigo, nombre,
       // Una subcuenta hereda de su padre lo que no se diga: casi siempre es igual.
       b.naturaleza ? validarNaturaleza(b.naturaleza, codigo) : naturalezaPorDefecto(codigo, padre?.naturaleza),
       padre?.id ?? null,
       bool(b.acepta_movimiento, codigo.length >= 8),
       bool(b.exige_tercero, padre?.exige_tercero ?? false),
       bool(b.exige_centro_costo, padre?.exige_centro_costo ?? false),
       validarCartera(b.es_cartera), bool(b.es_banco), texto(b.renglon_esf), texto(b.renglon_er), usuarioId],
    );
    if (padre) {
      await client.query(
        `UPDATE sst.cuentas_contables SET acepta_movimiento = false, actualizado_por = $2 WHERE id = $1 AND acepta_movimiento`,
        [padre.id, usuarioId],
      );
    }
    return obtenerCuenta(r.rows[0].id, client);
  });
}

/**
 * Edita todo menos el código: cambiar el código de una cuenta la movería de rama
 * (y, desde B1-01, reescribiría lo contabilizado). Para "moverla" se crea la nueva
 * y se inactiva la vieja.
 */
export async function actualizarCuenta(id, b = {}, usuarioId = null) {
  return withTransaction(async (client) => {
    const actual = (await client.query(
      `SELECT c.*, (SELECT count(*)::int FROM sst.cuentas_contables h WHERE h.padre_id = c.id) AS n_hijas
         FROM sst.cuentas_contables c WHERE c.id = $1 FOR UPDATE`,
      [id],
    )).rows[0];
    if (!actual) throw notFound('Esa cuenta no existe.');
    if (b.codigo != null && String(b.codigo).trim() !== actual.codigo) {
      throw badRequest('El código de una cuenta no se cambia. Cree la cuenta nueva e inactive esta.');
    }
    const nombre = b.nombre !== undefined ? texto(b.nombre) : actual.nombre;
    if (!nombre) throw badRequest('El nombre de la cuenta es obligatorio.');
    const aceptaMovimiento = bool(b.acepta_movimiento, actual.acepta_movimiento);
    if (aceptaMovimiento && actual.n_hijas > 0) {
      throw badRequest(`La cuenta ${actual.codigo} tiene subcuentas: los movimientos van en ellas, no en la que las agrupa.`);
    }

    await client.query(
      `UPDATE sst.cuentas_contables
          SET nombre=$2, naturaleza=$3, acepta_movimiento=$4, exige_tercero=$5, exige_centro_costo=$6,
              es_cartera=$7, es_banco=$8, renglon_esf=$9, renglon_er=$10, actualizado_por=$11
        WHERE id = $1`,
      [id, nombre,
       b.naturaleza !== undefined ? validarNaturaleza(b.naturaleza, actual.codigo) : actual.naturaleza,
       aceptaMovimiento,
       bool(b.exige_tercero, actual.exige_tercero), bool(b.exige_centro_costo, actual.exige_centro_costo),
       b.es_cartera !== undefined ? validarCartera(b.es_cartera) : actual.es_cartera,
       bool(b.es_banco, actual.es_banco),
       b.renglon_esf !== undefined ? texto(b.renglon_esf) : actual.renglon_esf,
       b.renglon_er !== undefined ? texto(b.renglon_er) : actual.renglon_er,
       usuarioId],
    );
    return obtenerCuenta(id, client);
  });
}

/**
 * Una cuenta no se borra nunca: se inactiva (deja de ofrecerse para asentar, pero
 * lo ya contabilizado sigue apuntando a ella). No se inactiva una cuenta con
 * subcuentas activas, ni se reactiva una cuyo padre está inactivo: el árbol no
 * puede quedar con ramas activas colgando de una inactiva.
 */
export async function cambiarActiva(id, activa, usuarioId = null) {
  return withTransaction(async (client) => {
    const c = (await client.query(`SELECT id, codigo, padre_id FROM sst.cuentas_contables WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!c) throw notFound('Esa cuenta no existe.');
    if (!activa) {
      const hijas = await client.query(`SELECT codigo FROM sst.cuentas_contables WHERE padre_id = $1 AND activa ORDER BY codigo LIMIT 5`, [id]);
      if (hijas.rows.length) {
        throw badRequest(`Primero inactive sus subcuentas activas (${hijas.rows.map((h) => h.codigo).join(', ')}${hijas.rows.length === 5 ? '…' : ''}).`);
      }
    } else if (c.padre_id) {
      const p = (await client.query(`SELECT codigo, activa FROM sst.cuentas_contables WHERE id = $1`, [c.padre_id])).rows[0];
      if (!p.activa) throw badRequest(`Primero active la cuenta ${p.codigo}, que agrupa a esta.`);
    }
    await client.query(`UPDATE sst.cuentas_contables SET activa = $2, actualizado_por = $3 WHERE id = $1`, [id, activa, usuarioId]);
    return obtenerCuenta(id, client);
  });
}

// ─── Importación desde Excel ────────────────────────────────────────────────

const normalizar = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Lee un Excel de cuentas y devuelve `[{ codigo, nombre, naturaleza }]` sin
 * repetidos. Acepta el PUC exportado de Siigo (columnas "Código"/"Nombre" y,
 * si la trae, "Naturaleza") y también el auxiliar por cuenta ("Código contable"/
 * "Cuenta contable"), que repite la cuenta en cada movimiento. La fila de
 * encabezados se busca en las primeras 30: los informes de Siigo traen antes el
 * nombre de la empresa, el NIT y el rango de fechas.
 */
export function leerExcelCuentas(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw badRequest('No se pudo leer el archivo. Envíe un Excel (.xlsx o .xls).');
  }
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null, raw: false });

  let cab = -1;
  let colCodigo = -1;
  let colNombre = -1;
  let colNaturaleza = -1;
  for (let i = 0; i < Math.min(filas.length, 30) && cab < 0; i++) {
    const celdas = (filas[i] || []).map(normalizar);
    const c = celdas.findIndex((x) => ['codigo', 'codigo contable', 'codigo cuenta', 'cuenta'].includes(x));
    if (c < 0) continue;
    const n = celdas.findIndex((x, j) => j !== c && ['nombre', 'cuenta contable', 'nombre cuenta', 'descripcion', 'nombre de la cuenta'].includes(x));
    if (n < 0) continue;
    cab = i;
    colCodigo = c;
    colNombre = n;
    colNaturaleza = celdas.findIndex((x) => x === 'naturaleza');
  }
  if (cab < 0) {
    throw badRequest('No se encontró la fila de encabezados: el Excel debe tener una columna "Código" y otra "Nombre" (o "Código contable" y "Cuenta contable").');
  }

  const porCodigo = new Map();
  for (const f of filas.slice(cab + 1)) {
    const codigo = String(f?.[colCodigo] ?? '').trim();
    if (!/^[0-9]+$/.test(codigo)) continue; // totales, subtítulos y filas vacías
    const nombre = String(f?.[colNombre] ?? '').trim();
    if (!porCodigo.has(codigo)) {
      porCodigo.set(codigo, { codigo, nombre, naturaleza: colNaturaleza >= 0 ? f?.[colNaturaleza] ?? null : null });
    }
  }
  if (!porCodigo.size) throw badRequest('El Excel no trae ninguna cuenta con código numérico.');
  return [...porCodigo.values()];
}

/**
 * Carga una lista de cuentas de una sola vez (el PUC de Siigo, Q-22).
 *
 * - Lo que ya existe NO se sobreescribe salvo el nombre y la naturaleza cuando el
 *   archivo los trae: los indicadores (tercero, cartera, banco…) son decisiones de
 *   la contadora hechas en la pantalla, y una reimportación no debe borrarlas.
 * - Los niveles intermedios que falten se crean con un nombre provisional
 *   `(por confirmar)`; `nombresPadres` permite dárselos (lo usa la semilla).
 * - Al final, las cuentas sin subcuentas quedan con movimiento y las que tienen
 *   subcuentas, sin él.
 * - `simular` corre todo y deshace: es la vista previa de la pantalla.
 */
export async function importarCuentas(lista, { usuarioId = null, simular = false, nombresPadres = {} } = {}) {
  const errores = [];
  const validas = [];
  for (const [i, raw] of lista.entries()) {
    const fila = i + 1;
    try {
      const codigo = validarCodigo(raw.codigo);
      const nombre = texto(raw.nombre);
      if (!nombre) throw badRequest('sin nombre');
      validas.push({ codigo, nombre, naturaleza: raw.naturaleza ? validarNaturaleza(raw.naturaleza, codigo) : null });
    } catch (e) {
      errores.push({ fila, codigo: raw.codigo ?? null, error: e.message });
    }
  }

  // Todos los códigos que deben existir: los del archivo y sus ancestros.
  const aCrear = new Map(validas.map((v) => [v.codigo, v]));
  for (const v of validas) {
    for (let p = codigoPadre(v.codigo); p; p = codigoPadre(p)) {
      if (!aCrear.has(p)) aCrear.set(p, { codigo: p, nombre: null, naturaleza: null, provisional: true });
    }
  }
  const ordenados = [...aCrear.values()].sort((a, b) => a.codigo.length - b.codigo.length || a.codigo.localeCompare(b.codigo));

  const client = await pool.connect();
  const resumen = { creadas: 0, actualizadas: 0, sin_cambios: 0, padres_provisionales: [], errores, simulado: simular };
  try {
    await client.query('BEGIN');
    const existentes = new Map((await client.query(
      `SELECT id, codigo, nombre, naturaleza FROM sst.cuentas_contables WHERE codigo = ANY($1)`,
      [ordenados.map((c) => c.codigo)],
    )).rows.map((c) => [c.codigo, c]));

    for (const c of ordenados) {
      const ya = existentes.get(c.codigo);
      if (ya) {
        if (c.provisional) continue;
        const naturaleza = c.naturaleza ?? ya.naturaleza;
        if (ya.nombre === c.nombre && ya.naturaleza === naturaleza) { resumen.sin_cambios++; continue; }
        await client.query(
          `UPDATE sst.cuentas_contables SET nombre = $2, naturaleza = $3, actualizado_por = $4 WHERE id = $1`,
          [ya.id, c.nombre, naturaleza, usuarioId],
        );
        resumen.actualizadas++;
        continue;
      }
      const codPadre = codigoPadre(c.codigo);
      const padre = codPadre ? existentes.get(codPadre) : null;
      const nombre = c.nombre ?? nombresPadres[c.codigo] ?? `Cuenta ${c.codigo} (por confirmar)`;
      if (c.provisional && !nombresPadres[c.codigo]) resumen.padres_provisionales.push(c.codigo);
      const naturaleza = c.naturaleza ?? naturalezaPorDefecto(c.codigo, padre?.naturaleza);
      const r = await client.query(
        `INSERT INTO sst.cuentas_contables (codigo, nombre, naturaleza, padre_id, creado_por, actualizado_por)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id, codigo, nombre, naturaleza`,
        [c.codigo, nombre, naturaleza, padre?.id ?? null, usuarioId],
      );
      existentes.set(c.codigo, r.rows[0]);
      resumen.creadas++;
    }

    // Hojas con movimiento; las que agrupan, sin él. Se recalcula sobre TODO el
    // plan: una cuenta que era hoja pudo recibir hijas en esta importación.
    await client.query(
      `UPDATE sst.cuentas_contables c
          SET acepta_movimiento = NOT EXISTS (SELECT 1 FROM sst.cuentas_contables h WHERE h.padre_id = c.id)
        WHERE acepta_movimiento IS DISTINCT FROM NOT EXISTS (SELECT 1 FROM sst.cuentas_contables h WHERE h.padre_id = c.id)
          AND (c.codigo = ANY($1) OR EXISTS (SELECT 1 FROM sst.cuentas_contables h WHERE h.padre_id = c.id AND h.codigo = ANY($1)))`,
      [ordenados.map((c) => c.codigo)],
    );
    resumen.total_plan = (await client.query(`SELECT count(*)::int AS n FROM sst.cuentas_contables`)).rows[0].n;
    await client.query(simular ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return resumen;
}
