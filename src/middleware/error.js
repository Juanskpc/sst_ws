import { HttpError } from '../utils/httpError.js';

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
  // Multer u otros.
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: `Error de archivo: ${err.message}` });
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
