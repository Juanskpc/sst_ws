import { env } from '../../../config/env.js';
import { HttpError } from '../../../utils/httpError.js';

/**
 * Cliente HTTP de Factus: token OAuth2 + `request()`. Es lo único de Orbita que
 * habla con Factus; el adaptador (`factus.adaptador.js`) lo usa y el resto del
 * código nunca lo importa (principio 2 del §5.1 del plan).
 *
 * Autenticación: OAuth2 *password grant* contra `POST /oauth/token`
 * (form-urlencoded). El token se cachea en memoria del proceso y se renueva un
 * minuto antes de caducar, primero con el `refresh_token` y, si Factus lo
 * rechaza, repitiendo el password grant.
 */

const TIMEOUT_MS = 30_000;
// Margen para no salir con un token que caduca a mitad de la petición.
const MARGEN_RENOVACION_MS = 60_000;

/**
 * Error normalizado de Factus. Extiende `HttpError` para que el manejador
 * central lo convierta solo en respuesta, y añade lo que el llamador necesita
 * para decidir sin volver a parsear:
 *  - `status`: el HTTP que devolvió Factus (0 si nunca contestó: red o timeout).
 *  - `mensaje`: la frase legible que dio Factus (o la nuestra si no hubo).
 *  - `detalle`: el cuerpo o `errors` de Factus, tal cual (validaciones, rechazos DIAN).
 */
export class FactusError extends HttpError {
  constructor({ status, mensaje, detalle, statusCode }) {
    super(statusCode ?? codigoParaNosotros(status), mensaje, detalle);
    this.name = 'FactusError';
    this.status = status;
    this.mensaje = mensaje;
    this.detalle = detalle;
  }
}

/**
 * Qué código HTTP le devolvemos a nuestro frontend según lo que dijo Factus.
 * Un 401/403 de Factus significa credenciales o permisos NUESTROS mal puestos:
 * no es culpa de quien pulsó el botón, así que sale como 502.
 */
function codigoParaNosotros(status) {
  if (status === 400 || status === 409 || status === 422) return 422;
  if (status === 404) return 404;
  if (status === 429) return 429;
  return 502;
}

// Campo de env.factus → variable de entorno que hay que poner en .env.
const VARIABLES = {
  url: 'FACTUS_URL',
  clientId: 'FACTUS_CLIENT_ID',
  clientSecret: 'FACTUS_CLIENT_SECRET',
  username: 'FACTUS_USERNAME',
  password: 'FACTUS_PASSWORD',
};

/** Nombres de las variables FACTUS_* que faltan en .env. */
export function faltanCredenciales() {
  return Object.entries(VARIABLES).filter(([campo]) => !env.factus[campo]).map(([, variable]) => variable);
}

export function estaConfigurado() {
  return faltanCredenciales().length === 0;
}

/** ¿Apunta al ambiente de pruebas? Los scripts de humo y siembra lo exigen. */
export function esSandbox() {
  return env.factus.url.includes('sandbox');
}

let token = null; // { accessToken, refreshToken, venceEn }
let renovando = null; // promesa en vuelo, para que dos peticiones no pidan dos tokens

function exigirConfiguracion() {
  if (!estaConfigurado()) {
    throw new FactusError({
      status: 0,
      statusCode: 503,
      mensaje: 'Proveedor de facturación no configurado',
      detalle: { faltan: faltanCredenciales() },
    });
  }
}

/** Lee el cuerpo sin asumir que sea JSON: un 502 de un proxy llega en HTML. */
async function leerCuerpo(respuesta) {
  const texto = await respuesta.text();
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return { crudo: texto.slice(0, 500) };
  }
}

async function llamar(url, opciones) {
  try {
    return await fetch(url, { ...opciones, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const agotado = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new FactusError({
      status: 0,
      mensaje: agotado
        ? 'El proveedor tecnológico no respondió a tiempo. Consulte el estado antes de reintentar.'
        : 'No se pudo conectar con el proveedor tecnológico.',
      detalle: { causa: err?.cause?.code || err?.message },
    });
  }
}

function errorDeRespuesta(status, cuerpo) {
  // Factus usa `message` y, en validaciones, `data.errors` o `errors`.
  const detalle = cuerpo?.data?.errors ?? cuerpo?.errors ?? cuerpo;
  return new FactusError({
    status,
    mensaje: cuerpo?.message || cuerpo?.error_description || cuerpo?.error || `El proveedor tecnológico respondió HTTP ${status}`,
    detalle,
  });
}

async function pedirToken(cuerpo) {
  const r = await llamar(`${env.factus.url}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.factus.clientId,
      client_secret: env.factus.clientSecret,
      ...cuerpo,
    }),
  });
  const datos = await leerCuerpo(r);
  if (!r.ok || !datos?.access_token) {
    // El cuerpo de un fallo de OAuth no trae secretos, pero no lo reenviamos entero.
    throw new FactusError({
      status: r.status,
      mensaje: `El proveedor tecnológico rechazó la autenticación: ${datos?.message || datos?.error_description || datos?.error || `HTTP ${r.status}`}`,
      detalle: { error: datos?.error },
    });
  }
  return {
    accessToken: datos.access_token,
    refreshToken: datos.refresh_token || null,
    venceEn: Date.now() + Number(datos.expires_in || 600) * 1000,
  };
}

async function obtenerToken({ forzar = false } = {}) {
  exigirConfiguracion();
  if (!forzar && token && token.venceEn - Date.now() > MARGEN_RENOVACION_MS) return token.accessToken;

  renovando ??= (async () => {
    try {
      let nuevo = null;
      if (token?.refreshToken) {
        try {
          nuevo = await pedirToken({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
        } catch {
          nuevo = null; // refresh caducado o revocado: se cae al password grant
        }
      }
      nuevo ??= await pedirToken({
        grant_type: 'password',
        username: env.factus.username,
        password: env.factus.password,
      });
      token = nuevo;
      return token.accessToken;
    } finally {
      renovando = null;
    }
  })();
  return renovando;
}

/** Olvida el token cacheado (para las pruebas y para forzar un nuevo login). */
export function olvidarToken() {
  token = null;
}

/** Última cifra de `X-RateLimit-Remaining` que devolvió Factus (el sandbox anda por 120/min). */
export let peticionesRestantes = null;

function armarUrl(ruta, query) {
  const url = new URL(`${env.factus.url}${ruta.startsWith('/') ? ruta : `/${ruta}`}`);
  for (const [k, v] of Object.entries(query || {})) {
    // Se descartan vacíos: `undefined` escrito como texto llegaría a Factus como filtro real.
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * Llama a Factus. Devuelve el cuerpo JSON ya parseado (Factus envuelve casi todo
 * en `{ status, message, data }`). Ante un 401 renueva el token y reintenta UNA
 * sola vez; cualquier otro fallo sale como `FactusError`.
 *
 * ⚠️ No reintenta ni los POST ni los timeouts por su cuenta: una emisión
 * repetida con otro `reference_code` duplica un documento fiscal (§5.1 punto 5).
 *
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} metodo
 * @param {string} ruta ej. `/v2/numbering-ranges`
 * @param {object} [cuerpo] se envía como JSON
 * @param {{ query?: object }} [opciones]
 */
export async function request(metodo, ruta, cuerpo, opciones = {}) {
  // Antes de armar la URL: sin FACTUS_URL `new URL` lanzaría un TypeError y el
  // módulo respondería 500 en vez del 503 "no configurado".
  exigirConfiguracion();
  const url = armarUrl(ruta, opciones.query);

  for (let intento = 0; intento < 2; intento++) {
    const accessToken = await obtenerToken({ forzar: intento > 0 });
    const r = await llamar(url, {
      method: metodo,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });

    const restantes = r.headers.get('x-ratelimit-remaining');
    if (restantes !== null) peticionesRestantes = Number(restantes);

    if (r.status === 401 && intento === 0) {
      token = null; // el token que teníamos ya no vale: se pide uno nuevo
      continue;
    }

    const datos = await leerCuerpo(r);
    if (!r.ok) throw errorDeRespuesta(r.status, datos);
    return datos;
  }
  // Inalcanzable: el segundo intento siempre retorna o lanza.
  throw new FactusError({ status: 401, mensaje: 'El proveedor tecnológico rechazó la sesión renovada' });
}
