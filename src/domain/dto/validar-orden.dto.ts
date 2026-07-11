/**
 * Payload de la Fase B (validación humana → persistencia).
 *
 * Contiene los valores YA corregidos/confirmados por el usuario en el split-view.
 * Son primitivos de frontera (aún sin validar por VO): el caso de uso los pasa a
 * los VO/entidades del dominio, que aplican las invariantes. `camelCase` porque
 * es el contrato con el cliente Angular.
 */
export interface ContactoSstInputDTO {
  readonly nombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
}

export interface ValidarOrdenDTO {
  readonly borradorId: string;
  readonly loteId: string;
  readonly arlId: string;
  readonly codigoCronograma: string;
  readonly secuencia: string;
  readonly nitNic: string | null;
  readonly empresaNombre: string | null;
  readonly actividadEconomica: string | null;
  readonly horasAsignadas: number | null;
  readonly descripcion: string | null;
  readonly contactoSst: ContactoSstInputDTO;
}
