/**
 * Hole-risk model per net cell: Risk = Condition × Exposure × Consequence.
 *
 * Condition comes from what the robots last *saw* in the cell (so stale coverage means stale
 * condition). Exposure comes from sensors and logs that are always current (contact, cleaning,
 * current load, fouling). Consequence comes from depth and fish density. Every score returns
 * the factors that produced it, so the UI can always explain it. Weights are illustrative.
 */
import { fishDensity } from './simulate';
import {
  CELLS,
  STALE_AFTER_DAYS,
  TODAY,
  WALL_ROWS,
  cellRow,
  rowDepth,
  type PenSim,
} from './model';

export type RiskLevel = 'low' | 'elevated' | 'high' | 'critical';

export const RISK_LEVELS: Array<{ level: RiskLevel; min: number; label: string }> = [
  { level: 'low', min: 0, label: 'Low' },
  { level: 'elevated', min: 0.25, label: 'Elevated' },
  { level: 'high', min: 0.5, label: 'High' },
  { level: 'critical', min: 0.7, label: 'Critical' },
];

export function riskLevel(score: number): RiskLevel {
  if (score >= 0.7) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'elevated';
  return 'low';
}

/** Scales C×E×K (which rarely exceeds ~0.4) onto 0..1 so that 0.7 means "act now". */
const SCALE = 2.8;

/** Condition assumed for a never-inspected cell: an average used net, flagged as unknown. */
const PRIOR = { coating: 0.3, fray: 0.15, distortion: 0.05 };

export interface RiskFactor {
  group: 'condition' | 'exposure' | 'consequence';
  label: string;
  /** Share of its group's value (0..1), used for the bar in the explanation. */
  weight: number;
}

export interface CellRisk {
  score: number;
  level: RiskLevel;
  condition: number;
  exposure: number;
  consequence: number;
  factors: RiskFactor[];
  /** Days since the cell was last inspected; null if never. */
  coverageAge: number | null;
  stale: boolean;
  /** Uncertainty band for the score. */
  range: [number, number];
  predicted: boolean;
  knownHole: boolean;
  recommendation: string;
}

export function windowSum(cum: Float32Array, day: number, cell: number, days: number): number {
  const hi = (day + 1) * CELLS + cell;
  const lo = Math.max(0, day + 1 - days) * CELLS + cell;
  return cum[hi] - cum[lo];
}

export function coverageAge(sim: PenSim, cell: number, day: number): number | null {
  const seen = sim.lastSeen[day * CELLS + cell];
  return seen < 0 ? null : day - seen;
}

interface Components {
  coating: number;
  fray: number;
  distortion: number;
  repairs: number;
  contact30: number;
  cleaning30: number;
  load: number;
  fouling: number;
  knownHole: boolean;
  seenDay: number;
}

function components(sim: PenSim, cell: number, day: number): Components {
  const seenDay = sim.lastSeen[day * CELLS + cell];
  const at = seenDay * CELLS + cell;
  const observed = seenDay >= 0;
  return {
    coating: observed ? sim.coating[at] : PRIOR.coating,
    fray: observed ? sim.fray[at] : PRIOR.fray,
    distortion: observed ? sim.distortion[at] : PRIOR.distortion,
    repairs: observed ? sim.repairs[at] : 0,
    knownHole: observed && sim.holeOpen[at] === 1,
    contact30: windowSum(sim.contactCum, day, cell, 30),
    cleaning30: windowSum(sim.cleaningCum, day, cell, 30),
    load: sim.load[day * CELLS + cell],
    fouling: sim.fouling[day * CELLS + cell],
    seenDay,
  };
}

function conditionTerms(c: Components): number[] {
  return [0.1, 0.25 * c.coating, 0.5 * c.fray, 0.35 * c.distortion, 0.08 * Math.min(c.repairs, 2)];
}

function exposureTerms(c: Components): number[] {
  return [
    0.08,
    0.45 * Math.min(1, c.contact30 / 50),
    0.2 * Math.min(1, c.cleaning30 / 14),
    0.22 * Math.min(1, c.load / 3),
    0.1 * c.fouling,
  ];
}

export function consequenceOf(cell: number): number {
  const row = cellRow(cell);
  return row < WALL_ROWS ? 0.55 + 0.45 * fishDensity(row) : 0.65;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Fast path for heatmaps: the score only. */
export function riskScore(sim: PenSim, cell: number, day: number): number {
  const c = components(sim, cell, day);
  if (c.knownHole) return 1;
  const cond = Math.min(1, sum(conditionTerms(c)));
  const exp = Math.min(1, sum(exposureTerms(c)));
  return Math.min(1, SCALE * cond * exp * consequenceOf(cell));
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Full explanation for one cell: score, factors, uncertainty and a recommended action. */
export function explainRisk(sim: PenSim, cell: number, day: number): CellRisk {
  const c = components(sim, cell, day);
  const age = c.seenDay < 0 ? null : day - c.seenDay;
  const stale = age === null || age > STALE_AFTER_DAYS;
  const predicted = day > TODAY;

  const condTerms = conditionTerms(c);
  const expTerms = exposureTerms(c);
  const condition = Math.min(1, sum(condTerms));
  const exposure = Math.min(1, sum(expTerms));
  const consequence = consequenceOf(cell);
  const score = c.knownHole ? 1 : Math.min(1, SCALE * condition * exposure * consequence);

  // Change since the inspection before the last one: the strongest early signal.
  let distortionDelta = 0;
  let frayDelta = 0;
  if (c.seenDay > 0) {
    const prev = sim.lastSeen[(c.seenDay - 1) * CELLS + cell];
    if (prev >= 0) {
      distortionDelta = c.distortion - sim.distortion[prev * CELLS + cell];
      frayDelta = c.fray - sim.fray[prev * CELLS + cell];
    }
  }

  const seenNote = age === null ? 'never inspected, assumed average' : `seen ${age} d ago`;
  const trend = (d: number): string => (Math.abs(d) < 0.02 ? '' : `, ${d > 0 ? '+' : ''}${d.toFixed(2)} since previous inspection`);
  const [d0, d1] = rowDepth(cellRow(cell));
  const factors: RiskFactor[] = [
    { group: 'condition', label: `Fraying or thinning ${c.fray.toFixed(2)} (${seenNote}${trend(frayDelta)})`, weight: condTerms[2] / condition },
    { group: 'condition', label: `Mesh distortion ${c.distortion.toFixed(2)}${trend(distortionDelta)}`, weight: condTerms[3] / condition },
    { group: 'condition', label: `Coating wear ${pct(c.coating)}`, weight: condTerms[1] / condition },
    { group: 'condition', label: c.repairs > 0 ? `${c.repairs} earlier repair${c.repairs > 1 ? 's' : ''} (patch edges are weak points)` : 'No earlier repairs', weight: condTerms[4] / condition },
    { group: 'exposure', label: `Contact with weights/chains ${Math.round(c.contact30)} h in 30 d`, weight: expTerms[1] / exposure },
    { group: 'exposure', label: `${Math.round(c.cleaning30)} cleaning passes in 30 d`, weight: expTerms[2] / exposure },
    { group: 'exposure', label: `Current + drag load ${c.load.toFixed(1)}× nominal${predicted ? ' (forecast)' : ''}`, weight: expTerms[3] / exposure },
    { group: 'exposure', label: `Fouling cover ${pct(c.fouling)}`, weight: expTerms[4] / exposure },
    { group: 'consequence', label: `${d0}–${d1} m: fish density ${pct(cellRow(cell) < WALL_ROWS ? fishDensity(cellRow(cell)) : 0.4)} of peak`, weight: 1 },
  ];

  const halfWidth = 0.03 + (age === null ? 0.3 : Math.min(0.3, age * 0.012)) + (predicted ? (day - TODAY) * 0.02 : 0);
  const range: [number, number] = [Math.max(0, score - halfWidth), Math.min(1, score + halfWidth)];

  return {
    score,
    level: riskLevel(score),
    condition,
    exposure,
    consequence,
    factors,
    coverageAge: age,
    stale,
    range,
    predicted,
    knownHole: c.knownHole,
    recommendation: recommend(c, score, stale, age, expTerms, predicted),
  };
}

function recommend(c: Components, score: number, stale: boolean, age: number | null, expTerms: number[], predicted: boolean): string {
  if (c.knownHole) return 'Repair now and report the escape risk. Check neighbouring meshes for tears.';
  // Old or missing data is never treated as "all clear".
  if (stale) {
    return `Sample more: send a drone to inspect this cell (${age === null ? 'never inspected' : `data ${age} d old`}).`;
  }
  if (score < 0.25) return 'No action. Keep routine coverage.';
  const [, contact, cleaning, load] = expTerms;
  const dominant = Math.max(contact, cleaning, load);
  if (dominant === contact) return 'Close inspection within 48 h. Check weight and sinker-tube clearance.';
  if (dominant === cleaning) return 'Reduce cleaning pressure or reroute the cleaning rig in this area.';
  if (predicted) return 'Reinforce or repair before the forecast storm peaks.';
  return 'Close inspection of mesh distortion on the current-facing side.';
}
