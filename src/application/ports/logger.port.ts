/**
 * Puerto de logging estructurado (inyectable). Mantiene el servicio desacoplado
 * de cualquier librería concreta (Pino/Winston) y lo hace testeable.
 */
export interface LogContexto {
  readonly [clave: string]: unknown;
}

export interface LoggerPort {
  debug(mensaje: string, contexto?: LogContexto): void;
  info(mensaje: string, contexto?: LogContexto): void;
  warn(mensaje: string, contexto?: LogContexto): void;
  error(mensaje: string, contexto?: LogContexto): void;
}

/** Logger nulo: por defecto una librería no debe ensuciar la salida del host. */
export const silentLogger: LoggerPort = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Logger de conveniencia a consola en formato JSON (una línea por evento). */
export const consoleLogger: LoggerPort = {
  debug: (mensaje, contexto) =>
    console.debug(JSON.stringify({ nivel: 'debug', mensaje, ...contexto })),
  info: (mensaje, contexto) =>
    console.info(JSON.stringify({ nivel: 'info', mensaje, ...contexto })),
  warn: (mensaje, contexto) =>
    console.warn(JSON.stringify({ nivel: 'warn', mensaje, ...contexto })),
  error: (mensaje, contexto) =>
    console.error(JSON.stringify({ nivel: 'error', mensaje, ...contexto })),
};
