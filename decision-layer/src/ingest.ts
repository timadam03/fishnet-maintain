/**
 * Reads a real Isaac Sim inspection run (abyss-sim/sim/fishfarm_demo.py) into the shapes the
 * decision layer already reasons about. This is the seam between the two halves of Abyss:
 * the sim writes `captures.jsonl` + `ground_truth.json`, this turns them into `Finding`s.
 *
 * Only (row, col) crosses the seam, never metres. The sim addresses captures on the UI's cell
 * grid (see `ui_cell` in fishfarm_demo.py), so `capture.cell` indexes straight into the same
 * grid `model.ts` uses and no coordinate conversion happens here.
 *
 * What this file deliberately does NOT do: decide whether a capture shows a defect. That is
 * `@vision`'s job and needs a decision-model call on the image (see `gradeCapture` below, which
 * is the one function left to write). Today `fromGroundTruth` uses the simulator's injected
 * defects as labels, which is what makes this run usable as an evaluation set rather than as a
 * source of findings you can believe.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, FindingKind } from '../../web/src/data/model';

/** One row of captures.jsonl, as fishfarm_demo.py writes it. */
export interface Capture {
  image: string;
  run_id: string;
  auv: number;
  sim_time: number;
  band: number;
  theta_deg: number;
  depth: number;
  position: [number, number, number];
  timeout: boolean;
  /** Visual panel of the net mesh, e.g. "r1_c07". Coarser than `cell`; for display only. */
  panel: string;
  /** Index on the operator UI's cell grid: row * ANGLE_SECTORS + col. */
  cell: number;
  fouled: boolean;
  holes_in_view: Array<{ panel: string; cell: number; theta: number; z: number; radius: number }>;
}

export interface GroundTruth {
  run_id: string;
  grid: { ui_sectors: number; ui_wall_rows: number; cage_radius_m: number; cage_depth_m: number };
  holes: Array<{ panel: string; cell: number; theta: number; z: number; radius: number }>;
  fouled_panels: string[];
  fouled_cells: number[];
}

export interface Run {
  runId: string;
  captures: Capture[];
  truth: GroundTruth;
  /** Cells this run actually looked at; everything else stays stale in the UI. */
  observedCells: number[];
}

export function readRun(dir: string): Run {
  const captures = readFileSync(join(dir, 'captures.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Capture);
  const truth = JSON.parse(readFileSync(join(dir, 'ground_truth.json'), 'utf8')) as GroundTruth;
  if (captures.length === 0) throw new Error(`no captures in ${dir}`);
  const runId = truth.run_id;
  const stray = captures.find((c) => c.run_id !== runId);
  if (stray) throw new Error(`capture ${stray.image} belongs to run ${stray.run_id}, not ${runId}`);
  return { runId, captures, truth, observedCells: [...new Set(captures.map((c) => c.cell))].sort((a, b) => a - b) };
}

/**
 * Guard against the failure this whole seam exists to prevent: a sim run whose grid does not
 * match the UI's. Without this the cell indices still parse and silently point at the wrong net.
 */
export function assertGridMatches(truth: GroundTruth, sectors: number, wallRows: number): void {
  const { ui_sectors, ui_wall_rows } = truth.grid;
  if (ui_sectors !== sectors || ui_wall_rows !== wallRows) {
    throw new Error(
      `grid mismatch: run is ${ui_sectors}x${ui_wall_rows}, model.ts is ${sectors}x${wallRows}. ` +
        'Fix UI_SECTORS / UI_WALL_ROWS in fishfarm_demo.py, or ANGLE_SECTORS / WALL_ROWS in model.ts.',
    );
  }
}

/**
 * A graded capture. `@vision` produces these; the rules layer consumes them.
 * `abstained` exists so a model that cannot see the net says so instead of guessing.
 */
export interface Grade {
  cell: number;
  image: string;
  kind: FindingKind | null;
  confidence: number;
  abstained: boolean;
  modelVersion: string;
}

/**
 * TODO(@vision): call the decision model on the image and return a calibrated probability.
 * Wire this to `askYesNo` in d1.ts with the capture's PNG, asking one typed question per
 * FindingKind. Until then `fromGroundTruth` stands in, and its output must never be presented
 * as a detection.
 */
export type Grader = (capture: Capture, dir: string) => Promise<Grade>;

/**
 * Labels, not detections. Uses the simulator's injected defects to say what each capture really
 * shows, so a real grader can be scored against it. Confidence is 1 because this is truth.
 */
export function fromGroundTruth(capture: Capture): Grade {
  const kind: FindingKind | null = capture.holes_in_view.length > 0 ? 'hole' : capture.fouled ? 'fraying' : null;
  return { cell: capture.cell, image: capture.image, kind, confidence: 1, abstained: false, modelVersion: 'ground-truth' };
}

/**
 * Turns graded captures into `Finding`s for one pen on one day.
 *
 * A run is a single inspection pass, so every finding it produces shares one `detectedDay`:
 * the decision layer reasons in days and the sim reasons in seconds of sim time, and this is
 * where the two are reconciled. Several captures of the same cell collapse into one finding,
 * keeping the most confident grade.
 */
export function toFindings(grades: Grade[], penId: number, day: number, firstId = 1): Finding[] {
  const best = new Map<number, Grade>();
  for (const g of grades) {
    if (g.kind === null || g.abstained) continue;
    const prior = best.get(g.cell);
    if (!prior || g.confidence > prior.confidence) best.set(g.cell, g);
  }
  return [...best.values()]
    .sort((a, b) => a.cell - b.cell)
    .map((g, i) => ({
      id: firstId + i,
      penId,
      cell: g.cell,
      kind: g.kind as FindingKind,
      side: 'inside' as const,
      detectedDay: day,
      confidence: g.confidence,
      severity: g.kind === 'hole' ? ('critical' as const) : ('warning' as const),
      steps: [{ day, status: 'unreviewed' as const, note: `Detected in run ${g.image.split('/')[0]} (${g.modelVersion}).` }],
    }));
}

/** Convenience: a whole run to findings, with the stand-in grader. */
export function runToFindings(dir: string, penId: number, day: number, firstId = 1): Finding[] {
  const run = readRun(dir);
  return toFindings(run.captures.map(fromGroundTruth), penId, day, firstId);
}
