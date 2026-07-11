import type {
  CampoCrudo,
  ContactoSstCrudo,
  MetadatosExtraccion,
} from '../../domain/dto/metadatos-extraccion.dto.js';
import type {
  CampoVistaPrevia,
  CamposVistaPrevia,
  ContactoSstVistaPrevia,
} from '../../domain/dto/vista-previa-borrador.dto.js';
import { NivelConfianza } from '../../domain/enums/nivel-confianza.enum.js';
import { PuntajeConfianza } from '../../domain/value-objects/puntaje-confianza.vo.js';

/**
 * Enriquece la extracción cruda (`MetadatosExtraccion`) con nivel de confianza y
 * marca de revisión por campo, para alimentar el split-view (M3). Reutiliza el
 * VO `PuntajeConfianza` (una sola fuente de los umbrales de badge, sin duplicar).
 */

function enriquecerCampo<T>(campo: CampoCrudo<T>, umbral: number): CampoVistaPrevia<T> {
  const puntaje = PuntajeConfianza.crear(campo.confidence);
  if (puntaje.ok) {
    return {
      value: campo.value,
      confidence: puntaje.valor.valor,
      nivel: puntaje.valor.nivel(),
      requiereRevision: puntaje.valor.requiereRevision(umbral),
    };
  }
  // Defensa en profundidad: no debería ocurrir tras la validación Zod.
  return {
    value: campo.value,
    confidence: campo.confidence,
    nivel: NivelConfianza.BAJA,
    requiereRevision: true,
  };
}

function enriquecerContacto(
  contacto: ContactoSstCrudo,
  umbral: number,
): ContactoSstVistaPrevia {
  return {
    nombre: enriquecerCampo(contacto.nombre, umbral),
    telefono: enriquecerCampo(contacto.telefono, umbral),
    correo: enriquecerCampo(contacto.correo, umbral),
  };
}

export interface VistaPreviaCalculada {
  readonly campos: CamposVistaPrevia;
  readonly requiereRevision: boolean;
  readonly confianzaGeneral: number | null;
}

/** Calcula la proyección de vista previa a partir de los metadatos y el umbral. */
export function calcularVistaPrevia(
  metadatos: MetadatosExtraccion,
  umbral: number,
): VistaPreviaCalculada {
  const campos: CamposVistaPrevia = {
    codigo_cronograma: enriquecerCampo(metadatos.codigo_cronograma, umbral),
    secuencia: enriquecerCampo(metadatos.secuencia, umbral),
    nit_nic: enriquecerCampo(metadatos.nit_nic, umbral),
    empresa_nombre: enriquecerCampo(metadatos.empresa_nombre, umbral),
    actividad_economica: enriquecerCampo(metadatos.actividad_economica, umbral),
    horas_asignadas: enriquecerCampo(metadatos.horas_asignadas, umbral),
    contacto_sst: enriquecerContacto(metadatos.contacto_sst, umbral),
    descripcion: enriquecerCampo(metadatos.descripcion, umbral),
  };

  const c = campos;
  const requiereRevision =
    c.codigo_cronograma.requiereRevision ||
    c.secuencia.requiereRevision ||
    c.nit_nic.requiereRevision ||
    c.empresa_nombre.requiereRevision ||
    c.actividad_economica.requiereRevision ||
    c.horas_asignadas.requiereRevision ||
    c.contacto_sst.nombre.requiereRevision ||
    c.contacto_sst.telefono.requiereRevision ||
    c.contacto_sst.correo.requiereRevision ||
    c.descripcion.requiereRevision;

  return { campos, requiereRevision, confianzaGeneral: metadatos.overall_confidence };
}
