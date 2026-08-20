/**
 * Maqueta HTML de los correos que salen de la plataforma.
 *
 * Los correos iban en texto plano y llegaban como un bloque gris sin identidad;
 * Gmail incluso ofrecía "traducir al español" porque no encontraba estructura.
 * Aquí se centraliza el aspecto para que ARL, profesional y cliente reciban
 * siempre la misma cara: azul de marca `#000b50`, apoyo `#2d7bc8`.
 *
 * Reglas de correo (no son manías, son limitaciones reales de los clientes):
 *
 * - **Tablas y estilos en línea.** Gmail descarta `<style>`, `flex` y `grid`;
 *   lo único que sobrevive en todas partes es una tabla con `style=` por celda.
 * - **Nada externo.** Ni fuentes web ni imágenes remotas: muchos clientes
 *   bloquean la carga y el correo quedaría descuadrado. El logotipo se dibuja
 *   con texto sobre un fondo de color.
 * - **Ancho fijo de 600 px** con `width:100%` por dentro: es el ancho que todos
 *   los clientes de escritorio muestran sin recortar y en móvil se adapta.
 * - **Siempre acompañado de `text`.** El HTML es la versión bonita, no la única:
 *   quien lea en texto plano tiene que recibir lo mismo.
 */

const AZUL = '#000b50';
const AZUL_CLARO = '#2d7bc8';
const TEXTO = '#1f2937';
const SUAVE = '#6b7280';
const BORDE = '#e5e7eb';
const FONDO = '#f1f5f9';

const FUENTE = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Escapa el texto que se interpola en el HTML. */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fila de la tabla de datos ("Empresa: …"). La etiqueta va en gris y estrecha;
 * el valor, en negro y ocupando el resto.
 */
export function filaDato(etiqueta, valor) {
  if (valor == null || valor === '') return '';
  return `<tr>
    <td style="padding:6px 12px 6px 0;font:600 13px ${FUENTE};color:${SUAVE};white-space:nowrap;vertical-align:top">${esc(etiqueta)}</td>
    <td style="padding:6px 0;font:400 14px ${FUENTE};color:${TEXTO};vertical-align:top">${esc(valor)}</td>
  </tr>`;
}

/**
 * Bloque destacado con una lista de líneas, una debajo de otra: las franjas de
 * una visita en el correo de asignación, las órdenes incluidas en el de la
 * pre-cuenta. Se llamaba `bloqueFranjas` cuando solo existía el primer caso.
 */
export function bloqueLista(titulo, lineas) {
  if (!lineas?.length) return '';
  const items = lineas
    .map(
      (l) => `<tr><td style="padding:5px 0;font:400 14px ${FUENTE};color:${TEXTO}">
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${AZUL_CLARO};margin-right:9px;vertical-align:middle"></span>${esc(l)}
      </td></tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0;border-collapse:collapse;background:#f8fafc;border:1px solid ${BORDE};border-left:3px solid ${AZUL_CLARO};border-radius:6px">
    <tr><td style="padding:14px 16px">
      <p style="margin:0 0 6px;font:700 11px ${FUENTE};letter-spacing:.06em;text-transform:uppercase;color:${AZUL}">${esc(titulo)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${items}</table>
    </td></tr>
  </table>`;
}

/**
 * Cifra destacada (el total de una pre-cuenta de cobro).
 *
 * Va en su propio bloque y no como una fila más de `tablaDatos` porque es el
 * dato por el que se abre el correo: quien recibe su cuenta del mes mira primero
 * cuánto se le va a pagar y solo después de dónde sale. La `nota` es el
 * desglose corto que sostiene la cifra ("12 órdenes · 48 horas").
 */
export function bloqueTotal(etiqueta, valor, nota) {
  if (!valor) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0;border-collapse:collapse;background:#f8fafc;border:1px solid ${BORDE};border-left:3px solid ${AZUL_CLARO};border-radius:6px">
    <tr><td style="padding:16px 18px">
      <p style="margin:0 0 4px;font:700 11px ${FUENTE};letter-spacing:.06em;text-transform:uppercase;color:${AZUL}">${esc(etiqueta)}</p>
      <p style="margin:0;font:700 26px ${FUENTE};color:${AZUL};line-height:1.2">${esc(valor)}</p>
      ${nota ? `<p style="margin:5px 0 0;font:400 13px ${FUENTE};color:${SUAVE}">${esc(nota)}</p>` : ''}
    </td></tr>
  </table>`;
}

/** Aviso en ámbar para lo que el destinatario debe tener en cuenta. */
export function bloqueAviso(texto) {
  if (!texto) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0;border-collapse:collapse;background:#fffbeb;border:1px solid #fde68a;border-radius:6px">
    <tr><td style="padding:12px 14px;font:400 13px ${FUENTE};color:#92400e">${esc(texto)}</td></tr>
  </table>`;
}

/**
 * Botón de acción. Va como tabla y no como `<a>` con padding porque Outlook
 * ignora el relleno de los enlaces y el botón saldría como texto suelto.
 */
export function boton(texto, url) {
  if (!url) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0">
    <tr><td style="border-radius:6px;background:${AZUL}">
      <a href="${esc(url)}" style="display:inline-block;padding:12px 26px;font:600 14px ${FUENTE};color:#ffffff;text-decoration:none;border-radius:6px">${esc(texto)}</a>
    </td></tr>
  </table>`;
}

/**
 * Envuelve el contenido en la maqueta de marca.
 *
 * @param {string} titulo     Franja superior (p. ej. "Nueva orden asignada").
 * @param {string} subtitulo  Línea bajo el título, dentro de la cabecera azul.
 * @param {string} cuerpo     HTML ya compuesto con los helpers de arriba.
 * @param {string} pie        Nota final en gris pequeño.
 */
export function correoHtml({ titulo, subtitulo, cuerpo, pie }) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:${FONDO}">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${FONDO};padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid ${BORDE}">

        <!-- Cabecera de marca -->
        <tr><td style="background:${AZUL};padding:22px 28px">
          <p style="margin:0;font:700 17px ${FUENTE};color:#ffffff;letter-spacing:-.01em">JD&amp;D Consultores</p>
          <p style="margin:3px 0 0;font:400 12px ${FUENTE};color:#a9b6e8;letter-spacing:.04em">SEGURIDAD Y SALUD EN EL TRABAJO</p>
        </td></tr>

        <tr><td style="height:3px;background:${AZUL_CLARO};font-size:0;line-height:0">&nbsp;</td></tr>

        <tr><td style="padding:26px 28px 8px">
          <h1 style="margin:0;font:700 20px ${FUENTE};color:${TEXTO};line-height:1.3">${esc(titulo)}</h1>
          ${subtitulo ? `<p style="margin:5px 0 0;font:400 14px ${FUENTE};color:${SUAVE}">${esc(subtitulo)}</p>` : ''}
        </td></tr>

        <tr><td style="padding:10px 28px 26px;font:400 14px ${FUENTE};color:${TEXTO};line-height:1.6">
          ${cuerpo}
        </td></tr>

        <tr><td style="padding:16px 28px 22px;border-top:1px solid ${BORDE};background:#fafafa">
          <p style="margin:0;font:400 12px ${FUENTE};color:${SUAVE};line-height:1.5">
            ${pie ? esc(pie) + '<br>' : ''}
            Este mensaje lo generó automáticamente la plataforma JD&amp;D IA-Core. No respondas a este correo.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Párrafo simple con el espaciado de la maqueta. */
export function parrafo(texto) {
  if (!texto) return '';
  return `<p style="margin:0 0 12px;font:400 14px ${FUENTE};color:${TEXTO};line-height:1.6">${esc(texto)}</p>`;
}

/** Tabla de datos de la orden. Recibe el HTML ya armado con `filaDato`. */
export function tablaDatos(filas) {
  const cuerpo = filas.filter(Boolean).join('');
  if (!cuerpo) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 8px;border-collapse:collapse">${cuerpo}</table>`;
}

/** Enlace en texto, para cuando el botón no basta (hay clientes que lo ocultan). */
export function enlaceCrudo(url) {
  if (!url) return '';
  return `<p style="margin:0;font:400 12px ${FUENTE};color:${SUAVE};line-height:1.5;word-break:break-all">
    Si el botón no funciona, copia este enlace:<br><a href="${esc(url)}" style="color:${AZUL_CLARO}">${esc(url)}</a>
  </p>`;
}
