/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

import { useEffect, useState } from 'react';
import { loadCustodia, type Custodia } from '@/lib/pwa/custodia';

/**
 * FR-8 · S6 — pin de custodia visible («Acerca de», spec §3.6.5).
 *
 * Se monta en el footer de estudio; en dev/custodia-ausente renderiza null
 * (honesto: sin pin inventado). 0 timers: una lectura al montar.
 * En campo el pin es auditable offline vía `caches.keys()` y el LEEME sellado.
 */
export function CustodiaPin(): React.ReactNode {
  const [custodia, setCustodia] = useState<Custodia | null>(null);

  useEffect(() => {
    let vivo = true;
    void loadCustodia().then((c) => {
      if (vivo) setCustodia(c);
    });
    return () => {
      vivo = false;
    };
  }, []);

  if (!custodia) return null;
  return (
    <span className="text-[10px] text-muted-foreground" title={custodia.head}>
      custodia {custodia.pin} · {custodia.generator} · {custodia.stampUtc}
    </span>
  );
}
