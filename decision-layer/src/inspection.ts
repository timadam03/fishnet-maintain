/**
 * The robot-facing half of the decision layer.
 *
 * In:  Isaac captures (where and when a photo was taken) + image-pipeline reports (what it shows),
 *      joined by image path into observations.
 * Out: an inspection plan: which net cells to look at next, in which order, how (distance, shots,
 *      viewpoints), how safely (HOCBF margin) and with which robots. Each target is a mission, so
 *      the photos taken for it close the mission with a result, and the trace shows the whole loop.
 *
 * Every number below is a demo starting value. The plan rules (P1–P6, G1, S1) are named so each
 * target can say why it is there.
 */
import { createHash } from 'node:crypto';
import { GRID, InspectionPlan, SimCapture, VisionReport, type PlanTarget } from './contracts.ts';
import { ensureMission, updateMission } from './log.ts';
import type { Store } from './store.ts';
import { CELLS, cellLabel, explainRisk, penSim, world } from './world.ts';

export const PLAN_RULES_VERSION = 'plan-v2';

const OPENING = new Set(['hole', 'mesh_opening']);
const WEAR = new Set(['fraying', 'thinning', 'distortion', 'rope_contact']);
/** Vehicle radius (safe_nav.py) plus slack: a photo spot closer to the net than margin + this can't be reached. */
const REACH_SLACK_M = 0.55;
const STRONG_CURRENT_CM_S = 30;
/**
 * Close-up distance from the net. Measured in the sim: under 2 m the robot's own lamps wash the near
 * twine out to the colour of the water and the detector reads nothing; from 2.1 m it reads the holes.
 */
export const CLOSE_INSPECTION_M = 2.2;
/** Detections closer together than this are one defect and get one target. [deg round the pen, depth fraction] */
const SAME_SPOT = { thetaDeg: 6, depthFrac: 0.09 };

export interface Alignment {
  status: 'aligned' | 'not_seen' | 'off_centre';
  kind?: NonNullable<PlanTarget['aim']>['kind'];
  at?: { theta_deg: number; depth_frac: number };
}

export interface Observation {
  runId: string;
  image: string;
  penId: number;
  cell: number;
  auv: number | null;
  simTime: number | null;
  standoffM: number | null;
  targetId: string | null;
  model: string;
  quality: { visibility: number; sharpness: number } | null;
  fouling: number | null;
  /** Cells the photo shows (vision report cells_in_view); null for reports that don't say. */
  cellsInView: number[] | null;
  detections: VisionReport['detections'];
  /** For a close-up: how well it was lined up, and on which spot; null for photos that weren't aimed. */
  align?: Alignment | null;
}

/**
 * Stops an import whose run was made on a different cell grid (from Einar's ingest.ts). Without it,
 * cell numbers still parse and silently point at the wrong part of the net.
 */
export function assertGridMatches(grid: { ui_sectors?: number; ui_wall_rows?: number } | undefined): void {
  if (!grid) return;
  if (grid.ui_sectors !== GRID.sectors || grid.ui_wall_rows !== GRID.wallRows) {
    throw new Error(
      `grid mismatch: run is ${grid.ui_sectors}x${grid.ui_wall_rows}, decision layer is ${GRID.sectors}x${GRID.wallRows}. ` +
        'Fix UI_SECTORS / UI_WALL_ROWS in fishfarm_demo.py, or ANGLE_SECTORS / WALL_ROWS in web/src/data/model.ts.',
    );
  }
}

export interface ImportResult {
  imported: number;
  /** Captures with no vision report yet: not evidence of anything, so they are left out. */
  awaitingVision: number;
  unmatchedReports: string[];
  missionsClosed: Array<{ missionId: number; result: string }>;
}

/**
 * Joins captures and vision reports by image path and stores them as observations for `penId`.
 * A report without a capture is accepted only if it says where it was taken (`where`).
 */
export function importObservations(
  store: Store,
  input: { penId: number; captures: unknown[]; reports: unknown[]; cageRadiusM?: number; grid?: { ui_sectors?: number; ui_wall_rows?: number } },
): ImportResult {
  assertGridMatches(input.grid);
  const captures = new Map(input.captures.map((c) => SimCapture.parse(c)).map((c) => [c.image, c]));
  const reports = input.reports.map((r) => VisionReport.parse(r));
  const unmatchedReports: string[] = [];
  const insert = store.db.prepare(
    `INSERT INTO observations (run_id, image, pen_id, cell, auv, sim_time, standoff_m, target_id, model, quality_json, fouling, detections_json, imported_at, cells_json, align_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, image) DO NOTHING`,
  );
  let imported = 0;
  const touchedTargets = new Set<string>();
  for (const r of reports) {
    const c = captures.get(r.image);
    if (!c && !r.where) {
      unmatchedReports.push(r.image);
      continue;
    }
    const standoff = c && input.cageRadiusM ? Number((input.cageRadiusM - Math.hypot(c.position[0], c.position[1])).toFixed(2)) : null;
    const res = insert.run(
      c?.run_id ?? 'external', r.image, r.where?.pen_id ?? input.penId, c?.cell ?? r.where!.cell, c?.auv ?? r.where?.auv ?? null,
      c?.sim_time ?? null, standoff, c?.target_id ?? null, r.model, r.quality ? JSON.stringify(r.quality) : null,
      r.fouling_pct ?? null, JSON.stringify(r.detections), new Date().toISOString(), r.cells_in_view ? JSON.stringify(r.cells_in_view) : null,
      c?.alignment ? JSON.stringify(c.alignment) : null,
    );
    imported += Number(res.changes);
    if (c?.target_id) touchedTargets.add(c.target_id);
  }
  const awaitingVision = [...captures.keys()].filter((image) => !reports.some((r) => r.image === image)).length;
  return { imported, awaitingVision, unmatchedReports, missionsClosed: closeMissions(store, touchedTargets) };
}

export function observations(store: Store, filter: { penId: number; cell?: number; targetId?: string }): Observation[] {
  const where = ['pen_id = ?'];
  const args: Array<string | number> = [filter.penId];
  if (filter.cell !== undefined) { where.push('cell = ?'); args.push(filter.cell); }
  if (filter.targetId !== undefined) { where.push('target_id = ?'); args.push(filter.targetId); }
  const rows = store.db.prepare(`SELECT * FROM observations WHERE ${where.join(' AND ')} ORDER BY id`).all(...args) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    runId: String(r.run_id), image: String(r.image), penId: Number(r.pen_id), cell: Number(r.cell),
    auv: r.auv === null ? null : Number(r.auv), simTime: r.sim_time === null ? null : Number(r.sim_time),
    standoffM: r.standoff_m === null ? null : Number(r.standoff_m), targetId: (r.target_id as string) ?? null, model: String(r.model),
    quality: r.quality_json ? JSON.parse(String(r.quality_json)) : null, fouling: r.fouling === null ? null : Number(r.fouling),
    cellsInView: r.cells_json ? JSON.parse(String(r.cells_json)) : null,
    detections: JSON.parse(String(r.detections_json)),
    align: r.align_json ? (JSON.parse(String(r.align_json)) as Alignment) : null,
  }));
}

/**
 * Credits each photo to every cell it shows, each with only the detections on that cell.
 *
 * A far survey photo spans about 4 x 4 cells. Crediting it all to its centre cell put a hole seen at
 * the edge of the frame on the wrong cell (so the close-up went to the wrong place), and left the
 * other cells unseen. Reports without per-detection cells keep the old behaviour.
 */
export function creditByCell(all: Observation[]): Map<number, Observation[]> {
  const out = new Map<number, Observation[]>();
  const add = (cell: number, o: Observation) => out.set(cell, [...(out.get(cell) ?? []), o]);
  for (const o of all) {
    const cells = new Set([o.cell, ...(o.cellsInView ?? []), ...o.detections.map((d) => d.cell ?? o.cell)]);
    for (const cell of cells) {
      const own = o.detections.filter((d) => (d.cell ?? o.cell) === cell);
      // Photo-wide fouling stays with the capture cell; elsewhere the biofouling detections speak.
      add(cell, cell === o.cell ? { ...o, detections: own } : { ...o, cell, fouling: null, detections: own });
    }
  }
  return out;
}

export type CellStatus = 'confirmed_opening' | 'possible_opening' | 'wear' | 'uncertain' | 'unclear' | 'fouled' | 'clear';

export interface CellAssessment {
  cell: number;
  status: CellStatus;
  images: number;
  /** Best confidence of a hole or mesh opening, and how many views (robot × pass) showed one at ≥ 0.7. */
  opening: number;
  openingViews: number;
  wear: number;
  fouling: number;
  /** Quality of the best image: min(visibility, sharpness). */
  quality: number;
}

const qualityOf = (o: Observation): number => (o.quality ? Math.min(o.quality.visibility, o.quality.sharpness) : 0.6);
const maxConf = (o: Observation, classes: Set<string>): number => Math.max(0, ...o.detections.filter((d) => classes.has(d.class)).map((d) => d.confidence));

/** A photo at or closer than this, with usable quality, counts as a close-up. Demo value. */
export const CLOSE_UP_M = 2.8;

/**
 * What a set of images says about one cell. Openings need two good views to count as confirmed.
 * Close-ups replace far photos as evidence: otherwise a far photo that was unsure would keep the
 * cell in every plan even after a careful close look found nothing.
 */
export function assessCell(cell: number, all: Observation[]): CellAssessment {
  // A close-up that never got the defect into the middle of the frame can add a finding, but finding
  // nothing in it says nothing, so it must not replace the earlier photos as evidence.
  const missed = (o: Observation) => (o.align?.status === 'off_centre' || o.align?.status === 'not_seen') && o.detections.length === 0;
  const close = all.filter((o) => o.standoffM !== null && o.standoffM <= CLOSE_UP_M && qualityOf(o) >= 0.5 && !missed(o));
  const obs = close.length > 0 ? close : all;
  const opening = Math.max(0, ...obs.map((o) => maxConf(o, OPENING)));
  // A view is a robot on a pass: several shots from the same robot in the same run count once.
  const openingViews = new Set(obs.filter((o) => maxConf(o, OPENING) >= 0.7).map((o) => `${o.runId}|${o.auv ?? o.image}`)).size;
  const wear = Math.max(0, ...obs.map((o) => maxConf(o, WEAR)));
  const fouling = Math.max(0, ...obs.map((o) => o.fouling ?? maxConf(o, new Set(['biofouling']))));
  const quality = Math.max(0, ...obs.map(qualityOf));
  const status: CellStatus =
    openingViews >= 2 ? 'confirmed_opening'
    : opening >= 0.7 ? 'possible_opening'
    : wear >= 0.7 ? 'wear'
    : Math.max(opening, wear) >= 0.3 ? 'uncertain'
    : quality < 0.5 ? 'unclear'
    : fouling >= 0.4 ? 'fouled'
    : 'clear';
  return { cell, status, images: obs.length, opening, openingViews, wear, fouling, quality };
}

function cellResult(a: CellAssessment): string {
  return a.status === 'confirmed_opening' ? `confirmed: opening seen from ${a.openingViews} viewpoints (best p=${a.opening.toFixed(2)})`
    : a.status === 'possible_opening' ? `possible opening (p=${a.opening.toFixed(2)}), one view only`
    : a.status === 'wear' ? `confirmed: wear sign (p=${a.wear.toFixed(2)})`
    : a.status === 'clear' ? `clear: ${a.images} good image${a.images > 1 ? 's' : ''}, nothing found`
    : `${a.status}: needs another look`;
}

/** A detection on the spot the robot lined up on. Without positions, every detection counts. */
function onSpot(d: VisionReport['detections'][number], at: Alignment['at']): boolean {
  return !d.at || !at || (angleDist(d.at.theta_deg, at.theta_deg) <= SAME_SPOT.thetaDeg && Math.abs(d.at.depth_frac - at.depth_frac) <= SAME_SPOT.depthFrac);
}

/**
 * What a mission's own photos say about what it was sent to look at. Closing a mission and
 * escalating it (escalate.ts) both read this, so they can't disagree.
 *
 * For a lined-up close-up that is what is on the spot aimed at, whichever cell it falls in, from the
 * photos that had it in frame. `settled` is false when those show no finding of the kind looked for.
 */
export interface MissionView {
  photos: Observation[];
  assessment: CellAssessment;
  aimed: boolean;
  settled: boolean;
}

export function missionView(cell: number, obs: Observation[]): MissionView {
  if (!obs.some((o) => o.align)) {
    const photos = creditByCell(obs).get(cell) ?? [];
    return { photos, assessment: assessCell(cell, photos), aimed: false, settled: true };
  }
  const photos = obs
    .filter((o) => o.align?.status !== 'off_centre')
    .map((o) => ({ ...o, cell, detections: o.detections.filter((d) => onSpot(d, o.align?.at)) }));
  const a = assessCell(cell, photos.map((o) => ({ ...o, align: null, fouling: null })));
  const kind = obs.find((o) => o.align?.kind)?.align?.kind;
  const opening = a.status === 'confirmed_opening' || a.status === 'possible_opening';
  const wear = kind === 'wear' && a.wear >= 0.7;
  const fouling = kind === 'fouling' && a.fouling >= 0.3;
  const status = opening ? a.status : wear ? 'wear' : fouling ? 'fouled' : a.status === 'clear' || a.status === 'unclear' ? a.status : 'uncertain';
  return { photos, assessment: { ...a, status }, aimed: true, settled: photos.length > 0 && (opening || wear || fouling) };
}

function aimedResult({ photos, assessment: a, settled }: MissionView): string {
  if (photos.length === 0) return 'not inspected: could not get the spot centred in the frame';
  if (settled) return a.status === 'fouled' ? `confirmed: fouling, no opening found (p=${a.fouling.toFixed(2)})` : cellResult(a);
  const signs = [a.opening > 0 ? `possible opening p=${a.opening.toFixed(2)}` : '', a.wear > 0 ? `wear sign p=${a.wear.toFixed(2)}` : ''].filter(Boolean);
  return signs.length
    ? `not conclusive: spot centred, but the detector is not sure what it is (${signs.join(', ')})`
    : 'not found again: spot centred at close range, nothing detected there';
}

/** Closes each mission whose photos came back, with what they showed. */
function closeMissions(store: Store, targetIds: Set<string>): ImportResult['missionsClosed'] {
  const closed: ImportResult['missionsClosed'] = [];
  for (const targetId of targetIds) {
    const missionId = Number(targetId.match(/^m(\d+)$/)?.[1]);
    if (!missionId) continue;
    const row = store.db.prepare('SELECT pen_id, status FROM missions WHERE id = ?').get(missionId) as { pen_id: number; status: string } | undefined;
    if (!row || row.status === 'done' || row.status === 'cancelled') continue;
    const obs = observations(store, { penId: row.pen_id, targetId });
    if (obs.length === 0) continue;
    const cell = obs[0].cell;
    const credited = creditByCell(obs);
    const view = missionView(cell, obs);
    const aimed = view.aimed;
    const result = aimed ? aimedResult(view) : cellResult(view.assessment);
    // What the close-ups showed next door: the next plan picks these up as their own cells.
    const nextDoor = aimed ? [] : [...credited].filter(([c, o]) => c !== cell && assessCell(c, o).opening >= 0.7).map(([c]) => c);
    const extra = nextDoor.length ? `; possible opening next door in cell ${nextDoor.join(', ')}` : '';
    const robots = [...new Set(obs.map((o) => o.auv).filter((x): x is number => x !== null))].map((k) => `AUV-${k}`).join(', ');
    updateMission(store, missionId, { status: 'done', robot: robots || undefined, result: result + extra });
    closed.push({ missionId, result: result + extra });
  }
  return closed;
}

type Profile = Pick<PlanTarget, 'priority' | 'scan' | 'safety'> & { robots: number; kind: 'close_inspection' | 'reimage'; reason: { rule: string; text: string } };

const view = (dTheta = 0, dDepth = 0) => ({ d_theta_deg: dTheta, d_depth_frac: dDepth });

/** The plan rules: why a cell needs the robots, and how they should look at it. */
function profilesFor(a: CellAssessment | null, risk: { level: string; score: number }): Profile[] {
  const out: Profile[] = [];
  if (a?.status === 'possible_opening') {
    out.push({ kind: 'close_inspection', priority: 1, robots: 2, scan: { standoff_m: CLOSE_INSPECTION_M, shots: 2, viewpoints: [view(-6), view(6)] }, safety: { margin_m: 1.0 },
      reason: { rule: 'P1', text: `Possible opening (p=${a.opening.toFixed(2)}) seen once: confirm from two sides with two robots, keep off the net.` } });
  }
  if (a?.status === 'wear') {
    out.push({ kind: 'close_inspection', priority: 0.7, robots: 1, scan: { standoff_m: CLOSE_INSPECTION_M, shots: 2, viewpoints: [view()] }, safety: { margin_m: 0.9 },
      reason: { rule: 'P5', text: `Wear sign (p=${a.wear.toFixed(2)}): look closer, keep extra distance from weakened twine.` } });
  }
  if (a?.status === 'uncertain') {
    const p = Math.max(a.opening, a.wear);
    out.push({ kind: 'reimage', priority: Number((0.6 + 0.3 * p).toFixed(2)), robots: 1, scan: { standoff_m: CLOSE_INSPECTION_M, shots: 3, viewpoints: [view()] }, safety: { margin_m: 0.6 },
      reason: { rule: 'P2', text: `Unsure (p=${p.toFixed(2)}): re-image closer and with more shots.` } });
  }
  if (a?.status === 'unclear') {
    // Risk-weighted, so if the whole sweep is murky the robots look first where risk is highest.
    out.push({ kind: 'reimage', priority: Number((0.45 + 0.1 * risk.score).toFixed(2)), robots: 1, scan: { standoff_m: CLOSE_INSPECTION_M, shots: 2, viewpoints: [view()] }, safety: { margin_m: 0.6 },
      reason: { rule: 'P3', text: `Image too poor to judge (quality ${a.quality.toFixed(2)}): go closer.` } });
  }
  if (a && a.fouling >= 0.4 && a.status !== 'confirmed_opening') {
    out.push({ kind: 'reimage', priority: 0.5, robots: 1, scan: { standoff_m: CLOSE_INSPECTION_M, shots: 1, viewpoints: [view(-8), view(8)] }, safety: { margin_m: 0.6 },
      reason: { rule: 'P4', text: `Fouling covers ${Math.round(a.fouling * 100)}% and can hide holes: look from two angles.` } });
  }
  if ((risk.level === 'high' || risk.level === 'critical') && a?.status !== 'confirmed_opening' && a?.status !== 'clear') {
    out.push({ kind: 'close_inspection', priority: Number((0.35 + 0.4 * risk.score).toFixed(2)), robots: 1, scan: { standoff_m: CLOSE_INSPECTION_M, shots: 2, viewpoints: [view()] }, safety: { margin_m: 0.8 },
      reason: { rule: 'P6', text: `Risk model: ${risk.level} (${risk.score.toFixed(2)}) from history and exposure.` } });
  }
  return out;
}

/**
 * How a grader (the rules below, or d1 in grade-d1.ts) judged one cell. A grader may also set the
 * cell's priority; scan distance, viewpoints, robots and safety margins always come from the plan
 * rules for that status, so a model can reorder and reclassify, never send a robot into the net.
 */
export interface Grade extends CellAssessment {
  by: 'rules' | 'd1';
  priority?: number;
  note?: string;
}

/** The rules grader: assessCell on what each cell's photos show. */
export function gradeByRules(byCell: Map<number, Observation[]>): Map<number, Grade> {
  return new Map([...byCell].map(([cell, obs]) => [cell, { ...assessCell(cell, obs), by: 'rules' as const }]));
}

/** Every cell's observations for a pen, credited by cell. */
export function observationsByCell(store: Store, penId: number): Map<number, Observation[]> {
  return creditByCell(observations(store, { penId }));
}

/** Combines the profiles for one cell: highest priority wins, margins and robots take the max. */
function merge(profiles: Profile[], marginBoost: number): Profile & { reasons: Profile['reason'][] } {
  const sorted = [...profiles].sort((a, b) => b.priority - a.priority);
  const margin = Math.max(...sorted.map((p) => p.safety.margin_m)) + marginBoost;
  const viewpoints = [...new Map(sorted.flatMap((p) => p.scan.viewpoints).map((v) => [`${v.d_theta_deg}|${v.d_depth_frac}`, v])).values()];
  return {
    ...sorted[0],
    robots: Math.max(...sorted.map((p) => p.robots)),
    scan: {
      // S1: the photo spot must stay reachable under the HOCBF margin.
      standoff_m: Number(Math.max(Math.min(...sorted.map((p) => p.scan.standoff_m)), margin + REACH_SLACK_M).toFixed(2)),
      shots: Math.max(...sorted.map((p) => p.scan.shots)),
      viewpoints,
    },
    safety: { margin_m: Number(margin.toFixed(2)) },
    reasons: sorted.map((p) => p.reason),
  };
}

const angleDist = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
};

/**
 * Where in this cell the defect was seen, so the close-up goes there and not to the cell centre.
 * Openings before wear before fouling; from the closest photos that saw it, as they place it best.
 */
export function aimFor(cell: number, obs: Observation[]): PlanTarget['aim'] {
  const kinds = [['opening', OPENING], ['wear', WEAR], ['fouling', new Set(['biofouling'])]] as const;
  const centre = ((cell % GRID.sectors) + 0.5) * (360 / GRID.sectors);
  for (const [kind, classes] of kinds) {
    const seen = obs.flatMap((o) =>
      o.detections.filter((d) => d.at && classes.has(d.class) && d.confidence >= 0.3).map((d) => ({ at: d.at!, from: o.standoffM ?? Infinity })));
    if (seen.length === 0) continue;
    const nearest = Math.min(...seen.map((s) => s.from));
    const best = seen.filter((s) => s.from <= nearest + 0.5);
    const theta = centre + median(best.map((s) => ((s.at.theta_deg - centre + 540) % 360) - 180));
    return { theta_deg: Number(((theta + 360) % 360).toFixed(2)), depth_frac: Number(median(best.map((s) => s.at.depth_frac)).toFixed(4)), kind };
  }
  return undefined;
}

/**
 * Builds the plan for one pen: targets best first, robots assigned so each goes where it is
 * closest and least busy, and two robots on anything that needs two perspectives.
 */
export function buildPlan(
  store: Store,
  input: { penId: number; day: number; robots?: number; maxTargets?: number; grades?: Map<number, Grade> },
): InspectionPlan {
  const nRobots = input.robots ?? 3;
  const sim = penSim(input.penId);
  const strongCurrent = world.env.currentSpeed[input.day] >= STRONG_CURRENT_CM_S;
  const byCell = observationsByCell(store, input.penId);
  const grades = input.grades ?? gradeByRules(byCell);

  const candidates: Array<ReturnType<typeof merge> & { cell: number; risk: number }> = [];
  for (let cell = 0; cell < GRID.sectors * GRID.wallRows; cell++) {
    const grade = grades.get(cell) ?? null;
    const risk = explainRisk(sim, cell, input.day);
    const profiles = profilesFor(grade, risk);
    if (profiles.length === 0) continue;
    const merged = merge(profiles, strongCurrent ? 0.4 : 0);
    if (grade?.by === 'd1') {
      if (grade.priority !== undefined) merged.priority = grade.priority;
      merged.reasons.unshift({ rule: 'D1', text: grade.note ?? `d1 graded this cell ${grade.status}.` });
    } else if (grade?.note) {
      merged.reasons.push({ rule: 'D1-fallback', text: grade.note });
    }
    if (strongCurrent) merged.reasons.push({ rule: 'G1', text: `Strong current (${world.env.currentSpeed[input.day].toFixed(0)} cm/s): margin +0.4 m.` });
    candidates.push({ ...merged, cell, risk: risk.score });
  }
  // Ties go to the riskier area, not the lower cell number.
  candidates.sort((a, b) => b.priority - a.priority || b.risk - a.risk || a.cell - b.cell);
  // One defect often reaches into several cells. Send the robots to it once, for the highest-ranked.
  const chosen: Array<(typeof candidates)[number] & { aim: PlanTarget['aim'] }> = [];
  for (const c of candidates) {
    if (chosen.length >= (input.maxTargets ?? 10)) break;
    const aim = aimFor(c.cell, byCell.get(c.cell) ?? []);
    const same = aim && chosen.find((t) => t.aim?.kind === aim.kind
      && angleDist(t.aim.theta_deg, aim.theta_deg) <= SAME_SPOT.thetaDeg && Math.abs(t.aim.depth_frac - aim.depth_frac) <= SAME_SPOT.depthFrac);
    if (same) same.reasons.push({ rule: 'M1', text: `Also covers cell ${c.cell}: the same spot on the net.` });
    else chosen.push({ ...c, aim });
  }

  // Robots start in the middle of their usual sector; each pick moves the robot and adds load.
  const robot = Array.from({ length: nRobots }, (_, k) => ({ id: k, at: ((k + 0.5) * 360) / nRobots, load: 0 }));
  const targets: PlanTarget[] = chosen.map((t) => {
    const row = Math.floor(t.cell / GRID.sectors);
    const col = t.cell % GRID.sectors;
    const theta = (col + 0.5) * (360 / GRID.sectors);
    const picks = [...robot].sort((a, b) => angleDist(a.at, theta) + a.load * 45 - (angleDist(b.at, theta) + b.load * 45)).slice(0, Math.min(t.robots, nRobots));
    for (const p of picks) { p.at = theta; p.load++; }
    const label = cellLabel(t.cell);
    const missionId = ensureMission(store, t.kind === 'close_inspection' ? `inspect:${input.penId}:${t.cell}` : `reimage-cell:${input.penId}:${t.cell}`, {
      day: input.day, penId: input.penId, kind: t.kind, cells: [t.cell], priority: t.priority >= 0.8 ? 'high' : 'normal', reason: t.reasons.map((r) => r.text).join(' '),
    });
    return {
      target_id: `m${missionId}`, mission_id: missionId, cell: t.cell, row, col, theta_deg: theta,
      depth_frac: Number(((row + 0.5) / GRID.wallRows).toFixed(4)),
      priority: t.priority, priority_label: t.priority >= 0.8 ? 'high' : t.priority >= 0.5 ? 'normal' : 'low',
      reasons: [{ rule: 'area', text: `${label} (cell ${t.cell})` }, ...t.reasons],
      ...(t.aim ? { aim: t.aim } : {}), scan: t.scan, safety: t.safety, robots: picks.map((p) => p.id).sort((a, b) => a - b),
    };
  });

  const targeted = new Set(targets.map((t) => t.cell));
  const lastSeen = (cell: number): number => {
    const own = byCell.get(cell)?.length ? input.day : -1;
    return Math.max(own, sim.lastSeen[input.day * CELLS + cell] ?? -1);
  };
  const coverage = Array.from({ length: GRID.sectors * GRID.wallRows }, (_, c) => c)
    .filter((c) => !targeted.has(c))
    .sort((a, b) => lastSeen(a) - lastSeen(b) || a - b);

  const plan: InspectionPlan = {
    plan_id: `pen${input.penId}-d${input.day}-${createHash('sha256').update(JSON.stringify(targets)).digest('hex').slice(0, 8)}`,
    created_at: new Date().toISOString(),
    pen_id: input.penId,
    day: input.day,
    rules_version: [...grades.values()].some((g) => g.by === 'd1') ? `${PLAN_RULES_VERSION}+d1` : PLAN_RULES_VERSION,
    grid: { sectors: GRID.sectors, wall_rows: GRID.wallRows },
    robots: nRobots,
    targets,
    coverage,
  };
  return InspectionPlan.parse(plan);
}
