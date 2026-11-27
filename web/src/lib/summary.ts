/** Per-pen and site-level summaries for a given day, derived from the layer grids. */
import { ANGLE_SECTORS, CELLS, STALE_AFTER_DAYS, cellCol, type World } from '../data/model';
import { coverageAge, riskScore } from '../data/risk';

export interface PenSummary {
  penIndex: number;
  maxRisk: number;
  maxCell: number;
  /** Highest risk per angle sector (over all depths), for the ring on the site map. */
  sectorRisk: Float32Array;
  /** 1 if any cell in the sector is stale. */
  sectorStale: Uint8Array;
  risk: Float32Array;
  seenWeekPct: number;
}

export function summarisePen(world: World, penIndex: number, day: number): PenSummary {
  const sim = world.sims[penIndex];
  const risk = new Float32Array(CELLS);
  const sectorRisk = new Float32Array(ANGLE_SECTORS);
  const sectorStale = new Uint8Array(ANGLE_SECTORS);
  let maxRisk = 0;
  let maxCell = 0;
  let seenWeek = 0;
  for (let c = 0; c < CELLS; c++) {
    const r = riskScore(sim, c, day);
    risk[c] = r;
    const col = cellCol(c);
    if (r > sectorRisk[col]) sectorRisk[col] = r;
    if (r > maxRisk) {
      maxRisk = r;
      maxCell = c;
    }
    const age = coverageAge(sim, c, day);
    if (age === null || age > STALE_AFTER_DAYS) sectorStale[col] = 1;
    if (age !== null && age <= 7) seenWeek++;
  }
  return { penIndex, maxRisk, maxCell, sectorRisk, sectorStale, risk, seenWeekPct: seenWeek / CELLS };
}

export interface RiskArea {
  penIndex: number;
  cell: number;
  score: number;
}

/** Top risk areas across the site; neighbouring cells are merged and each pen gets at most `perPen` entries. */
export function topRiskAreas(summaries: PenSummary[], n: number, perPen = 2): RiskArea[] {
  const all: RiskArea[] = [];
  for (const s of summaries) for (let c = 0; c < CELLS; c++) all.push({ penIndex: s.penIndex, cell: c, score: s.risk[c] });
  all.sort((a, b) => b.score - a.score);
  const picked: RiskArea[] = [];
  for (const a of all) {
    if (picked.length >= n) break;
    const samePen = picked.filter((p) => p.penIndex === a.penIndex);
    if (samePen.length < perPen && !samePen.some((p) => isNear(p.cell, a.cell))) picked.push(a);
  }
  return picked;
}

function isNear(a: number, b: number): boolean {
  const ra = Math.floor(a / ANGLE_SECTORS);
  const rb = Math.floor(b / ANGLE_SECTORS);
  const dc = Math.abs(cellCol(a) - cellCol(b));
  return Math.abs(ra - rb) <= 1 && Math.min(dc, ANGLE_SECTORS - dc) <= 1;
}

export interface RiskShare {
  elevated: Float32Array;
  high: Float32Array;
  critical: Float32Array;
}

/** Share of net area (0..1) at each risk level per day, over the given pens. */
export function riskShareSeries(world: World, penIndices: number[], days: number): RiskShare {
  const out: RiskShare = { elevated: new Float32Array(days), high: new Float32Array(days), critical: new Float32Array(days) };
  const total = penIndices.length * CELLS;
  for (let d = 0; d < days; d++) {
    let e = 0;
    let h = 0;
    let c = 0;
    for (const p of penIndices) {
      const sim = world.sims[p];
      for (let cell = 0; cell < CELLS; cell++) {
        const r = riskScore(sim, cell, d);
        if (r >= 0.7) c++;
        else if (r >= 0.5) h++;
        else if (r >= 0.25) e++;
      }
    }
    out.elevated[d] = e / total;
    out.high[d] = h / total;
    out.critical[d] = c / total;
  }
  return out;
}
