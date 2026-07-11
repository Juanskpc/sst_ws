/**
 * Barrel público de la CAPA DE DOMINIO del módulo de Importación de OS.
 *
 * Regla de dependencia: este paquete NO importa Express, Prisma, OpenAI/Gemini
 * ni ningún detalle de infraestructura. Solo tipos, VO, entidades y políticas
 * puras. Las capas de aplicación/infraestructura dependen de él, nunca al revés.
 */
export * from './shared/index.js';
export * from './enums/index.js';
export * from './errors/index.js';
export * from './value-objects/index.js';
export * from './policies/index.js';
export * from './dto/index.js';
export * from './entities/index.js';
