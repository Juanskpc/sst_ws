/**
 * Identificadores de dominio con *branded types*.
 *
 * Aunque en la base de datos todos son `UUID`, tiparlos como tipos distintos
 * evita bugs silenciosos (p. ej. pasar un `ArlId` donde se espera un
 * `OrdenServicioId`). En tiempo de ejecución siguen siendo `string`.
 */

declare const marca: unique symbol;

/** Marca nominal para diferenciar `string`s equivalentes en tiempo de compilación. */
export type Marca<T, M extends string> = T & { readonly [marca]: M };

export type Uuid = Marca<string, 'Uuid'>;
export type UsuarioId = Marca<string, 'UsuarioId'>;
export type ProfesionalId = Marca<string, 'ProfesionalId'>;
export type ArlId = Marca<string, 'ArlId'>;
export type LoteImportacionId = Marca<string, 'LoteImportacionId'>;
export type BorradorExtraccionId = Marca<string, 'BorradorExtraccionId'>;
export type OrdenServicioId = Marca<string, 'OrdenServicioId'>;

const PATRON_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** *Type guard* que verifica el formato UUID v1-v5. */
export const esUuid = (valor: string): valor is Uuid => PATRON_UUID.test(valor);

/**
 * Marca un `string` ya validado como un identificador tipado.
 * El casteo se concentra aquí (frontera de infraestructura/repositorios),
 * no se dispersa por el dominio.
 */
export const comoId = <M extends string>(valor: string): Marca<string, M> =>
  valor as Marca<string, M>;
