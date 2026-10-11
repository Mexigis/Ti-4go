/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { PrismaClient, type Prisma } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/* Refactor de calidad (Task 62): el volcado de SQL (`log: ['query']`) es
   herramienta de desarrollo — en producción satura stdout, expone metadatos
   de datos en los logs de la plataforma y añade sobrecoste por evento.
   Sin cambio de funcionalidad: el cliente y su comportamiento son idénticos. */
const PRISMA_LOG: Prisma.LogLevel[] =
  process.env.NODE_ENV === 'production' ? [] : ['query'];

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: PRISMA_LOG,
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
