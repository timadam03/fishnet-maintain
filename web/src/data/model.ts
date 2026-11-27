/**
 * Domain types and net-grid geometry shared by the simulator, the risk model and every view.
 *
 * The net of each pen is split into cells by angle around the pen (x) and depth (y),
 * following "Grid the net" in the preventive-damage concept. Wall rows come first,
 * then the bottom cone rings.
 */

export const ANGLE_SECTORS = 24; // 15° each
export const SECTOR_DEG = 360 / ANGLE_SECTORS;
export const WALL_ROWS = 8; // 0–20 m in 2.5 m bands
export const CONE_ROWS = 3; // 20–30 m cone
export const ROWS = WALL_ROWS + CONE_ROWS;
export const CELLS = ROWS * ANGLE_SECTORS;
export const WALL_DEPTH_M = 20;
export const CONE_TIP_M = 30;
export const PEN_RADIUS_M = 25; // ~157 m circumference

export const HISTORY_DAYS = 90;
export const FORECAST_DAYS = 7;
export const DAYS = HISTORY_DAYS + FORECAST_DAYS;
/** Day index of "now". Days after it are forecast. */
export const TODAY = HISTORY_DAYS - 1;
export const TODAY_DATE = new Date('2026-11-27T12:00:00Z');

/** Scripted events in the demo timeline (day indices). */
export const STORM_PAST_DAY = 59;
export const STORM_FORECAST_DAY = 93;
export const DELOUSING_DAY = 70;
export const DELOUSING_PEN_IDS = [3, 4];

/** Coverage older than this is shown as stale (hatched), never as a colour. */
export const STALE_AFTER_DAYS = 14;

export type LayerId = 'risk' | 'condition' | 'fouling' | 'oxygen' | 'temperature' | 'contact' | 'cleaning' | 'coverage';

export const cellIndex = (row: number, col: number): number => row * ANGLE_SECTORS + col;
export const cellRow = (cell: number): number => Math.floor(cell / ANGLE_SECTORS);
export const cellCol = (cell: number): number => cell % ANGLE_SECTORS;
export const isCone = (cell: number): boolean => cellRow(cell) >= WALL_ROWS;

/** Depth range of a row in metres. */
export function rowDepth(row: number): [number, number] {
  if (row < WALL_ROWS) {
    const band = WALL_DEPTH_M / WALL_ROWS;
    return [row * band, (row + 1) * band];
  }
  const band = (CONE_TIP_M - WALL_DEPTH_M) / CONE_ROWS;
  const r = row - WALL_ROWS;
  return [WALL_DEPTH_M + r * band, WALL_DEPTH_M + (r + 1) * band];
}

export function colAngle(col: number): [number, number] {
  return [col * SECTOR_DEG, (col + 1) * SECTOR_DEG];
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Human label for a cell, e.g. "10–12.5 m, 135–150°". */
export function cellLabel(cell: number): string {
  const [d0, d1] = rowDepth(cellRow(cell));
  const [a0, a1] = colAngle(cellCol(cell));
  return `${fmt(d0)}–${fmt(d1)} m, ${a0}–${a1}°`;
}

export function dayDate(day: number): Date {
  return new Date(TODAY_DATE.getTime() + (day - TODAY) * 86_400_000);
}

export function dayLabel(day: number): string {
  return dayDate(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export interface Pen {
  id: number;
  name: string;
  /** Position on the site map in metres from the site origin. */
  x: number;
  y: number;
  netId: string;
  /** Day index the current net went in (negative = before the shown history). */
  netInstalledDay: number;
  material: string;
  fishCount: number;
  /** Angle where service boats and wellboats come alongside. */
  boatSideAngle: number;
  /** Days between routine cleanings, and the cleaning-day offset. */
  cleaningEvery: number;
  cleaningOffset: number;
  passesPerCleaning: number;
}

export interface SiteEnv {
  /** Current speed in cm/s per day. */
  currentSpeed: Float32Array;
  /** Direction the current flows towards, degrees (0 = north, clockwise). */
  currentDir: Float32Array;
  waveHeight: Float32Array;
  surfaceTemp: Float32Array;
}

export type OperationKind = 'cleaning' | 'delousing' | 'wellboat' | 'net-change' | 'storm';

export interface Operation {
  day: number;
  penId: number | null;
  kind: OperationKind;
  label: string;
}

export type FindingKind = 'fraying' | 'chafe' | 'distortion' | 'hole';
export type FindingStatus = 'unreviewed' | 'confirmed' | 'rejected' | 'work-order' | 'repaired' | 'verified';

export interface FindingStep {
  day: number;
  status: FindingStatus;
  note: string;
}

export interface Finding {
  id: number;
  penId: number;
  cell: number;
  kind: FindingKind;
  side: 'outside' | 'inside';
  detectedDay: number;
  /** For holes: the day the hole actually opened (simulation truth). */
  openedDay?: number;
  confidence: number;
  severity: 'critical' | 'warning';
  steps: FindingStep[];
}

/** Per-pen simulation output. Arrays are indexed [day * CELLS + cell]. */
export interface PenSim {
  coating: Float32Array; // coating wear 0..1
  fray: Float32Array; // fraying / thinning 0..1 (1 = twine broken)
  distortion: Float32Array; // mesh distortion 0..1
  repairs: Uint8Array; // number of repairs in the cell so far
  fouling: Float32Array; // fouling cover 0..1
  load: Float32Array; // relative current + drag load, ~0..3
  /** Running totals, indexed [(day + 1) * CELLS + cell]; row 0 is all zeros. Window sums are cum[d] - cum[d - n]. */
  contactCum: Float32Array; // net-to-weight contact hours
  cleaningCum: Float32Array; // cleaning passes
  holeOpen: Uint8Array; // 1 while a hole is open (truth)
  lastSeen: Int16Array; // day the cell was last inspected, -1 = never
}

export interface World {
  siteName: string;
  pens: Pen[];
  env: SiteEnv;
  operations: Operation[];
  /** One simulation per pen, in the same order as `pens`. */
  sims: PenSim[];
  findings: Finding[];
}
