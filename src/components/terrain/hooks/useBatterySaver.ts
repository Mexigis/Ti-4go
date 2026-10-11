/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/* REFACTOR-1 · hook extraído de TerrainViewer (gate triple: suite monótona +
 * smoke 14/14 + E2E dorado — el refactor que rompe el smoke no se mergea).
 *
 * F4 · Battery API (feature-detect): Modo Ahorro automático con batería baja
 * (≤ 20 % y sin cargar). Sin la API (Safari/escritorio headless), el modo
 * sigue disponible manualmente desde Capas. Comportamiento byte-idéntico al
 * bloque inline que vivía en TerrainViewer.tsx (F4). */
import { useEffect, useState } from 'react';

/* Decisión pura del Modo Ahorro automático — extraída para el forense:
 * known-answers sin DOM ni Battery API (frontera 0.2 inclusiva). */
export const shouldBatterySave = (charging: boolean, level: number): boolean =>
  !charging && level <= 0.2;

export function useBatterySaver(): boolean {
  const [battSave, setBattSave] = useState(false);
  useEffect(() => {
    type BatteryLike = EventTarget & { charging: boolean; level: number };
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    if (typeof nav.getBattery !== 'function') return;
    let bat: BatteryLike | null = null;
    let cancelled = false;
    const update = (): void => {
      if (!bat || cancelled) return;
      setBattSave(shouldBatterySave(bat.charging, bat.level));
    };
    nav
      .getBattery()
      .then((b) => {
        if (cancelled) return;
        bat = b;
        b.addEventListener('levelchange', update);
        b.addEventListener('chargingchange', update);
        update();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (bat) {
        bat.removeEventListener('levelchange', update);
        bat.removeEventListener('chargingchange', update);
      }
    };
  }, []);
  return battSave;
}
