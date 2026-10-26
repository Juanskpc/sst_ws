/**
 * P1 (26-oct-2026) · Cómo se NOMBRA una orden en los avisos y los correos.
 *
 * El cliente (JD&D) se guía por el cronograma y la secuencia que trae la orden
 * de Bolívar, no por el código OS-AAAA-NNNN que reparte la plataforma: ese
 * consecutivo interno no le dice nada cuando quiere comprobar que «esa orden ya
 * está cargada». Por eso la campanita y los correos la nombran así:
 *
 *   · Bolívar → «<cronograma>_<secuencia>» (p. ej. «1390041_26»), que es como la
 *     identifica la ARL y como la busca el cliente.
 *   · AXA, Colmena y Sura no tienen cronograma: su identidad es el número de
 *     orden (`numero_orden`).
 *   · Si por lo que sea no hay ninguno de los dos (una orden particular, un dato
 *     sin cargar), se cae al código OS para no dejar el aviso sin referencia.
 *
 * Se decide por la PRESENCIA de cronograma+secuencia y no por el nombre de la
 * ARL a propósito: esos dos campos solo los rellena Bolívar (el índice de dedup
 * es justamente `(arl_id, codigo_cronograma, secuencia)`), así la función sirve
 * aunque solo reciba las columnas de `ordenes_servicio` sin el `arl_nombre` de
 * la vista expandida.
 */
export function referenciaOrden(orden) {
  const cronograma = String(orden?.codigo_cronograma ?? '').trim();
  const secuencia = String(orden?.secuencia ?? '').trim();
  if (cronograma && secuencia) return `${cronograma}_${secuencia}`;
  const numero = String(orden?.numero_orden ?? '').trim();
  if (numero) return numero;
  return String(orden?.codigo ?? '').trim();
}

/**
 * La referencia seguida de la empresa, que es como el cliente lee el aviso:
 * «1390041_26 CONDUCTORES LA UNION SAS». Separador en espacio (no « · ») porque
 * es el formato exacto que pidió el cliente.
 */
export function referenciaConEmpresa(orden) {
  return [referenciaOrden(orden), String(orden?.empresa_nombre ?? '').trim()]
    .filter(Boolean)
    .join(' ');
}
