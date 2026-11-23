/**
 * Maqueta HTML de TODOS los correos que salen de la plataforma (una sola).
 *
 * 22-nov-2026 · Identidad ORBITA (`docs/2-arquitectura/DESIGN.md` §2 y §3). Antes
 * la cabecera era el navy viejo `#000b50` con «JD&D Consultores · SEGURIDAD Y
 * SALUD EN EL TRABAJO» en texto, y la factura traía además su propio logo de
 * JD&D. Ahora todos llevan la misma cara:
 *
 * - **Marca visible: ORBITA**, en una cabecera `noche` con el logo horizontal
 *   claro, y a su derecha «Un servicio de JD&D Consultores». ORBITA es la
 *   plataforma (es lo que el asesor y la contadora abren cada día); JD&D es la
 *   empresa que presta el servicio y la que factura, así que su nombre va en la
 *   cabecera, en la firma del pie y en el remitente (`EMAIL_FROM`), que no cambia.
 * - **Colores con contraste medido** (WCAG 2.x), los mismos tokens de la app:
 *   tinta `#0f2a44` 14,63 sobre blanco · tinta-2 `#44576c` 7,43 · tinta-3
 *   `#5c6f84` 5,17 blanco / 4,86 papel · blanco sobre acción `#13497a` 9,28 ·
 *   aviso `#7a5200` sobre `#fdf3d2` 6,24 · texto-noche `#c3d2e2` sobre noche 10,84.
 *   El cian solo vive dentro del logo (§1.3: nunca como letra ni como raya).
 *
 * Reglas de correo (no son manías, son limitaciones reales de los clientes):
 *
 * - **Tablas y estilos en línea.** Gmail descarta `<style>` en muchas cuentas,
 *   `flex` y `grid`; lo único que sobrevive en todas partes es una tabla con
 *   `style=` por celda. Tampoco se usa el atajo `font:`: Outlook de escritorio
 *   lo interpreta a medias. Cada propiedad va suelta (`estiloTexto`).
 * - **Sin fuentes web.** Inter va primera en la pila por si el equipo la tiene;
 *   si no, Segoe UI (Windows/Outlook), Roboto (Android/Gmail) o Helvetica.
 * - **El logo va DENTRO del correo (`cid:`)**, como ya se hacía con el de la
 *   factura: una imagen remota la bloquean Outlook y muchos buzones hasta que se
 *   pulsa «mostrar imágenes». Lo adjunta `sendEmail` cuando ve el `cid` en el
 *   HTML (`adjuntoLogo`); si se bloquea igual, el `alt` sale en blanco sobre la
 *   cabecera y se sigue leyendo «ORBITA». Va en PNG (Outlook no lee WebP) y a
 *   doble resolución.
 * - **Modo oscuro: el logo lleva su fondo noche DENTRO del PNG (opaco).** Gmail
 *   en el iPhone invierte TODO el correo, incluida la cabecera noche (pasa a
 *   claro), pero no las imágenes: con el fondo transparente de la primera
 *   versión, la palabra blanca ORBITA quedaba blanco sobre claro y desaparecía
 *   (lo cazó el juez el 22-nov). Con el fondo horneado el logo se ve igual con
 *   cualquier inversión; a lo sumo queda como un rótulo oscuro sobre la
 *   cabecera invertida. Todo fondo y todo color de texto van explícitos.
 * - **Ancho: 600 px como máximo y hasta 320 px sin desbordar.** `max-width`
 *   para los demás y una tabla fantasma de 600 px solo para Outlook de
 *   escritorio (`<!--[if mso]>`), que ignora `max-width` y estiraría el correo
 *   a todo el ancho de la ventana. Rellenos cortos (8 px por fuera, 16-20 px
 *   por dentro) y nada con `nowrap` en la cabecera: el celular de 320 px deja
 *   unos 300 px útiles.
 * - **Siempre acompañado de `text`.** El HTML es la versión bonita, no la única:
 *   quien lea en texto plano tiene que recibir lo mismo.
 */

import { existsSync, readFileSync } from 'node:fs';

// Tokens de DESIGN.md §2 (mismo nombre que en la app).
const NOCHE = '#0b1f33';
const TEXTO_NOCHE = '#c3d2e2';
const TEXTO_NOCHE_2 = '#9fb3c6';
const ACCION = '#13497a';
const TINTA = '#0f2a44';
const TINTA_2 = '#44576c';
const TINTA_3 = '#5c6f84';
const PAPEL = '#f6f8fa';
const BORDE = '#e1e7ee';
const AVISO = '#7a5200';
const AVISO_FONDO = '#fdf3d2';
const AVISO_BORDE = '#f0dc9c';
const BORDE_CONTROL = '#c3ceda';

const FUENTE = "Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Tipografía en propiedades sueltas (Outlook no entiende bien el atajo `font:`). */
function estiloTexto(tam, peso, color, interlinea = 1.5) {
  return `font-family:${FUENTE};font-size:${tam}px;font-weight:${peso};line-height:${interlinea};color:${color}`;
}

/**
 * Logo de ORBITA para el correo: isotipo + palabra, SIN el lema «Gestión
 * Inteligente» (a este tamaño medía 7 px de alto; DESIGN §7 lo quitó de la
 * barra lateral por lo mismo), sobre noche opaco. 272×68 = 2× de 136×34.
 */
const LOGO_RUTA = new URL('../../assets/correo/logo-orbita-correo.png', import.meta.url);
export const LOGO_CID = 'orbita-marca';
const LOGO_EXISTE = existsSync(LOGO_RUTA);
let logoBuffer = null;

/**
 * Adjunto en línea del logo para `sendEmail`. Se lee una vez y se guarda: se
 * manda en cada correo y son 21 KB.
 */
export function adjuntoLogo() {
  if (!LOGO_EXISTE) return null;
  logoBuffer ??= readFileSync(LOGO_RUTA);
  return {
    filename: 'orbita.png',
    content: logoBuffer,
    cid: LOGO_CID,
    contentType: 'image/png',
    contentDisposition: 'inline',
  };
}

/**
 * 23-nov-2026 · Decisión del dueño: lo que va a CLIENTES de JD&D (factura, nota
 * crédito y documentos de ese tipo) lleva la marca de JD&D, no la de ORBITA:
 * «los clientes no saben qué es ORBITA, saben qué es JD&D Consultores». Logo de
 * JD&D recortado sobre BLANCO opaco (188×112 = 2× de 94×56), para que la
 * inversión del modo oscuro del celular no lo borre (el PNG transparente del
 * 7-oct desaparecía).
 */
const LOGO_JDD_RUTA = new URL('../../assets/correo/logo-jdd-correo.png', import.meta.url);
export const LOGO_JDD_CID = 'jdd-marca';
const LOGO_JDD_EXISTE = existsSync(LOGO_JDD_RUTA);
let logoJddBuffer = null;

export function adjuntoLogoJdd() {
  if (!LOGO_JDD_EXISTE) return null;
  logoJddBuffer ??= readFileSync(LOGO_JDD_RUTA);
  return {
    filename: 'jdd-consultores.png',
    content: logoJddBuffer,
    cid: LOGO_JDD_CID,
    contentType: 'image/png',
    contentDisposition: 'inline',
  };
}

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
  // Raya fina entre filas: con diez datos seguidos el ojo se salta de renglón.
  // `overflow-wrap` parte el CUFE (96 caracteres sin espacios) en el celular.
  return `<tr>
    <td style="padding:9px 12px 9px 0;border-bottom:1px solid ${BORDE};${estiloTexto(13, 500, TINTA_2, 1.4)};width:38%;vertical-align:top">${esc(etiqueta)}</td>
    <td style="padding:9px 0;border-bottom:1px solid ${BORDE};${estiloTexto(14, 400, TINTA, 1.4)};vertical-align:top;overflow-wrap:anywhere;word-break:break-word">${esc(valor)}</td>
  </tr>`;
}

/**
 * Caja gris claro de los bloques (lista, total). Sin raya de color a un lado:
 * DESIGN §10 la retiró de tarjetas y grupos.
 */
function caja(contenido, relleno = '14px 16px') {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;border-collapse:separate;background:${PAPEL};border:1px solid ${BORDE};border-radius:10px">
    <tr><td bgcolor="${PAPEL}" style="padding:${relleno};border-radius:10px">${contenido}</td></tr>
  </table>`;
}

/**
 * Bloque destacado con una lista de líneas, una debajo de otra: las franjas de
 * una visita en el correo de asignación, las órdenes incluidas en el de la
 * pre-cuenta. Se llamaba `bloqueFranjas` cuando solo existía el primer caso.
 */
export function bloqueLista(titulo, lineas, { secundaria = false } = {}) {
  if (!lineas?.length) return '';
  // 22-nov-2026 · `secundaria`: lo que acompaña pero no es lo principal (las
  // invitaciones de calendario frente a los formatos). Fondo blanco, borde
  // punteado y viñeta gris: a simple vista no es «otra caja de formatos».
  const colorVineta = secundaria ? TINTA_3 : ACCION;
  const colorTitulo = secundaria ? TINTA_2 : TINTA;
  // La viñeta es un carácter en su propia celda y no un `span` redondeado:
  // Outlook no redondea y la pintaba como un cuadrado pegado al texto, y en dos
  // renglones la segunda línea quedaba debajo de la viñeta en vez de alineada.
  const items = lineas
    .map(
      (l) => `<tr>
        <td width="16" style="width:16px;padding:4px 0;vertical-align:top;${estiloTexto(14, 600, colorVineta, 1.5)}">&bull;</td>
        <td style="padding:4px 0;vertical-align:top;${estiloTexto(14, 400, TINTA, 1.5)}">${esc(l)}</td>
      </tr>`,
    )
    .join('');
  // Título en frase, sin mayúsculas forzadas (DESIGN §3).
  const contenido = `<p style="margin:0 0 6px;${estiloTexto(13, 600, colorTitulo, 1.4)}">${esc(titulo)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${items}</table>`;
  if (!secundaria) return caja(contenido);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;border-collapse:separate;background:#ffffff;border:1px dashed ${BORDE_CONTROL};border-radius:10px">
    <tr><td bgcolor="#ffffff" style="padding:14px 16px;border-radius:10px">${contenido}</td></tr>
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
  // La cifra en tinta y a 600 (el sistema no usa 700): el color queda para la
  // acción y el estado (DESIGN §1.1).
  return caja(`<p style="margin:0 0 2px;${estiloTexto(13, 600, TINTA_2, 1.4)}">${esc(etiqueta)}</p>
      <p style="margin:0;${estiloTexto(28, 600, TINTA, 1.2)};letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${esc(valor)}</p>
      ${nota ? `<p style="margin:6px 0 0;${estiloTexto(13, 400, TINTA_3, 1.4)}">${esc(nota)}</p>` : ''}`, '16px 18px');
}

/**
 * Aviso para lo que el destinatario debe tener en cuenta: el ámbar de «aviso»
 * de la app (`#7a5200` sobre `#fdf3d2`, 6,24:1). La palabra «Importante» va
 * delante para que no dependa solo del color (DESIGN §1.8).
 */
export function bloqueAviso(texto) {
  if (!texto) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;border-collapse:separate;background:${AVISO_FONDO};border:1px solid ${AVISO_BORDE};border-radius:10px">
    <tr><td bgcolor="${AVISO_FONDO}" style="padding:14px 16px;border-radius:10px;${estiloTexto(14, 400, AVISO, 1.5)}"><strong style="font-weight:600">Importante:</strong> ${esc(texto)}</td></tr>
  </table>`;
}

/**
 * Botón de acción (azul de acción, blanco encima 9,28:1), «a prueba de balas»:
 *
 * - **Outlook de escritorio** (motor de Word) ignora el relleno de los enlaces y
 *   el radio de las celdas. Para él va un `v:roundrect` de VML dentro de
 *   `<!--[if mso]>`: un rectángulo redondeado que ES el enlace, entero clicable.
 * - **Los demás** ven el `<a>` con su relleno, que también es clicable entero.
 *
 * El ancho del VML es fijo (VML no se ajusta al texto): se estima por letras.
 */
export function boton(texto, url) {
  if (!url) return '';
  const href = esc(url);
  const ancho = Math.max(160, Math.round(String(texto).length * 9 + 56));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 14px">
    <tr><td style="border-radius:8px">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:${ancho}px" arcsize="17%" stroke="f" fillcolor="${ACCION}">
        <w:anchorlock/>
        <center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:bold">${esc(texto)}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-- --><a href="${href}" target="_blank" style="display:inline-block;padding:13px 24px;${estiloTexto(15, 600, '#ffffff', 1.2)};text-decoration:none;border-radius:8px;background:${ACCION};border:1px solid ${ACCION}">${esc(texto)}</a><!--<![endif]-->
    </td></tr>
  </table>`;
}

/** Cabecera blanca con el logo de JD&D (correos a clientes: `marca: 'jdd'`). */
function cabeceraJdd() {
  const logo = LOGO_JDD_EXISTE
    ? `<img src="cid:${LOGO_JDD_CID}" width="94" height="56" alt="JD&amp;D Consultores" style="display:block;width:94px;height:56px;border:0;outline:none;text-decoration:none;${estiloTexto(18, 600, TINTA, 1.2)}">`
    : `<span style="${estiloTexto(18, 600, TINTA, 1.2)}">JD&amp;D Consultores</span>`;
  return `<!-- Cabecera: JD&D Consultores (correos a clientes) -->
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:16px 20px;border-bottom:1px solid ${BORDE};border-radius:11px 11px 0 0">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td valign="middle" style="vertical-align:middle">${logo}</td>
              <td align="right" valign="middle" style="vertical-align:middle;text-align:right;padding-left:10px">
                <p style="margin:0;${estiloTexto(12, 400, TINTA_3, 1.35)}">Seguridad y Salud<br>en el Trabajo</p>
              </td>
            </tr>
          </table>
        </td></tr>`;
}

/**
 * Envuelve el contenido en la maqueta de marca.
 *
 * Cabecera (marca) → título y subtítulo → cuerpo (datos, avisos, botón) → pie.
 *
 * @param {string} titulo     Título del correo (p. ej. "Nueva orden de servicio asignada").
 * @param {string} subtitulo  Línea bajo el título (orden y empresa, número y cliente…).
 * @param {string} cuerpo     HTML ya compuesto con los helpers de este archivo.
 * @param {string} pie        Firma del correo, en el pie.
 *
 * Hasta el 22-nov-2026 había un `logoCid` para que la factura llevara el logo
 * de JD&D; ya no: todos los correos llevan la misma cabecera de ORBITA.
 */
export function correoHtml({ titulo, subtitulo, cuerpo, pie, marca: tipoMarca = 'orbita' }) {
  const esJdd = tipoMarca === 'jdd';
  // Si el archivo del logo faltara, la palabra ORBITA en texto: el correo no
  // puede salir con una imagen rota en la cabecera.
  const marca = LOGO_EXISTE
    ? `<img src="cid:${LOGO_CID}" width="136" height="34" alt="ORBITA" style="display:block;width:136px;height:34px;border:0;outline:none;text-decoration:none;${estiloTexto(18, 600, '#ffffff', 1.2)};letter-spacing:0.08em">`
    : `<span style="${estiloTexto(18, 600, '#ffffff', 1.2)};letter-spacing:0.08em">ORBITA</span>`;
  // Texto que Gmail y Outlook enseñan en la bandeja junto al asunto. Sin él,
  // la vista previa empezaba por «ORBITA Un servicio de JD&D Consultores…». El
  // relleno de `&zwnj;&nbsp;` detrás evita que, terminado el preencabezado, la
  // bandeja siga leyendo el texto de la cabecera.
  const preencabezado = [titulo, subtitulo].filter(Boolean).join(' · ');
  const rellenoPre = '&zwnj;&nbsp;'.repeat(90);
  return `<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:${PAPEL};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${PAPEL}">${esc(preencabezado)}${rellenoPre}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${PAPEL}" style="background:${PAPEL}">
    <tr><td align="center" style="padding:20px 8px">
      <!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td width="600"><![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px;border-collapse:separate;background:#ffffff;border:1px solid ${BORDE};border-radius:12px">

        ${esJdd ? cabeceraJdd() : `<!-- Cabecera: ORBITA, de JD&D Consultores -->
        <tr><td bgcolor="${NOCHE}" style="background:${NOCHE};padding:16px;border-radius:11px 11px 0 0">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td valign="middle" style="vertical-align:middle;${estiloTexto(18, 600, '#ffffff', 1.2)}">${marca}</td>
              <td align="right" valign="middle" style="vertical-align:middle;text-align:right;padding-left:10px">
                <p style="margin:0;${estiloTexto(11, 400, TEXTO_NOCHE_2, 1.3)}">Un servicio de</p>
                <p style="margin:0;${estiloTexto(13, 600, '#ffffff', 1.3)}">JD&amp;D Consultores</p>
              </td>
            </tr>
          </table>
        </td></tr>`}

        <!-- Título -->
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:24px 20px 4px">
          <h1 style="margin:0;${estiloTexto(22, 600, TINTA, 1.3)};letter-spacing:-0.01em">${esc(titulo)}</h1>
          ${subtitulo ? `<p style="margin:6px 0 0;${estiloTexto(14, 400, TINTA_3, 1.45)}">${esc(subtitulo)}</p>` : ''}
        </td></tr>

        <!-- Cuerpo: datos, avisos y botón -->
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:14px 20px 24px;${estiloTexto(15, 400, TINTA, 1.6)}">
          ${cuerpo}
        </td></tr>

        <!-- Pie: firma de JD&D y origen del mensaje -->
        <tr><td bgcolor="${PAPEL}" style="background:${PAPEL};padding:16px 20px 20px;border-top:1px solid ${BORDE};border-radius:0 0 11px 11px">
          ${pie ? `<p style="margin:0 0 6px;${estiloTexto(13, 600, TINTA_2, 1.45)}">${esc(pie)}</p>` : ''}
          <p style="margin:0;${estiloTexto(12, 400, TINTA_3, 1.5)}">
            ${esJdd ? 'Este mensaje lo generó automáticamente el sistema de JD&amp;D Consultores.' : 'Este mensaje lo generó automáticamente ORBITA, la plataforma de JD&amp;D Consultores.'} No responda a este correo.
          </p>
        </td></tr>

      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body></html>`;
}

/** Párrafo simple con el espaciado de la maqueta (15 px: se lee en el celular sin ampliar). */
export function parrafo(texto) {
  if (!texto) return '';
  return `<p style="margin:0 0 14px;${estiloTexto(15, 400, TINTA, 1.6)}">${esc(texto)}</p>`;
}

/** Bloque de datos (orden, factura…). Recibe el HTML ya armado con `filaDato`. */
export function tablaDatos(filas) {
  const cuerpo = filas.filter(Boolean).join('');
  if (!cuerpo) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 10px;border-collapse:collapse;border-top:1px solid ${BORDE}">${cuerpo}</table>`;
}

/** Enlace en texto, para cuando el botón no basta (hay clientes que lo ocultan). */
export function enlaceCrudo(url) {
  if (!url) return '';
  return `<p style="margin:0 0 6px;${estiloTexto(12, 400, TINTA_3, 1.5)};word-break:break-all">
    Si el botón no funciona, copie este enlace:<br><a href="${esc(url)}" target="_blank" style="color:${ACCION};text-decoration:underline">${esc(url)}</a>
  </p>`;
}
