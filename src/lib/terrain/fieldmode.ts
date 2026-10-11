/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-6 · PRESET «MODO CAMPO» — módulo PURO del lienzo embebible.
 *
 * Spec: docs/fr-specs/FR-6-modo-campo-preset.md (Task 49-a, R-A) · P2 por
 * checkpoint re-entrada  (paso 5, orquestación P2/P3).
 * Gates G-1..G-6: se aplican las opciones RECOMENDADAS de la spec; el
 * propietario puede ratificar o enmendar en el próximo checkpoint.
 *
 * Frontera de producto (línea divisoria , ítem 3):
 * el preset vive DENTRO del lienzo; jamás define navegación, rutas ni
 * identidad visual de la app contenedora.
 *
 * Restricciones verificadas en suite (tests/forense_fieldmode.test.ts):
 *   A-1  preset congelado, known-answer, merge determinista, bloqueados.
 *   A-6  mapeo de fallback → badge persistente (R-4).
 *   A-8  0 red: ni aquí ni en FieldBar.tsx (test estático).
 *   W5   0 GPU: solo flags declarativos del motor; el rasterizador es
 *        Canvas 2D y no se toca.
 *
 * 0 dependencias React · 0 timers · 0 red · determinista.
 */
import type { ViewOpts } from './engine';

/** R-2 · target táctil mínimo del chrome de campo (44 px CSS ≈ 9 mm). */
export const FIELD_TARGET_PX = 44 as const;

/**
 * Preset CONGELADO (known-answer A-1). Valores según spec §5:
 *   eink:true        → papel #ffffff + tinta negra (D11, «fotocopiable»).
 *                      BLOQUEADO: la legibilidad solar no se negocia.
 *   powerSave:true   → DPR 1 + tope 30 cps (F3/F4). BLOQUEADO: la energía
 *                      en campo no se negocia; el automático por batería
 *                      queda como refuerzo.
 *   reliefFx:false   → tinta pura, menos CPU (sin sombra F5-01 ni niebla).
 *   mesh/nodes:false → ruido de tinta a sol (reactivables: el usuario opera
 *                      los toggles con normalidad tras la activación — el
 *                      preset SIEMBRA el estado, no lo congela salvo los
 *                      bloqueados).
 *   minor/major/streams/divides/labels/cotas/inegi:true → información de
 *                      misión intacta (seguridad de brigada).
 *   forcedStep:0     → LOD automático intacto (nunca degrada el intervalo
 *                      en modo forzado; el presupuesto lo gestiona el LOD).
 */
export const FIELD_PRESET: Readonly<Partial<ViewOpts>> = Object.freeze({
  eink: true,
  powerSave: true,
  reliefFx: false,
  mesh: false,
  nodes: false,
  minor: true,
  major: true,
  streams: true,
  divides: true,
  labels: true,
  cotas: true,
  inegi: true,
  forcedStep: 0,
} as const);

/**
 * Opciones NO sobre-escribibles en campo (ni por fieldOpts del embedder ni
 * por toggles: re-forzadas en vuelo desde el viewer — R-1/R-3).
 */
export const FIELD_BLOCKED_OPTS: ReadonlyArray<keyof ViewOpts> = Object.freeze([
  'eink',
  'powerSave',
]);

/**
 * R-4 · Badge PERSISTENTE del fallback de tramas (texto sin tecnicismos,
 * G-6 propuesto). Un toast único (TOAST_LIMIT=1) puede ser reemplazado por
 * otro: el badge es el canal que no se calla.
 */
export const FIELD_FALLBACK_BADGE = 'Tramas: solo export' as const;

/** ¿Hay fallback de tramas activo (hachure o fricción)? (A-6, test unitario). */
export function fieldHasFallback(
  hachureFallback: '' | 'guard' | 'frame',
  frictionFallback: '' | 'guard' | 'frame'
): boolean {
  return hachureFallback !== '' || frictionFallback !== '';
}

/**
 * Merge del preset (función PURA, A-1):
 *   resultado = base(usuario) ⊕ FIELD_PRESET ⊕ fieldOpts(embedder, no bloqueados)
 * con eink/powerSave fijados al valor del preset contra CUALQUIER override.
 *
 * Semántica de activación (spec §4/§5): el viewer aplica esta función UNA
 * VEZ al entrar en campo (el preset SIEMBRA el estado); después el usuario
 * opera los toggles con normalidad — salvo los bloqueados, que el viewer
 * re-fuerza en cada cómputo de effOpts. Determinista: misma entrada ⇒
 * misma salida (JSON igual).
 */
export function applyFieldPreset(
  base: ViewOpts,
  fieldOpts?: Partial<ViewOpts>
): ViewOpts {
  const blocked = new Set<string>(FIELD_BLOCKED_OPTS as ReadonlyArray<string>);
  const merged: ViewOpts = { ...base, ...FIELD_PRESET };
  if (fieldOpts) {
    for (const k of Object.keys(fieldOpts) as Array<keyof ViewOpts>) {
      if (blocked.has(k)) continue;
      const v = fieldOpts[k];
      if (v !== undefined) {
        (merged as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  return merged;
}
