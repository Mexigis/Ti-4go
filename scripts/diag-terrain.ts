/* Diagnóstico rápido del generador (fuera del bundle de la app) */
import { buildTerrain } from '../src/lib/terrain/generator';
import {
  buildContours,
  DEFAULT_SIMPLIFY_TOL,
  LIGHT_SIMPLIFY_TOL,
} from '../src/lib/terrain/contours';
import { getRegion } from '../src/lib/terrain/regions';

const region = getRegion('soledad');
const t0 = Date.now();
const model = buildTerrain(region);
const t1 = Date.now();
const raw = buildContours(model.grid, { simplifyTol: 0, lightTol: 0 });
const t2 = Date.now();
const simp = buildContours(model.grid); // fina 1 m + ligera 8 m (ATOM-03)
const t3 = Date.now();

console.log('grid:', model.grid.n, 'cell(m):', model.grid.cell.toFixed(1));
console.log('elev min/max:', model.grid.min.toFixed(1), model.grid.max.toFixed(1));
console.log('buildTerrain ms:', t1 - t0);
console.log('buildContours ms (simplifyTol=0, bit-exacto):', t2 - t1);
console.log(`buildContours ms (fina ${DEFAULT_SIMPLIFY_TOL} m + ligera ${LIGHT_SIMPLIFY_TOL} m):`, t3 - t2);
console.log(
  'raw  → levels:', raw.levels.length, 'maestras:', raw.maestraCount,
  'totalSegs:', raw.totalSegs, 'totalPts:', raw.totalPts
);
const gain = ((1 - simp.totalPts / raw.totalPts) * 100).toFixed(1);
console.log(
  'simp → levels:', simp.levels.length, 'maestras:', simp.maestraCount,
  'totalSegs:', simp.totalSegs, 'totalPts:', simp.totalPts, `(-${gain} % puntos)`
);
const maestras = simp.levels.filter((l) => l.maestra);
console.log('segs por maestra (simplificada):', maestras.map((m) => m.segs).join(','));
console.log('polylines por maestra:', maestras.map((m) => m.polys.length).join(','));
const minors = simp.levels.filter((l) => !l.maestra);
console.log('segs por minor (muestra):', minors.slice(0, 12).map((m) => m.segs).join(','));
// ATOM-03: variante ligera (solo niveles menores)
const majorsSegs = maestras.reduce((a, l) => a + l.segs, 0);
const fineMinors = simp.totalSegs - majorsSegs;
const redLight = ((1 - simp.totalSegsLight / fineMinors) * 100).toFixed(1);
console.log(
  'light → minors segs:', simp.totalSegsLight,
  `(−${redLight} % vs fina en menores, tol ${simp.lightTol} m, umbral sub-píxel en el motor)`
);
console.log('stats:', JSON.stringify(model.stats));
