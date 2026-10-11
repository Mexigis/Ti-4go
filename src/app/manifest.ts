/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MetadataRoute } from 'next';

/* FR-8 · export estático (vehículo-A, S2): la ruta del manifest es 100 %
   estática — obligatorio para output: export (build air-gap). */
export const dynamic = 'force-static';

/**
 * FR-8 · manifiesto PWA mínimo (instalabilidad, spec §3.3).
 * Servido en /manifest.webmanifest; entra al precache del vehículo air-gap
 * (whitelist del SW). Sin URLs externas — todo local (S1/autocontenido).
 * Icono: logo.svg de la casa (§5: solo tooling existente, 0 deps nuevas).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Ti-4GO · Microcuencas de Guanajuato',
    short_name: 'Ti-4GO',
    description:
      'Visor isométrico de curvas de nivel 1 m — motor determinista sin GPU, air-gap.',
    start_url: '/',
    display: 'standalone',
    background_color: '#181c20',
    theme_color: '#181c20',
    icons: [
      {
        src: '/logo.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
