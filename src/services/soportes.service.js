/**
 * Qué soportes se piden por visita (M6) y cómo se llaman por dentro.
 *
 * El profesional sube desde el móvil, así que los nombres que llegan son
 * 'IMG_20260815_142233(1).jpg', 'documento final FIRMADO (2).pdf' o
 * 'vacio001 - simbolos ¿?¡!.pdf' — casos todos reales del almacenamiento
 * actual. Con esos nombres el administrador no sabe qué está abriendo, y en la
 * clave del objeto acaban caracteres que ni S3 ni un sistema de archivos
 * quieren.
 *
 * Por eso el nombre lo pone el sistema, no el usuario: el archivo se guarda
 * como `acta.pdf`, `asistencia.pdf` o `evidencias.jpg` según la casilla en la
 * que se subió. El nombre que traía se conserva aparte (`nombre_original`)
 * porque es lo que permite responderle al profesional "el que subiste como
 * IMG_2233.jpg" cuando hay que pedirle que repita uno.
 */

/**
 * Las tres casillas del portal, en el orden en que se piden y se revisan. El
 * `orden` es el del acta primero: es el documento que decide si la visita se
 * da por buena, así que es el que el administrador quiere ver al abrir.
 */
export const CATEGORIAS_SOPORTE = [
  { clave: 'acta', etiqueta: 'Acta de visita firmada', orden: 1 },
  { clave: 'asistencia', etiqueta: 'Lista de asistencia', orden: 2 },
  { clave: 'evidencias', etiqueta: 'Registro fotográfico / evidencias', orden: 3 },
];

/**
 * Cajón de sastre. Existe para los archivos que llegan por el campo `files`
 * antiguo —una pestaña del portal abierta desde antes del cambio sigue
 * enviándolos así— y para los soportes que ya estaban guardados sin categoría.
 */
export const CATEGORIA_OTROS = { clave: 'otros', etiqueta: 'Otros soportes', orden: 9 };

const PORCLAVE = new Map(
  [...CATEGORIAS_SOPORTE, CATEGORIA_OTROS].map((c) => [c.clave, c]),
);

/** Clave válida o 'otros'. Nunca lanza: un soporte siempre se puede guardar. */
export function normalizarCategoria(clave) {
  const c = String(clave || '').trim().toLowerCase();
  return PORCLAVE.has(c) ? c : CATEGORIA_OTROS.clave;
}

/**
 * ¿Es una casilla real del portal? A diferencia de `normalizarCategoria`, esto
 * SÍ distingue: se usa para validar lo que llega en un rechazo, donde meter en
 * 'otros' una categoría escrita mal significaría desbloquear la casilla
 * equivocada al profesional.
 */
export function esCategoriaValida(clave) {
  return PORCLAVE.has(String(clave || '').trim().toLowerCase());
}

/** 'acta, evidencias' → 'Acta de visita firmada y Registro fotográfico…'. */
export function listaEtiquetas(claves) {
  const nombres = (claves || []).map((c) => etiquetaCategoria(c));
  if (nombres.length <= 1) return nombres[0] || '';
  return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

export function etiquetaCategoria(clave) {
  return (PORCLAVE.get(normalizarCategoria(clave)) || CATEGORIA_OTROS).etiqueta;
}

/** Extensión que corresponde al contenido REAL, no a la que traía el nombre. */
const EXTENSIONES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * Nombre interno del archivo: `acta.pdf`, `evidencias-2.jpg`.
 *
 * La extensión sale del mime FINAL, después de comprimir: un PNG que se
 * reescribe como JPEG tiene que dejar de llamarse `.png` o el visor —que elige
 * `<iframe>` o `<img>` por el tipo— y cualquier descarga posterior mentirían
 * sobre el contenido.
 *
 * @param indice  Posición dentro de su categoría (0 = el primero, sin sufijo).
 */
export function nombreCanonico(categoria, mime, indice = 0) {
  const clave = normalizarCategoria(categoria);
  const ext = EXTENSIONES[String(mime || '').toLowerCase()] || 'bin';
  const sufijo = indice > 0 ? `-${indice + 1}` : '';
  return `${clave}${sufijo}.${ext}`;
}

/** Orden de revisión: primero el acta, luego asistencia, luego evidencias. */
export function ordenCategoria(clave) {
  return (PORCLAVE.get(normalizarCategoria(clave)) || CATEGORIA_OTROS).orden;
}

/**
 * Nombre original tal como lo escribió la persona, no como lo decodifica multer.
 *
 * busboy interpreta el `filename` de un multipart como **latin1**, así que
 * 'simbolos ¿?¡!.pdf' se guardaba como 'simbolos Â¿?Â¡!.pdf' y cualquier tilde
 * de un nombre en español quedaba rota. El archivo se sirve con su nombre
 * canónico, pero este campo es el que permite decirle al profesional CUÁL de
 * los suyos tiene que repetir, y para eso tiene que ser legible.
 */
export function nombreOriginalLegible(nombre) {
  const bruto = String(nombre || '');
  if (!bruto) return null;
  try {
    const reinterpretado = Buffer.from(bruto, 'latin1').toString('utf8');
    // Si la reinterpretación produce el carácter de reemplazo, el nombre ya
    // venía bien en UTF-8 y tocarlo lo estropearía.
    return reinterpretado.includes('�') ? bruto : reinterpretado;
  } catch {
    return bruto;
  }
}
