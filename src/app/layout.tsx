/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import {
  BENEFICIARIES_LINE,
  BRAND,
  DEVELOPER,
  QUALITY_SEAL,
  SDK_VERSION,
} from "@/lib/branding";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${BRAND} · Microcuencas de Guanajuato — Visor Isométrico de Curvas de Nivel`,
  description:
    "Ti-4GO con sello de calidad MexiGIS · desarrollado por PPcoyente. Canvas interactivo en vista isométrica con curvas de nivel cada 1 m y maestras cada 25 m. Cuenca de la Soledad (predeterminada). Motor determinista sin GPU: solo líneas y vectores, bajo consumo, táctil.",
  applicationName: BRAND,
  keywords: [
    BRAND,
    QUALITY_SEAL,
    DEVELOPER,
    "curvas de nivel",
    "microcuencas",
    "Guanajuato",
    "Cuenca de la Soledad",
    "isométrico",
    "MDT",
    "cartografía",
    "sin GPU",
    "SDK determinista",
  ],
  authors: [{ name: DEVELOPER }],
  creator: DEVELOPER,
  publisher: DEVELOPER,
  other: {
    "mxig:brand": BRAND,
    "mxig:quality-seal": QUALITY_SEAL,
    "mxig:developer": DEVELOPER,
    "mxig:version": SDK_VERSION,
    "mxig:beneficiaries": BENEFICIARIES_LINE,
  },
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: `${BRAND} · Visor isométrico de microcuencas de Guanajuato`,
    description: `Curvas de nivel 1 m / maestras 25 m en isométrico interactivo. Motor determinista sin GPU. Sello de calidad ${QUALITY_SEAL} · Desarrollado por ${DEVELOPER}. Beneficiarios: ${BENEFICIARIES_LINE}.`,
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#181c20", /* token dark.background (design-tokens.json) */
  width: "device-width",
  initialScale: 1,
  /* WCAG 1.4.4/1.4.10 (hallazgo axe `meta-viewport`; fix original 2026-09-27,
     regreso con el rollback del sandbox — re-auditoría D-2/D-4 de 5 vistas
     2026-10-02): el zoom NO se deshabilita — la página es ampliable y
     reflowable. */
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
