/**
 * Puerto de almacenamiento de archivos. Abstrae de dónde salen los bytes
 * (S3, disco local, memoria en tests). El caso de uso "lee el archivo" a través
 * de esta interfaz, sin conocer el sistema de ficheros ni el proveedor.
 */
export interface FileStoragePort {
  /** Devuelve el contenido binario del archivo referenciado (key/ruta). */
  leer(referencia: string): Promise<Uint8Array>;
}
