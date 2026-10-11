/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Definición de regiones (ANP / microcuencas del municipio de Guanajuato).
 *
 * Datos de referencia verificados:
 *  - Cuenca de la Soledad: ANP estatal, superficie 2,782.01 ha, decreto 18/08/2006
 *    (SMAOT Guanajuato). Junto con la Cuenca de la Esperanza abastece ~40 % del
 *    agua de la ciudad de Guanajuato. Rango altitudinal de referencia ~2,000–2,300 m.
 *  - El resto de superficies son aproximadas y se marcan con `areaApprox`.
 *
 * IMPORTANTE: el relieve es un MODELO PROCEDURAL calibrado a la altitud y
 * extensión de referencia; no sustituye al MDN de INEGI ni levantamientos LIDAR.
 */

export interface BasinDef {
  /** Nombre de la subcuenca / microcuenca */
  name: string;
  /** Centro en metros (origen = centro de la región) */
  cx: number;
  cy: number;
  /** Radio medio del borde divisorio en metros */
  r: number;
  /** Acimut de salida del cauce principal (rad, 0 = este, horario) */
  outletAz: number;
}

export interface RegionDef {
  id: string;
  name: string;
  subtitle: string;
  /** Coordenadas reales aproximadas del centro (WGS84) */
  centerLon: number;
  centerLat: number;
  /** Superficie oficial o aproximada en hectáreas */
  areaHa: number;
  areaApprox: boolean;
  /** Rango altitudinal de referencia (m s.n.m.) */
  elevMin: number;
  elevMax: number;
  /** Ancho del recorte del modelo en metros */
  extent: number;
  /** Semilla procedural (determinista) */
  seed: number;
  /** Nombre del punto de salida / embalse principal */
  outletName: string;
  basins: BasinDef[];
  notes: string[];
  official?: boolean;
}

export const REGIONS: RegionDef[] = [
  {
    id: 'soledad',
    name: 'Cuenca de la Soledad',
    subtitle: 'ANP · Municipio de Guanajuato (predeterminada)',
    centerLon: -101.3248,
    centerLat: 21.0518,
    areaHa: 2782.01,
    areaApprox: false,
    official: true,
    elevMin: 2000,
    elevMax: 2545,
    extent: 6400,
    seed: 20240613,
    outletName: 'Presa La Soledad',
    basins: [
      { name: 'Subcuenca Presa La Soledad', cx: -500, cy: 350, r: 1650, outletAz: 3.6 },
      { name: 'Subcuenca Sierra Poniente', cx: 1450, cy: -450, r: 1250, outletAz: 2.9 },
      { name: 'Subcuenca Cañada Norte', cx: -1500, cy: -1250, r: 1150, outletAz: 1.4 },
      { name: 'Subcuenca El Mirador', cx: 900, cy: 1500, r: 950, outletAz: 2.2 },
    ],
    notes: [
      'Superficie oficial: 2,782.01 ha (SMAOT, decreto 18/08/2006).',
      'Abastece ~40 % del agua de la ciudad junto con la Cuenca de la Esperanza.',
      'Rango altitudinal de referencia: ~2,000–2,300 m s.n.m.',
      'Marco cartográfico INEGI: las cartas F14C43D4, F14C43E3, F14C53A2 y F14C53B1 (MTN 1:50 000) abarcan toda la zona de estudio.',
    ],
  },
  {
    id: 'esperanza',
    name: 'Cuenca de la Esperanza',
    subtitle: 'ANP · Municipio de Guanajuato',
    centerLon: -101.2265,
    centerLat: 20.997,
    areaHa: 4366,
    areaApprox: true,
    elevMin: 2050,
    elevMax: 2600,
    extent: 7200,
    seed: 77701,
    outletName: 'Presa La Esperanza',
    basins: [
      { name: 'Subcuenca Presa La Esperanza', cx: -200, cy: 100, r: 1800, outletAz: 3.5 },
      { name: 'Subcuenca Poniente', cx: -1400, cy: -1400, r: 1150, outletAz: 2.6 },
      { name: 'Subcuenca Oriente', cx: 1500, cy: 1100, r: 1200, outletAz: 1.2 },
    ],
    notes: [
      'Superficie aproximada (consultar SMAOT para cifra oficial).',
      'Presa hermana de La Soledad dentro del sistema de abastecimiento de la ciudad.',
    ],
  },
  {
    id: 'bufa',
    name: 'Cerro de la Bufa · El Sireno',
    subtitle: 'ANP · Sierra de Guanajuato',
    centerLon: -101.3785,
    centerLat: 20.9877,
    areaHa: 1830,
    areaApprox: true,
    elevMin: 2150,
    elevMax: 2860,
    extent: 5600,
    seed: 424242,
    outletName: 'Cauce intermitente SW',
    basins: [
      { name: 'Subcuenca La Bufa', cx: -100, cy: 100, r: 1500, outletAz: 3.0 },
      { name: 'Subcuenca Cañada Honda', cx: 1200, cy: -900, r: 1050, outletAz: 1.6 },
      { name: 'Subcuenca El Sireno', cx: -1100, cy: 1000, r: 950, outletAz: 2.3 },
    ],
    notes: [
      'Zona de montaña con las mayores elevaciones de la Sierra de Guanajuato (~2,850 m).',
      'Superficie aproximada.',
    ],
  },
  {
    id: 'santarosa',
    name: 'Sierra de Santa Rosa',
    subtitle: 'ANP · Municipio de Guanajuato',
    centerLon: -101.4463,
    centerLat: 21.0775,
    areaHa: 11600,
    areaApprox: true,
    elevMin: 2050,
    elevMax: 2720,
    extent: 9200,
    seed: 910913,
    outletName: 'Arroyo Santa Rosa',
    basins: [
      { name: 'Subcuenca Santa Rosa', cx: 0, cy: 200, r: 1900, outletAz: 3.3 },
      { name: 'Subcuenca La Cañada', cx: -1700, cy: -1300, r: 1400, outletAz: 1.3 },
      { name: 'Subcuenca El Durazno', cx: 1600, cy: -800, r: 1300, outletAz: 2.7 },
      { name: 'Subcuenca Mesa Alta', cx: 600, cy: 1800, r: 1100, outletAz: 2.0 },
    ],
    notes: [
      'Cadena montañosa al poniente de la ciudad; recarga de acuíferos.',
      'Superficie aproximada.',
    ],
  },
];

export function getRegion(id: string): RegionDef {
  return REGIONS.find((r) => r.id === id) ?? REGIONS[0];
}
