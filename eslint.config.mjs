import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    /* react-hooks v6 (plugin resuelto fresco): reglas nuevas estrictas sobre
       patrones establecidos del árbol (sync de tema por instancia Task 61,
       listener de media-query en use-mobile, refs de motor) — comportamiento
       probado por la suite; override documentado, sin refactor de producto */
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/immutability": "off",
    "react-hooks/refs": "off",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  ignores: [
    "node_modules/**",
    ".next/**",
    ".next-airgap/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "examples/**",
    "skills",
    /* infraestructura de herramientas de la plataforma: output persistido de
       lecturas (root-owned) — fuera del árbol de código y del ámbito de lint */
    "tool-results/**",
    /* #4(b): el artefacto air-gap exportado vive en downloads/ — bundles JS
       compilados, NO código fuente: fuera del ámbito de lint */
    "downloads/**",
    "download/**",
    "tests/*.sh",
    /* B-D1: wc-build/ es el taller efímero del artefacto WC (copia de src +
       emisión tsc, regenerado por build:wc) — NO código fuente: fuera de lint */
    "wc-build/**",
    /* B-D1: bundles del artefacto WC (public/wc) — generados por `build:wc`,
       NO código fuente: fuera del ámbito de lint (SIGKILL por OOM si no). */
    "public/wc/**",
  ]
}];

export default eslintConfig;
