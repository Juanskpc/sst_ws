import { z } from 'zod';
import { formatearErroresZod } from '../../validation/validation-result.js';

/**
 * Configuración del servicio de extracción OpenAI. Se resuelve desde variables de
 * entorno (nunca `process.env` disperso por el código) y se valida al arranque
 * (fail-fast): si falta o es inválida, el proceso no debe levantar.
 */
export interface OpenAIExtractionConfig {
  readonly apiKey: string;
  readonly modelo: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly temperature: number;
  readonly maxTokensRespuesta: number;
}

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, { error: 'OPENAI_API_KEY es obligatoria.' }),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  OPENAI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  OPENAI_MAX_TOKENS: z.coerce.number().int().positive().default(4_096),
});

/**
 * Carga y valida la configuración desde el entorno.
 * @throws Error con mensajes claros si la configuración es inválida.
 */
export function cargarConfigOpenAIExtraccion(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIExtractionConfig {
  const resultado = EnvSchema.safeParse(env);
  if (!resultado.success) {
    const detalle = formatearErroresZod(resultado.error)
      .map((e) => `${e.campo}: ${e.mensaje}`)
      .join('; ');
    throw new Error(`Configuración de OpenAI inválida → ${detalle}`);
  }
  const v = resultado.data;
  return {
    apiKey: v.OPENAI_API_KEY,
    modelo: v.OPENAI_MODEL,
    timeoutMs: v.OPENAI_TIMEOUT_MS,
    maxRetries: v.OPENAI_MAX_RETRIES,
    temperature: v.OPENAI_TEMPERATURE,
    maxTokensRespuesta: v.OPENAI_MAX_TOKENS,
  };
}
