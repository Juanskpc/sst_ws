import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient como singleton (una conexión por proceso). La configuración de
 * conexión sale de `DATABASE_URL` (env), no del código.
 */
let instancia: PrismaClient | null = null;

export function obtenerPrismaClient(): PrismaClient {
  if (instancia === null) {
    instancia = new PrismaClient();
  }
  return instancia;
}
