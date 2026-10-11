/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-8 · lectura tipada de la custodia embebida (spec §3.3, S6).
 *
 * `public/custodia.json` lo ESCRIBE el build air-gap (pin del HEAD — enlaza
 * repo-manifiesto + cadena snapshot). En dev/estudio no existe ⇒ null
 * (honesto: sin custodia que mostrar, jamás un pin inventado).
 */
export interface Custodia {
  /** Pin corto (12 hex) del HEAD — = nombre de caché activo `ti4go-a-<pin>`. */
  pin: string;
  /** HEAD completo (40 hex). */
  head: string;
  /** Sello UTC del build (ISO-8601). */
  stampUtc: string;
  /** Generador declarado (p. ej. «Ti-4GO SDK v1.0.0»). */
  generator: string;
}

export async function loadCustodia(): Promise<Custodia | null> {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch('/custodia.json');
    if (!res.ok) return null;
    const raw = (await res.json()) as Partial<Custodia>;
    if (
      typeof raw.pin !== 'string' ||
      typeof raw.head !== 'string' ||
      typeof raw.stampUtc !== 'string' ||
      typeof raw.generator !== 'string'
    ) {
      return null; /* forma incompleta = sin custodia válida */
    }
    return { pin: raw.pin, head: raw.head, stampUtc: raw.stampUtc, generator: raw.generator };
  } catch {
    return null; /* dev / archivo ausente / offline-first falla ⇒ honesto null */
  }
}
