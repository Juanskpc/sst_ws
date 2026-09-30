// Verifica B2-01 contra jdd_dev DENTRO de una transacción con ROLLBACK: reproduce
// tres documentos reales de septiembre (FV-1-809 AXA con descuento, FV-1-807 a un
// privado con IVA, NC-1-87 de Colmena) y compara su asiento CUENTA A CUENTA con el
// que hizo Siigo (auxiliar de septiembre, §3.5 del plan). Las cifras esperadas se
// copiaron del auxiliar: si esto pasa, Orbita contabiliza igual que Siigo.
// Uso: node --import tsx scripts/verificar-contabilizacion.mjs   (requiere el túnel)
import { pool } from '../src/config/db.js';
import { construirAsiento, contabilizarEn } from '../src/modules/contabilidad/contabilizacion.service.js';
import { sembrarReglasSiigo } from '../src/modules/contabilidad/reglas.service.js';

let fallos = 0;
const igual = (obtenido, esperado, texto) => {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (!ok) fallos++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${texto}${ok ? '' : `\n     obtenido ${JSON.stringify(obtenido)}\n     esperado ${JSON.stringify(esperado)}`}`);
};

// Lo que dice el auxiliar de Siigo (sin las líneas en cero de 14980101).
const SIIGO = {
  'FV-1-809': [
    ['13050501', 'D', '3644728.43'], ['13551509', 'D', '450472.05'], ['53053501', 'D', '83575.52'],
    ['13551816', 'D', '45047.21'], ['23657502', 'C', '45047.21'],
    ['41800101', 'C', '3472504.00'], ['41800101', 'C', '353136.00'], ['41800101', 'C', '353136.00'],
  ],
  'FV-1-807': [
    ['13050501', 'D', '2075820.01'], ['13551816', 'D', '19188.25'], ['23657502', 'C', '19188.25'],
    ['41800101', 'C', '1744386.56'], ['24080601', 'C', '331433.45'],
  ],
  'NC-1-87': [
    ['13050501', 'C', '1096480.00'], ['13551510', 'C', '135520.00'],
    ['13551816', 'C', '13552.00'], ['23657502', 'D', '13552.00'],
    ['41750502', 'D', '1120000.00'], ['41750502', 'D', '112000.00'],
  ],
};
const ordenar = (ls) => [...ls].sort((a, b) => (a[0] + a[1] + a[2]).localeCompare(b[0] + b[1] + b[2]));

const cuentaResiduos = async () => (await pool.query(`SELECT (SELECT count(*) FROM sst.comprobantes)::int + (SELECT count(*) FROM sst.reglas_contables)::int
                                          + (SELECT count(*) FROM sst.documentos_electronicos WHERE reference_code LIKE 'ORB-ZZ-%')::int AS n`)).rows[0].n;
const antes = await cuentaResiduos();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const sem = await sembrarReglasSiigo(null, client);
  // Si ya estaban cargadas (jdd_dev), no se crea ninguna: lo que importa es que no falte cuenta.
  const reglas = (await client.query(`SELECT count(DISTINCT concepto)::int AS n FROM sst.reglas_contables WHERE producto_id IS NULL AND tercero_id IS NULL`)).rows[0].n;
  igual([reglas, sem.sin_cuenta], [14, []], 'las 14 reglas generales de Siigo quedan cargadas con cuentas del plan');

  const tercero = async (nombre) => (await client.query(`SELECT id FROM sst.terceros WHERE razon_social = $1`, [nombre])).rows[0].id;
  const axa = await tercero('AXA COLPATRIA SEGUROS DE VIDA SA');
  const sandona = await tercero('TRANSPORTE DE SANDONA SA');
  const colmena = await tercero('COLMENA SEGUROS RIESGOS LABORALES');
  const ret = async (codigo) => (await client.query(`SELECT id FROM sst.retenciones WHERE codigo = $1`, [codigo])).rows[0].id;
  const rfHon = await ret('RF-HON');
  const auto11 = await ret('AUTO-1.1');

  let n = 0;
  /** Documento VALIDADO con sus ítems y tributos, tal como lo deja A1-05. */
  const documento = async ({ tipo, tercero: t, numero, totales, items, tributos }) => {
    const d = (await client.query(
      `INSERT INTO sst.documentos_electronicos (tipo, reference_code, estado, tercero_id, prefijo, numero, fecha_emision,
                                                total_bruto, total_descuento, subtotal, total_iva, total_retenciones, total_a_pagar)
       VALUES ($1, $2, 'VALIDADO', $3, 'ZZ', $4, '2026-09-10', $5, $6, $7, $8, $9, $10) RETURNING id`,
      [tipo, `ORB-ZZ-${++n}`, t, numero, totales.bruto, totales.descuento, totales.subtotal, totales.iva, totales.retenciones, totales.total],
    )).rows[0].id;
    const ids = [];
    for (const [i, it] of items.entries()) {
      ids.push((await client.query(
        `INSERT INTO sst.documento_items (documento_id, descripcion, cantidad, valor_unitario, descuento, base, total_linea, orden)
         VALUES ($1, $2, 1, $3, $4, $5, $5, $6) RETURNING id`,
        [d, `Ítem ${i + 1}`, it.bruto, it.descuento ?? 0, it.base ?? it.bruto, i],
      )).rows[0].id);
    }
    for (const tr of tributos) {
      await client.query(
        `INSERT INTO sst.documento_item_tributos (item_id, retencion_id, tributo_codigo, base, tarifa, valor) VALUES ($1, $2, $3, $4, $5, $6)`,
        [ids[tr.item ?? 0], tr.retencion ?? null, tr.retencion ? null : '01', tr.base, tr.tarifa, tr.valor],
      );
    }
    return d;
  };

  // FV-1-809: descuento comercial 2 % repartido por ítem; la autorretención viene guardada.
  const fv809 = await documento({
    tipo: 'FACTURA', tercero: axa, numero: '809',
    totales: { bruto: '4178776.00', descuento: '83575.52', subtotal: '4095200.48', iva: '0', retenciones: '450472.05', total: '3644728.43' },
    items: [
      { bruto: '3472504.00', descuento: '69450.08', base: '3403053.92' },
      { bruto: '353136.00', descuento: '7062.72', base: '346073.28' },
      { bruto: '353136.00', descuento: '7062.72', base: '346073.28' },
    ],
    tributos: [
      { retencion: rfHon, base: '4095200.48', tarifa: 11, valor: '450472.05' },
      { retencion: auto11, base: '4095200.48', tarifa: 1.1, valor: '45047.21' },
    ],
  });
  // FV-1-807: privado con IVA 19 %, sin retención; la autorretención NO viene: se calcula.
  const fv807 = await documento({
    tipo: 'FACTURA', tercero: sandona, numero: '807',
    totales: { bruto: '1744386.56', descuento: '0', subtotal: '1744386.56', iva: '331433.45', retenciones: '0', total: '2075820.01' },
    items: [{ bruto: '1744386.56' }],
    tributos: [{ base: '1744386.56', tarifa: 19, valor: '331433.45' }],
  });
  // NC-1-87: devolución total a Colmena con su retefuente.
  const nc87 = await documento({
    tipo: 'NOTA_CREDITO', tercero: colmena, numero: '87',
    totales: { bruto: '1232000.00', descuento: '0', subtotal: '1232000.00', iva: '0', retenciones: '135520.00', total: '1096480.00' },
    items: [{ bruto: '1120000.00' }, { bruto: '112000.00' }],
    tributos: [{ retencion: rfHon, base: '1232000.00', tarifa: 11, valor: '135520.00' }],
  });

  const codigoDe = new Map((await client.query(`SELECT id, codigo FROM sst.cuentas_contables`)).rows.map((c) => [c.id, c.codigo]));
  const comoSiigo = (a) => ordenar(a.lineas.map((l) => [codigoDe.get(l.cuenta_id), l.debito ? 'D' : 'C', l.debito ?? l.credito]));

  console.log('');
  for (const [nombre, id] of [['FV-1-809', fv809], ['FV-1-807', fv807], ['NC-1-87', nc87]]) {
    const a = await construirAsiento(id, client);
    igual(comoSiigo(a), ordenar(SIIGO[nombre]), `${nombre}: el asiento es el mismo de Siigo, cuenta a cuenta y al centavo`);
    igual(a.totales.debito === a.totales.credito, true, `${nombre}: cuadra (${a.totales.debito})`);
    igual(a.lineas.every((l) => l.tercero_id), true, `${nombre}: todas las líneas llevan al cliente como tercero`);
  }

  console.log('');
  const comp = await contabilizarEn(client, fv809, null);
  igual([comp.tipo_codigo, comp.estado, comp.movimientos.length, comp.total_debito], ['FV', 'CONTABILIZADO', 8, '4223823.21'], 'FV-1-809 queda como comprobante FV contabilizado');
  const doc = (await client.query(`SELECT comprobante_id, contabilizacion_error FROM sst.documentos_electronicos WHERE id = $1`, [fv809])).rows[0];
  igual([doc.comprobante_id === comp.id, doc.contabilizacion_error], [true, null], 'el documento queda enlazado a su comprobante');
  const otra = await contabilizarEn(client, fv809, null);
  igual(otra.id, comp.id, 'contabilizar de nuevo devuelve el mismo comprobante (idempotente)');
  const nc = await contabilizarEn(client, nc87, null);
  igual([nc.tipo_codigo, nc.total_debito], ['NC', '1245552.00'], 'NC-1-87 queda como comprobante NC');

  // Una regla específica de tercero gana a la general.
  const otraCuenta = (await client.query(`SELECT id FROM sst.cuentas_contables WHERE codigo = '42950502'`)).rows[0].id;
  await client.query(`INSERT INTO sst.reglas_contables (concepto, cuenta_id, tercero_id) VALUES ('FV_INGRESO', $1, $2)`, [otraCuenta, sandona]);
  const conRegla = await construirAsiento(fv807, client);
  igual(codigoDe.get(conRegla.lineas.find((l) => l.credito && l.descripcion).cuenta_id), '42950502', 'la regla del tercero reemplaza a la general');

  // Sin la regla general, el asiento no se arma y dice qué falta.
  await client.query(`SAVEPOINT sin_regla`);
  await client.query(`DELETE FROM sst.reglas_contables WHERE concepto = 'FV_IVA'`);
  try { await construirAsiento(fv807, client); fallos++; console.log('FAIL sin regla de IVA debió fallar'); }
  catch (e) { igual(e.message.includes('IVA generado'), true, `sin la regla de IVA avisa cuál falta → ${e.message}`); }
  await client.query(`ROLLBACK TO SAVEPOINT sin_regla`);
} finally {
  await client.query('ROLLBACK');
  client.release();
  const restos = (await cuentaResiduos()) - antes;
  console.log(`\nResiduos tras el ROLLBACK: ${restos}`);
  if (restos) fallos++;
  await pool.end();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTodo OK');
process.exit(fallos ? 1 : 0);
