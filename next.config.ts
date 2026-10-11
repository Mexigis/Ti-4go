import type { NextConfig } from "next";

/* #4 opción (b) — build air-gap con distDir AISLADO (checkpoint del
   directriz del propietario; prioridad elevada por independencia
   de custodia respecto de la continuidad del sandbox).
   AIRGAP_EXPORT=1 ⇒ export estático puro:
     - distDir propio (.next-airgap): el build NUNCA toca .next del dev server
     - output: "export" ⇒ HTML/JS/CSS estáticos, sin servidor Node
     - images.unoptimized: requerido por output export
     - NEXT_PUBLIC_AIRGAP=1 ⇒ la UI degrada /api/ingest (bitácora no disp.)
   La ruta /api/ingest se RETIENE durante el build (scripts/build_airgap.sh
   la mueve a .airgap-held y la restaura con trap EXIT): «degradación
   /api/ingest» aprobada — el artefacto excluye el endpoint y la UI lo
   declara en lugar de fallar. */
const AIRGAP = process.env.AIRGAP_EXPORT === "1";

const nextConfig: NextConfig = AIRGAP
  ? {
      output: "export",
      distDir: process.env.AIRGAP_DISTDIR ?? ".next-airgap",
      images: { unoptimized: true },
      env: { NEXT_PUBLIC_AIRGAP: "1" },
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
      devIndicators: false,
    }
  : {
      output: "standalone",
      typescript: {
        ignoreBuildErrors: true,
      },
      reactStrictMode: false,
      devIndicators: false,
      /* R-02 (roadmap atómico): silencia el aviso «Cross origin request detected
         from … to /_next/* resource» del sandbox de vista previa (gateway). Array
         seguro: localhost + dominios del preview (comodín de subdominios). */
      allowedDevOrigins: ["localhost:3000", "127.0.0.1:3000"],
      /* Refactor de calidad (Task 62) — cabeceras defensivas SIN impacto
         funcional (auditoría Task 60, hallazgo M-3): nosniff evita el
         sniffing de MIME; Referrer-Policy acota la fuga de URLs internas.
         Deliberadamente AUSENTES: X-Frame-Options / frame-ancestors (el
         embed /embed ES una función del producto — se embebe en hosts
         externos), CSP (requiere tuning con nonce; riesgo de romper el
         viewer) y HSTS (la terminación TLS vive en el gateway, no aquí).
         NOTA: la rama air-gap (output: "export") NO soporta headers(). */
      async headers() {
        return [
          {
            source: "/:path*",
            headers: [
              { key: "X-Content-Type-Options", value: "nosniff" },
              { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
            ],
          },
        ];
      },
    };

export default nextConfig;
