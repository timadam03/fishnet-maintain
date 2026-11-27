/**
 * Map layers: what each one shows, how its values are computed per net cell, and its colour scale.
 * One colour scale per layer. Red and amber are reserved for hole risk; every other magnitude
 * layer uses a single blue ramp, so warm colours always mean "risk".
 */
import { CELLS, STALE_AFTER_DAYS, type LayerId, type PenSim, type World } from '../data/model';
import { coverageAge, riskScore, windowSum } from '../data/risk';
import { waterAt } from '../data/water';
import { waterRamp, color, ageRamp, damageRamp, riskStops, bioRamp } from './tokens';

export interface LayerDef {
  id: LayerId;
  label: string;
  unit: string;
  source: string;
  min: number;
  max: number;
  /** Stale or never-inspected cells get hatched instead of a confident colour. */
  hatchStale: boolean;
  /** Fit the colour scale to the values shown (with a minimum span), for layers whose daily spread is small. */
  fitToData?: { minSpan: number };
  format: (v: number) => string;
  color: (v: number) => string;
  legend: Array<{ value: number; label: string }>;
}


function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(r1 + (r2 - r1) * k)},${Math.round(g1 + (g2 - g1) * k)},${Math.round(b1 + (b2 - b1) * k)})`;
}

function ramp(stops: string[], t: number): string {
  const k = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(k));
  return mix(stops[i], stops[i + 1], k - i);
}

/** Continuous heat: neutral when calm (a quiet screen when all is well), through sand and amber to deep red. */
export function riskColor(score: number): string {
  const s = Math.max(0, Math.min(1, score));
  for (let i = 1; i < riskStops.length; i++) {
    const [v1, c1] = riskStops[i];
    const [v0, c0] = riskStops[i - 1];
    if (s <= v1) return mix(c0, c1, (s - v0) / (v1 - v0));
  }
  return riskStops[riskStops.length - 1][1];
}

/** Light (low) to dark (high) on a given ramp; `invert` makes the low end darkest (e.g. low oxygen). */
const scale = (stops: readonly string[], min: number, max: number, invert = false) => (v: number) => {
  const t = (v - min) / (max - min);
  return ramp([...stops], invert ? 1 - t : t);
};
const waterScale = (min: number, max: number) => scale(waterRamp, min, max);

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export const LAYERS: LayerDef[] = [
  {
    id: 'risk',
    label: 'Hole risk',
    unit: '/100',
    source: 'Risk model: condition × exposure × consequence',
    min: 0,
    max: 1,
    hatchStale: true,
    format: (v) => `${Math.round(v * 100)}`,
    color: riskColor,
    legend: [
      { value: 0.1, label: 'Low' },
      { value: 0.3, label: 'Elevated 25+' },
      { value: 0.55, label: 'High 50+' },
      { value: 0.8, label: 'Critical 70+' },
    ],
  },
  {
    id: 'condition',
    label: 'Wear',
    unit: '',
    source: 'Robot camera: fraying, mesh distortion, coating wear (last inspection)',
    min: 0,
    max: 1,
    hatchStale: true,
    format: (v) => v.toFixed(2),
    color: scale(damageRamp, 0, 0.8),
    legend: [
      { value: 0.05, label: 'New' },
      { value: 0.4, label: 'Worn' },
      { value: 0.8, label: 'Very worn' },
    ],
  },
  {
    id: 'fouling',
    label: 'Fouling',
    unit: '%',
    source: 'Robot camera + fouling growth model',
    min: 0,
    max: 1,
    hatchStale: false,
    format: pct,
    color: scale(bioRamp, 0, 0.7),
    legend: [
      { value: 0, label: '0%' },
      { value: 0.35, label: '35%' },
      { value: 0.7, label: '70%+' },
    ],
  },
  {
    id: 'oxygen',
    label: 'Oxygen',
    unit: '% sat',
    source: 'Sensor string (5 depths) + drone readings, interpolated',
    min: 60,
    max: 100,
    hatchStale: false,
    format: (v) => `${Math.round(v)}%`,
    // Low oxygen is the notable end, so it gets the brightest colour.
    color: scale(waterRamp, 60, 100, true),
    legend: [
      { value: 60, label: '≤60%' },
      { value: 80, label: '80%' },
      { value: 100, label: '100%' },
    ],
  },
  {
    id: 'temperature',
    label: 'Temperature',
    unit: '°C',
    source: 'Sensor string (5 depths) + drone readings, interpolated',
    min: 6,
    max: 15,
    hatchStale: false,
    fitToData: { minSpan: 1 },
    format: (v) => `${v.toFixed(1)}°C`,
    color: waterScale(6, 15),
    legend: [
      { value: 6, label: '6°C' },
      { value: 10.5, label: '10.5°C' },
      { value: 15, label: '15°C' },
    ],
  },
  {
    id: 'contact',
    label: 'Weight contact',
    unit: 'h / 30 d',
    source: 'Sonar + net simulation: hours touching sinker tube, chains or ropes',
    min: 0,
    max: 60,
    hatchStale: false,
    format: (v) => `${Math.round(v)} h`,
    color: scale(damageRamp, 0, 60),
    legend: [
      { value: 0, label: '0 h' },
      { value: 30, label: '30 h' },
      { value: 60, label: '60 h+' },
    ],
  },
  {
    id: 'cleaning',
    label: 'Cleaning',
    unit: 'passes / 30 d',
    source: 'Cleaning-rig logs',
    min: 0,
    max: 14,
    hatchStale: false,
    format: (v) => `${Math.round(v)} passes`,
    color: scale(damageRamp, 0, 14),
    legend: [
      { value: 0, label: '0' },
      { value: 7, label: '7' },
      { value: 14, label: '14+' },
    ],
  },
  {
    id: 'coverage',
    label: 'Last seen',
    unit: 'days ago',
    source: 'Swarm inspection log',
    min: 0,
    max: STALE_AFTER_DAYS,
    hatchStale: true,
    format: (v) => `${Math.round(v)} d ago`,
    color: scale(ageRamp, 0, STALE_AFTER_DAYS),
    legend: [
      { value: 0, label: 'Today' },
      { value: 7, label: '7 d' },
      { value: STALE_AFTER_DAYS, label: `${STALE_AFTER_DAYS} d+ (hatched)` },
    ],
  },
];

export const layerById = (id: LayerId): LayerDef => LAYERS.find((l) => l.id === id) ?? LAYERS[0];

/** For `fitToData` layers: the same layer with its scale and legend fitted to the values in `grid`. */
export function fitLayer(layer: LayerDef, values: Float32Array): LayerDef {
  if (!layer.fitToData) return layer;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo)) return layer;
  const mid = (lo + hi) / 2;
  const half = Math.max(hi - lo, layer.fitToData.minSpan) / 2;
  const min = Math.floor((mid - half) * 2) / 2;
  const max = Math.ceil((mid + half) * 2) / 2;
  return {
    ...layer,
    min,
    max,
    color: waterScale(min, max),
    legend: [min, (min + max) / 2, max].map((v) => ({ value: v, label: layer.format(v) })),
    source: `${layer.source}. Scale fitted to this day`,
  };
}

export interface LayerGrid {
  values: Float32Array;
  /** 1 where the value rests on stale or missing inspection data. */
  stale: Uint8Array;
}

/** Values of one layer for every cell of a pen on a given day. */
export function computeLayerGrid(world: World, penIndex: number, day: number, layer: LayerId): LayerGrid {
  const sim: PenSim = world.sims[penIndex];
  const penId = world.pens[penIndex].id;
  const values = new Float32Array(CELLS);
  const stale = new Uint8Array(CELLS);
  for (let c = 0; c < CELLS; c++) {
    const age = coverageAge(sim, c, day);
    stale[c] = age === null || age > STALE_AFTER_DAYS ? 1 : 0;
    const at = sim.lastSeen[day * CELLS + c];
    switch (layer) {
      case 'risk':
        values[c] = riskScore(sim, c, day);
        break;
      case 'condition':
        values[c] = at < 0 ? NaN : Math.min(1, 0.5 * sim.fray[at * CELLS + c] + 0.3 * sim.distortion[at * CELLS + c] + 0.2 * sim.coating[at * CELLS + c]);
        break;
      case 'fouling':
        values[c] = sim.fouling[day * CELLS + c];
        break;
      case 'oxygen':
        values[c] = waterAt(world, penId, c, day).oxygen;
        break;
      case 'temperature':
        values[c] = waterAt(world, penId, c, day).temperature;
        break;
      case 'contact':
        values[c] = windowSum(sim.contactCum, day, c, 30);
        break;
      case 'cleaning':
        values[c] = windowSum(sim.cleaningCum, day, c, 30);
        break;
      case 'coverage':
        values[c] = age === null ? NaN : age;
        break;
    }
  }
  return { values, stale };
}

/** Colour for a cell; unknown values render as the empty surface (and get hatched by the caller). */
export function cellColor(layer: LayerDef, v: number): string {
  return Number.isNaN(v) ? color.unknown : layer.color(v);
}
