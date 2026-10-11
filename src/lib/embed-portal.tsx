/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * Contenedor de portales Radix para contextos EMBEBIDOS (WC `ti4go-viewer`).
 *
 * Cura v1.0.2 del gap «portales Radix» (hallazgo Task 59, alcance declarado
 * del baseline v1.0.1): Radix portaliza Sheet/Select a `document.body` —
 * FUERA del shadow root — donde el contenido aparece sin estilos y sin la
 * frontera de encapsulación del visor. Con este provider, `SheetPortal` y
 * `SelectPortal` portan a un div dedicado DENTRO del árbol del shadow
 * (`[data-ti4go-root] > [data-ti4go-portals]`), donde el CSS baseline+chrome
 * del WC sí aplica.
 *
 * Semántica de producto INTACTA: fuera del provider (ruta /) el contexto es
 * `null` ⇒ `container={undefined}` ⇒ Radix usa `document.body` como siempre.
 *
 * Encapsulación respetada: nada de este módulo toca el DOM del anfitrión;
 * el portal vive dentro del shadow root de SU instancia (por-instancia, no
 * un registro global — N instancias con temas distintos no se contaminan).
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface EmbedPortalValue {
  /** Elemento destino de los portales; null = comportamiento Radix por defecto. */
  container: HTMLElement | null;
}

const EmbedPortalContext = createContext<EmbedPortalValue>({ container: null });

/**
 * Contenedor de portal en ESTE árbol de React. `null` fuera del WC embebido
 * (la ruta / y cualquier consumidor React nativo no cambian de comportamiento).
 */
export function useEmbedPortalContainer(): HTMLElement | null {
  return useContext(EmbedPortalContext).container;
}

/**
 * Provider SIN DOM visible: monta un div dedicado (hermano posterior del app)
 * como destino de portales. El selector ancla del baseline
 * `[data-ti4go-root] > .h-\[100dvh\]` sigue cuadrando — el app root div es el
 * PRIMER hijo y este div no participa en la cadena de montaje del lienzo.
 *
 * `useLayoutEffect` (no useEffect): el container queda listo antes de la
 * primera pintura; un Select solo puede abrirse por interacción del usuario,
 * estrictamente después del mount — no hay ventana de carrera.
 */
export function EmbedPortalProvider({ children }: { children: ReactNode }) {
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setContainer(portalRef.current);
    return () => setContainer(null);
  }, []);
  return (
    <EmbedPortalContext.Provider value={{ container }}>
      {children}
      <div ref={portalRef} data-ti4go-portals="" />
    </EmbedPortalContext.Provider>
  );
}
