import { HttpError } from '../utils/httpError.js';
import { LIMITE_ARCHIVO_MB, MAXIMO_SOPORTES } from './upload.js';

/**
 * Los errores de multer llegan en inglés y en jerga de librería ("File too
 * large", "Unexpected field"), y así se estaban mostrando en pantalla al
 * usuario final. Aquí se traducen a lo que la persona necesita saber: qué pasó,
 * cuál es el límite y qué hacer a continuación.
 */
const MULTER = {
  LIMIT_FILE_SIZE: () =>
    `El archivo pesa más de ${LIMITE_ARCHIVO_MB} MB y no se puede subir. ` +
    'Si es una foto, tómela con menos resolución; si es un PDF escaneado, ' +
    'escanéelo en blanco y negro o divídalo en dos y súbalos por separado.',
  LIMIT_FILE_COUNT: () =>
    `Son demasiados archivos a la vez (máximo ${MAXIMO_SOPORTES}). Súbalos en dos tandas.`,
  LIMIT_UNEXPECTED_FILE: (err) =>
    `El archivo llegó en una casilla que no existe${err.field ? ` ("${err.field}")` : ''}. ` +
    'Recargue la página e inténtelo de nuevo.',
  LIMIT_PART_COUNT: () => 'El formulario trae demasiados campos. Recargue la página e inténtelo de nuevo.',
  LIMIT_FIELD_COUNT: () => 'El formulario trae demasiados campos. Recargue la página e inténtelo de nuevo.',
  LIMIT_FIELD_KEY: () => 'Un campo del formulario tiene un nombre demasiado largo.',
  LIMIT_FIELD_VALUE: () => 'Un campo del formulario trae un texto demasiado largo.',
};

/** Traduce errores de PostgreSQL / dominio a respuestas HTTP limpias. */
export function errorHandler(err, _req, res, _next) {
  // Errores de dominio lanzados por la función cambiar_estado_orden y checks.
  //
  // El mensaje va tal cual: lo escribe la función de dominio pensando en el
  // administrador ("Transición de estado inválida: PROGRAMADA → EJECUTADA.").
  // Antes se recortaba todo lo anterior al primer ": ", que era justamente la
  // parte que explicaba el problema y dejaba en pantalla solo "PROGRAMADA →
  // EJECUTADA.".
  if (err.code === 'P0001' || err.routine === 'exec_stmt_raise') {
    return res.status(409).json({ error: err.message });
  }
  // Valor fuera del enum (p.ej. un estado que no existe en EST-01). Es un dato
  // malo del cliente, no una falla del servidor: 400 con el valor recibido.
  if (err.code === '22P02') {
    const m = /invalid input value for enum \w+: "(.*)"/.exec(err.message || '');
    return res.status(400).json({
      error: m ? `Valor no válido: "${m[1]}".` : 'Valor no válido en la solicitud.',
    });
  }
  // Violación de unicidad (p.ej. dedup IMP-09, correo o documento duplicado).
  // Se traduce el detail de Postgres ("Key (correo)=(x@y.com) already exists.")
  // a un mensaje específico y legible para el usuario final.
  if (err.code === '23505') {
    const NOMBRES = {
      correo: 'el correo',
      documento_identidad: 'el documento de identidad',
      'arl_id, codigo_cronograma, secuencia': 'la combinación ARL + cronograma + secuencia',
    };
    const m = /Key \((.+?)\)=\((.+?)\)/.exec(err.detail || '');
    let mensaje = 'Registro duplicado';
    if (m) {
      mensaje = m[1] === 'es_maestro'
        ? 'Ya existe un Administrador Maestro en el sistema'
        : `Registro duplicado: ${NOMBRES[m[1]] || `el campo ${m[1]}`} "${m[2]}" ya está registrado`;
    }
    return res.status(409).json({ error: mensaje, detail: err.detail });
  }
  // FK inválida: se apunta a un registro que no existe (o se borra uno que
  // todavía está referenciado).
  //
  // Antes esto respondía "Referencia inválida" a secas y era inservible: no
  // decía QUÉ registro ni DESDE DÓNDE, así que quien lo veía en pantalla no
  // tenía forma de saber si el problema era suyo o del sistema. Postgres sí lo
  // sabe —viene en `detail` y en `constraint`—, solo había que traducirlo.
  if (err.code === '23503') {
    // 'Key (profesional_asignado_id)=(abc) is not present in table "profesionales".'
    const m = /Key \((.+?)\)=\((.+?)\) is not present in table "(.+?)"/.exec(err.detail || '');
    const usado = /still referenced from table "(.+?)"/.exec(err.detail || '');
    let mensaje;
    if (m) {
      mensaje = `El campo "${CAMPOS[m[1]] || m[1]}" apunta a un registro que ya no existe ` +
                `(${m[3]} ${m[2]}). Recargue la página: probablemente se eliminó mientras trabajaba.`;
    } else if (usado) {
      mensaje = `No se puede eliminar: todavía hay registros de "${usado[1]}" que lo usan.`;
    } else {
      mensaje = 'Referencia inválida: un dato apunta a un registro que no existe.';
    }
    // Al log completo: el mensaje al usuario es legible, pero para depurar hace
    // falta saber la restricción exacta y la operación que la disparó.
    console.error('[error 23503]', err.constraint, '·', err.table, '·', err.detail);
    return res.status(400).json({ error: mensaje, detail: err.detail, constraint: err.constraint });
  }
  // NOT NULL: falta un campo obligatorio. Decir cuál.
  if (err.code === '23502') {
    console.error('[error 23502]', err.table, err.column, err.detail);
    return res.status(400).json({
      error: `Falta un dato obligatorio: "${CAMPOS[err.column] || err.column}".`,
    });
  }
  // CHECK del dominio (rangos de horas, franjas invertidas…).
  if (err.code === '23514') {
    console.error('[error 23514]', err.constraint, err.detail);
    return res.status(400).json({
      error: `El dato no cumple una regla del sistema (${err.constraint}). Revise los valores enviados.`,
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }
  // Subida de archivos (multer).
  if (err.name === 'MulterError') {
    const humano = MULTER[err.code];
    // El código sí se registra: es lo que permite reconocer el caso en el log
    // cuando alguien reporta "no me deja subir".
    console.warn('[upload]', err.code, err.field || '');
    return res.status(413).json({
      error: humano ? humano(err) : 'No se pudo subir el archivo. Verifique el formato y el tamaño, e inténtelo de nuevo.',
    });
  }
  // Cuerpo de la petición demasiado grande (lo corta Express, no multer).
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({
      error: `Lo que intenta enviar supera el tamaño máximo (${LIMITE_ARCHIVO_MB} MB por archivo). ` +
             'Suba los archivos de a uno o redúzcalos antes de enviarlos.',
    });
  }
  // JSON mal formado: casi siempre una petición cortada a medias.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'La solicitud llegó incompleta o dañada. Recargue la página e inténtelo de nuevo.',
    });
  }
  // La base de datos no responde. Un 500 con referencia hacía buscar en el log
  // un fallo de programación que no existe: lo que pasa es que el servicio no
  // está disponible, y la respuesta correcta es reintentar.
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', '08000', '08003', '08006', '57P01', '57P03'].includes(err.code)) {
    console.error('[bd] sin conexión:', err.code, err.message);
    return res.status(503).json({
      error: 'El sistema no puede conectarse a la base de datos en este momento. ' +
             'Espere unos segundos y vuelva a intentarlo; si sigue igual, avise al equipo técnico.',
    });
  }
  // Consulta cancelada por tiempo (57014): el dato existe, pero tardó demasiado.
  if (err.code === '57014') {
    return res.status(504).json({
      error: 'La consulta tardó demasiado y se canceló. Reduzca el rango de fechas o los filtros e inténtelo de nuevo.',
    });
  }
  // Texto más largo de lo que admite la columna.
  if (err.code === '22001') {
    return res.status(400).json({
      error: 'Uno de los textos enviados es más largo de lo permitido. Acórtelo e inténtelo de nuevo.',
    });
  }
  // Fecha u hora que no se puede interpretar.
  if (err.code === '22007' || err.code === '22008') {
    return res.status(400).json({
      error: 'Una fecha no tiene un formato válido. Use el selector de fecha o escríbala como DD/MM/AAAA.',
    });
  }
  // Último recurso. Se registra TODO en el servidor y al usuario se le da una
  // referencia con la que poder buscarlo en el log: "Error interno" a secas
  // obliga a reconstruir lo ocurrido a partir de la memoria de quien lo vio.
  const ref = Date.now().toString(36).toUpperCase().slice(-6);
  console.error(`[error 500 · ref ${ref}]`, err);
  res.status(500).json({
    error: `Error interno del servidor (referencia ${ref}). ` +
           'Vuelva a intentarlo; si persiste, reporte esa referencia.',
  });
}

/** Nombres de columna → cómo se llaman en pantalla. */
const CAMPOS = {
  profesional_asignado_id: 'profesional asignado',
  empresa_id: 'empresa',
  arl_id: 'ARL',
  lote_importacion_id: 'lote de importación',
  orden_servicio_id: 'orden de servicio',
  orden_id: 'orden de servicio',
  usuario_id: 'usuario',
  cambiado_por: 'usuario que hace el cambio',
  creado_por: 'usuario que crea el registro',
  duplicado_de: 'orden duplicada',
  contacto_sst_correo: 'correo del contacto SST',
  fecha_vencimiento: 'fecha de vencimiento',
  horas_asignadas: 'horas asignadas',
};
