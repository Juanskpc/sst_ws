import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';

import { OrderImportSchema, validarOrdenImportada } from '../../validation/index.js';
import { ExtraccionFallidaError } from '../../domain/errors/ordenes.errors.js';
import {
  type LoggerPort,
  silentLogger,
} from '../../application/ports/logger.port.js';
import type {
  DocumentExtractorPort,
  OrderImportResult,
} from '../../application/ports/document-extractor.port.js';
import type { OpenAIExtractionConfig } from './openai-extraction.config.js';
import {
  SYSTEM_PROMPT_EXTRACCION,
  construirMensajeUsuario,
} from './prompts/system-extraccion.prompt.js';

/** Nombre del esquema en Structured Outputs (visible en la request a OpenAI). */
const NOMBRE_ESQUEMA = 'orden_importada';

/** Dependencias del servicio (inyección por constructor → SOLID/DIP, testeable). */
export interface OpenAIExtractionDeps {
  readonly config: OpenAIExtractionConfig;
  /** Logger opcional; por defecto no emite nada (seguro para librerías). */
  readonly logger?: LoggerPort;
  /** Cliente OpenAI opcional; permite inyectar un doble en tests. */
  readonly client?: OpenAI;
}

/**
 * Servicio de extracción de OS contra OpenAI (GPT-4o-mini + Structured Outputs).
 *
 * Reutilizable y sin efectos colaterales de I/O más allá de la llamada al modelo:
 * recibe `textoPlano`, devuelve un `OrderImportResult` ya validado. No lee
 * archivos, no toca HTTP ni la BD. El timeout y los reintentos con backoff los
 * gestiona el SDK oficial (configurados abajo); los fallos se devuelven como
 * `ExtraccionFallidaError`, nunca se propagan como excepción al llamador.
 */
export class OpenAIExtractionService implements DocumentExtractorPort {
  private readonly client: OpenAI;
  private readonly config: OpenAIExtractionConfig;
  private readonly logger: LoggerPort;

  constructor(deps: OpenAIExtractionDeps) {
    this.config = deps.config;
    this.logger = deps.logger ?? silentLogger;
    this.client =
      deps.client ??
      new OpenAI({
        apiKey: this.config.apiKey,
        timeout: this.config.timeoutMs, // por-request; el SDK aborta y reintenta
        maxRetries: this.config.maxRetries, // backoff exponencial en 408/409/429/5xx
      });
  }

  async extraer(textoPlano: string): Promise<OrderImportResult> {
    const texto = (textoPlano ?? '').trim();
    if (texto.length === 0) {
      return this.fallo('El texto de entrada está vacío.', undefined, 0);
    }

    const inicio = Date.now();
    this.logger.info('extraccion.inicio', {
      modelo: this.config.modelo,
      longitudTexto: texto.length,
    });

    try {
      const completion = await this.client.chat.completions.parse({
        model: this.config.modelo,
        temperature: this.config.temperature,
        max_completion_tokens: this.config.maxTokensRespuesta,
        response_format: zodResponseFormat(OrderImportSchema, NOMBRE_ESQUEMA),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_EXTRACCION },
          { role: 'user', content: construirMensajeUsuario(texto) },
        ],
      });

      const latenciaMs = Date.now() - inicio;
      const choice = completion.choices[0];

      if (!choice) {
        return this.fallo('La respuesta de OpenAI no contiene resultados.', undefined, latenciaMs);
      }
      // Truncamiento por límite de tokens (caso típico de descripciones largas).
      if (choice.finish_reason === 'length') {
        return this.fallo(
          'La respuesta se truncó por el límite de tokens (posible descripción muy larga).',
          undefined,
          latenciaMs,
        );
      }
      if (choice.finish_reason === 'content_filter') {
        return this.fallo('La respuesta fue bloqueada por el filtro de contenido.', undefined, latenciaMs);
      }
      if (choice.message.refusal) {
        return this.fallo(`El modelo rechazó la solicitud: ${choice.message.refusal}`, undefined, latenciaMs);
      }

      const parsed = choice.message.parsed;
      if (!parsed) {
        return this.fallo('La respuesta no pudo parsearse al esquema esperado.', undefined, latenciaMs);
      }

      // Validación explícita del resultado (defensa en profundidad, con nuestros mensajes).
      const validacion = validarOrdenImportada(parsed);
      if (!validacion.ok) {
        return this.fallo(
          'El resultado del modelo no cumple el esquema de extracción.',
          validacion.errores,
          latenciaMs,
        );
      }

      const meta = {
        modelo: completion.model,
        latenciaMs,
        tokensPrompt: completion.usage?.prompt_tokens ?? null,
        tokensRespuesta: completion.usage?.completion_tokens ?? null,
      };
      this.logger.info('extraccion.exito', {
        ...meta,
        overallConfidence: validacion.datos.overall_confidence,
      });
      return { ok: true, data: validacion.datos, meta };
    } catch (causa) {
      return this.manejarExcepcion(causa, Date.now() - inicio);
    }
  }

  /** Traduce excepciones del SDK a un `ExtraccionFallidaError` con motivo claro. */
  private manejarExcepcion(causa: unknown, latenciaMs: number): OrderImportResult {
    let motivo: string;
    if (causa instanceof OpenAI.APIConnectionTimeoutError) {
      motivo = 'Se agotó el tiempo de espera al llamar a OpenAI.';
    } else if (causa instanceof OpenAI.RateLimitError) {
      motivo = 'Se alcanzó el límite de tasa de OpenAI.';
    } else if (causa instanceof OpenAI.AuthenticationError) {
      motivo = 'Credenciales de OpenAI inválidas.';
    } else if (causa instanceof OpenAI.APIConnectionError) {
      motivo = 'No fue posible conectar con OpenAI.';
    } else if (causa instanceof OpenAI.APIError) {
      motivo = `Error de la API de OpenAI (status ${causa.status ?? 'desconocido'}).`;
    } else {
      motivo = 'Error inesperado durante la extracción.';
    }
    return this.fallo(motivo, causa, latenciaMs);
  }

  /** Construye, registra y devuelve un resultado fallido. */
  private fallo(motivo: string, causa: unknown, latenciaMs: number): OrderImportResult {
    const error = new ExtraccionFallidaError(motivo, causa);
    this.logger.error('extraccion.error', {
      motivo,
      latenciaMs,
      causa: causa instanceof Error ? causa.message : causa ?? null,
    });
    return { ok: false, error };
  }
}
