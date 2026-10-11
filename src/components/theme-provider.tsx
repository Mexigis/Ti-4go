/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * ThemeProvider — bridge de next-themes para el sistema dual Dark/Day
 * (design-tokens.json v1.0.0).
 *
 * Estrategia de CLASE en <html> (classes «dark» | «day»): los tokens del
 * modo se aplican vía globals.css (`:root, .dark` y `.day`). Dark es el
 * modo por defecto y determinista (operación crítica nocturna); Day es
 * explícito (campo abierto, alta luz). Sin preferencia de sistema: el
 * visor no deja la paleta al azar del dispositivo.
 */

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      themes={['dark', 'day']}
      defaultTheme="dark"
      enableSystem={false}
      storageKey="ti4go-theme"
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
