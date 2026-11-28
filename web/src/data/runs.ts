/**
 * Recorded Isaac Sim runs, replayed in the dashboard as data (see INTEGRATION.md).
 *
 * A run bundle is a folder in `public/runs/<run_id>/`, built by `npm run pack-run` from the sim's
 * output folders. `public/runs/index.json` lists the bundles. Everything here is plain data (no
 * three.js), so it can be tested and used by any view.
 */
import { ANGLE_SECTORS, SECTOR_DEG, WALL_DEPTH_M, WALL_ROWS, PEN_RADIUS_M } from './model';

export const RUN_BUNDLE_VERSION = 1;

/** One entry of `public/runs/index.json`. */
export interface RunIndexEntry {
  run_id: string;
  kind: 'sweep' | 'plan';
  pen_id: number;
  /** ISO time the bundle was packed. */
  packed_at: string;
}

/** `manifest.json` of a run bundle. Paths are relative to the bundle folder; null when not in the run. */
export interface RunManifest {
  version: number;
  run_id: string;
  /** A coverage sweep, or a run that flew a decision-layer plan. */
  kind: 'sweep' | 'plan';
  /** Dashboard pen the sim pen stands for. */
  pen_id: number;
  plan_id: string | null;
  /** Size of the simulated pen; positions are scaled from this onto the dashboard pen. */
  cage: { radius_m: number; depth_m: number };
  duration_s: number;
  robots: Array<{ index: number; name: string; feed: string | null }>;
  /** Hanging ropes and hoses in the sim pen: x, y (m, sim frame) and radius (m). */
  obstacles: Array<[number, number, number]>;
  views: { orbit: string | null; section: string | null; grid: string | null };
  /** Folder of the inspection photos, laid out as in the run (`auv_k/img_NNNN.png`), or null. */
  photos: string | null;
  files: {
    telemetry: string | null;
    captures: string;
    vision: string | null;
    plan: string | null;
    plan_status: string | null;
    nav_summary: string | null;
    ground_truth: string | null;
  };
  /**
   * Where the telemetry came from: the sim's own recording, or rebuilt from the photo positions
   * (coarse, for runs recorded without `--record`).
   */
  telemetry_source: 'recorded' | 'captures' | null;
}

/** Telemetry downsampled to a fixed rate, one array per field (index = sample). */
export interface RunTelemetry {
  hz: number;
  t: number[];
  rov: Array<{
    /** Sim frame, metres: x, y horizontal, z up (negative under water). */
    pos: Array<[number, number, number]>;
    yaw: number[];
    /** 1 while the HOCBF safety filter is changing the command. */
    filter: number[];
    /** Clearance to the nearest obstacle, net or other ROV (m). */
    clr: number[];
    contacts: number[];
    shots: number[];
  }>;
  /** Photo events: time and ROV index. */
  shots: Array<{ t: number; rov: number }>;
}

/** One inspection photo (`captures.jsonl`, contract §1). */
export interface RunCapture {
  image: string;
  auv: number;
  sim_time: number;
  theta_deg: number;
  depth: number;
  position: [number, number, number];
  cell: number;
  target_id?: string;
  viewpoint?: number;
  visit?: number;
}

/** One image report (`vision.jsonl`, contract §2). */
export interface VisionReport {
  image: string;
  model: string;
  quality?: { visibility?: number; sharpness?: number };
  fouling_pct?: number;
  detections: Array<{ class: string; confidence: number; bbox?: [number, number, number, number]; severity?: string; size_m?: number; crop?: string }>;
  heatmap?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === 'string';

/** Checks a parsed `manifest.json`; throws with the first problem found. */
export function parseManifest(raw: unknown): RunManifest {
  const fail = (what: string): never => {
    throw new Error(`Invalid run manifest: ${what}`);
  };
  if (!isObject(raw)) return fail('not an object');
  if (raw.version !== RUN_BUNDLE_VERSION) fail(`version ${String(raw.version)}, expected ${RUN_BUNDLE_VERSION}`);
  if (typeof raw.run_id !== 'string' || !raw.run_id) fail('run_id missing');
  if (raw.kind !== 'sweep' && raw.kind !== 'plan') fail('kind must be sweep or plan');
  if (typeof raw.pen_id !== 'number') fail('pen_id missing');
  const cage = raw.cage;
  if (!isObject(cage) || typeof cage.radius_m !== 'number' || typeof cage.depth_m !== 'number' || cage.radius_m <= 0 || cage.depth_m <= 0) fail('cage size missing');
  if (typeof raw.duration_s !== 'number') fail('duration_s missing');
  if (!Array.isArray(raw.robots) || raw.robots.some((r) => !isObject(r) || typeof r.index !== 'number' || !isStringOrNull(r.feed))) fail('robots malformed');
  if (!Array.isArray(raw.obstacles)) fail('obstacles missing');
  const files = raw.files;
  if (!isObject(files) || typeof files.captures !== 'string') fail('files.captures missing');
  for (const key of ['telemetry', 'vision', 'plan', 'plan_status', 'nav_summary', 'ground_truth']) {
    if (!isStringOrNull((files as Record<string, unknown>)[key] ?? null)) fail(`files.${key} must be a path or null`);
  }
  return raw as unknown as RunManifest;
}

/** A run loaded in full. */
export interface Run {
  base: string;
  manifest: RunManifest;
  telemetry: RunTelemetry | null;
  captures: RunCapture[];
  vision: VisionReport[];
  plan: unknown;
  planStatus: unknown;
  navSummary: unknown;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Runs available to the dashboard; an empty list when no bundle has been packed. */
export async function loadRunIndex(base = '/runs'): Promise<RunIndexEntry[]> {
  const res = await fetch(`${base}/index.json`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${base}/index.json: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error(`${base}/index.json is not a list`);
  return data as RunIndexEntry[];
}

/** Loads one bundle: the manifest, then every file it lists. */
export async function loadRun(runId: string, base = '/runs'): Promise<Run> {
  const dir = `${base}/${encodeURIComponent(runId)}`;
  const manifest = parseManifest(await getJson(`${dir}/manifest.json`));
  const opt = (path: string | null): Promise<unknown> => (path ? getJson(`${dir}/${path}`) : Promise.resolve(null));
  const [telemetry, captures, vision, plan, planStatus, navSummary] = await Promise.all([
    opt(manifest.files.telemetry),
    getJson(`${dir}/${manifest.files.captures}`),
    opt(manifest.files.vision),
    opt(manifest.files.plan),
    opt(manifest.files.plan_status),
    opt(manifest.files.nav_summary),
  ]);
  return {
    base: dir,
    manifest,
    telemetry: telemetry as RunTelemetry | null,
    captures: captures as RunCapture[],
    vision: (vision as VisionReport[] | null) ?? [],
    plan,
    planStatus,
    navSummary,
  };
}

/**
 * Where a point of the sim pen sits on the dashboard pen. Radius and depth scale to the dashboard
 * pen (depth as a fraction of the wall, as the sim addresses cells today). The angle keeps its number:
 * the sim counts counter-clockwise from +x and the dashboard clockwise from north, but both put 15°
 * sectors on the same column, so a photo lands on the same cell (the pen is mirrored, nothing else).
 */
export function simToPen(position: [number, number, number], cage: RunManifest['cage']): { deg: number; depth: number; radius: number } {
  const [x, y, z] = position;
  const deg = (((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360;
  return {
    deg,
    depth: (Math.max(0, -z) / cage.depth_m) * WALL_DEPTH_M,
    radius: (Math.hypot(x, y) / cage.radius_m) * PEN_RADIUS_M,
  };
}

/** The dashboard cell a sim angle and depth fall on (same rule as the sim's `ui_cell`). */
export function simCell(thetaDeg: number, depthM: number, cage: RunManifest['cage']): number {
  const col = Math.floor((((thetaDeg % 360) + 360) % 360) / SECTOR_DEG) % ANGLE_SECTORS;
  const row = Math.min(WALL_ROWS - 1, Math.floor((Math.max(0, -depthM) / cage.depth_m) * WALL_ROWS));
  return row * ANGLE_SECTORS + col;
}

/** Telemetry at time `t`, interpolated between samples (clamped to the run). */
export function sampleTelemetry(tel: RunTelemetry, t: number): Array<{ pos: [number, number, number]; yaw: number; filter: boolean; clr: number; contacts: number; shots: number }> {
  const n = tel.t.length;
  if (n === 0) return [];
  let i = 0;
  if (t <= tel.t[0]) i = 0;
  else if (t >= tel.t[n - 1]) i = n - 1;
  else {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tel.t[mid] <= t) lo = mid;
      else hi = mid;
    }
    i = lo;
  }
  const j = Math.min(n - 1, i + 1);
  const span = tel.t[j] - tel.t[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (t - tel.t[i]) / span)) : 0;
  return tel.rov.map((r) => {
    const a = r.pos[i];
    const b = r.pos[j];
    // Shortest way round for the heading.
    let dYaw = r.yaw[j] - r.yaw[i];
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    return {
      pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f],
      yaw: r.yaw[i] + dYaw * f,
      filter: r.filter[i] === 1,
      clr: r.clr[i] + (r.clr[j] - r.clr[i]) * f,
      contacts: r.contacts[i],
      shots: r.shots[i],
    };
  });
}
