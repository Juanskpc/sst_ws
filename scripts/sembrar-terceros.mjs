// Siembra los terceros iniciales de la Fase A (A0-05) y enlaza cada ARL de
// Orbita con su tercero. Se corre a mano; NO vive en db/seed.sql a propósito
// (esos datos son de JD&D, no de una base vacía).
//
// Uso: node scripts/sembrar-terceros.mjs
//
// Idempotente y respetuoso: si el documento YA existe como tercero no se toca
// ningún campo (alguien pudo haberlo corregido a mano en la pantalla); solo se
// completa el enlace `arls.tercero_id` cuando está vacío.
//
// De dónde salen los datos: NIT, razón social y dirección de las facturas de
// Siigo y las notas crédito de los ejemplos de JD&D (plan de facturación §3.3).
// ⚠️ Son los nombres tal como salen en esas facturas, no los del RUT de cada
// pagador: cualquiera puede haber cambiado de razón social. Se corrigen desde
// /terceros sin tocar este script.
//
// ⚠️ PENDIENTE DE CONFIRMAR CON JD&D — Bolívar: el NIT 860.002.503-2 sale del pie
// de su formato oficial AT-031 (no de una factura nuestra, porque en los ejemplos
// no hay ninguna) y la razón social "COMPAÑIA DE SEGUROS BOLIVAR S A" también. El
// DV se comprueba abajo con nit.js. Falta su dirección y el correo de facturación.
//
// Tampoco se inventan: correos de facturación, responsabilidades fiscales (queda
// vacío, que para Factus equivale a R-99-PN) ni el régimen (queda el valor por
// defecto RESPONSABLE_IVA, propio de una aseguradora, sin confirmar con la contadora).
import { pool } from '../src/config/db.js';
import { calcularDv } from '../src/utils/nit.js';
import { validarTercero, CAMPOS_TERCERO } from '../src/modules/terceros/terceros.service.js';

const TERCEROS = [
  // `arl`: nombre en sst.arls al que se enlaza. La Equidad es un cuarto pagador
  // que Orbita aún no tiene como ARL (Q-13): queda solo el tercero.
  { nit: '860002183', dv: 9, razon: 'AXA COLPATRIA SEGUROS DE VIDA SA', direccion: 'CR 7 24 89 P 7', dane: '11001', roles: ['es_cliente', 'es_arl'], arl: 'AXA Colpatria' },
  { nit: '800226175', dv: 3, razon: 'COLMENA SEGUROS RIESGOS LABORALES', direccion: 'CALLE 26 NO 69C 03', dane: '11001', roles: ['es_cliente', 'es_arl'], arl: 'Colmena' },
  { nit: '860002503', dv: 2, razon: 'COMPAÑIA DE SEGUROS BOLIVAR S A', direccion: null, dane: null, roles: ['es_cliente', 'es_arl'], arl: 'Bolívar' },
  { nit: '830008686', dv: 1, razon: 'LA EQUIDAD SEGUROS DE VIDA O.C', direccion: 'CR 9 A 99 07 P 12 13 14 15', dane: '11001', roles: ['es_cliente', 'es_arl'], arl: null },
  { nit: '891200297', dv: 1, razon: 'TRANSPORTE DE SANDONA SA', direccion: null, dane: '52001', roles: ['es_cliente'], arl: null },
];

try {
  const nit = await pool.query(`SELECT id FROM sst.tipos_documento_identidad WHERE codigo_dian = '31'`);
  if (!nit.rows[0]) throw new Error('Falta el tipo de documento NIT: corra primero scripts/sembrar-catalogos-dian.mjs');

  for (const t of TERCEROS) {
    // Red de seguridad: el DV que trae cada dato tiene que coincidir con el algoritmo.
    if (calcularDv(t.nit) !== t.dv) throw new Error(`El DV de ${t.razon} no cuadra: el algoritmo da ${calcularDv(t.nit)} y la fuente decía ${t.dv}.`);

    let municipioId = null;
    if (t.dane) {
      const m = await pool.query(`SELECT id FROM sst.municipios WHERE codigo_dian = $1`, [t.dane]);
      if (!m.rows[0]) throw new Error(`No está el municipio ${t.dane}: corra primero scripts/sembrar-catalogos-dian.mjs`);
      municipioId = m.rows[0].id;
    }

    const campos = await validarTercero({
      tipo_persona: 'JURIDICA',
      tipo_documento_id: nit.rows[0].id,
      numero_documento: t.nit,
      razon_social: t.razon,
      direccion: t.direccion,
      municipio_id: municipioId,
      ...Object.fromEntries(t.roles.map((r) => [r, true])),
    });

    let id;
    const existente = await pool.query(
      `SELECT id FROM sst.terceros WHERE tipo_documento_id = $1 AND numero_documento = $2`,
      [campos.tipo_documento_id, campos.numero_documento],
    );
    if (existente.rows[0]) {
      id = existente.rows[0].id;
      console.log(`= ${t.razon}: ya existía, no se toca`);
    } else {
      const r = await pool.query(
        `INSERT INTO sst.terceros (${CAMPOS_TERCERO.join(', ')})
         VALUES (${CAMPOS_TERCERO.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, dv`,
        CAMPOS_TERCERO.map((c) => campos[c]),
      );
      id = r.rows[0].id;
      console.log(`+ ${t.razon}: creado (NIT ${t.nit}-${r.rows[0].dv})`);
    }

    if (t.arl) {
      const e = await pool.query(
        `UPDATE sst.arls SET tercero_id = $2 WHERE nombre = $1 AND tercero_id IS NULL RETURNING nombre`,
        [t.arl, id],
      );
      const estado = await pool.query(`SELECT tercero_id FROM sst.arls WHERE nombre = $1`, [t.arl]);
      if (!estado.rows[0]) console.log(`  ⚠ no hay ARL "${t.arl}" en sst.arls`);
      else console.log(e.rowCount ? `  ↳ ARL ${t.arl} enlazada` : `  ↳ ARL ${t.arl}: ${estado.rows[0].tercero_id === id ? 'ya estaba enlazada' : 'enlazada a OTRO tercero, no se toca'}`);
    }
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
