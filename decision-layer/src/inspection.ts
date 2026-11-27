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

export const PLAN_RULES_VERSION = 'plan-v1';

const OPENING = new Set(['hole', 'mesh_opening']);
const WEAR = new Set(['fraying', 'thinning', 'distortion', 'rope_contact']);
/** Vehicle radius (safe_nav.py) plus slack: a photo spot closer to the net than margin + this can't be reached. */
const REACH_SLACK_M = 0.55;
const STRONG_CURRENT_CM_S = 30;

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
  detections: VisionReport['detections'];
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
  input: { penId: number; captures: unknown[]; reports: unknown[]; cageRadiusM?: number },
): ImportResult {
  const captures = new Map(input.captures.map((c) => SimCapture.parse(c)).map((c) => [c.image, c]));
  const reports = input.reports.map((r) => VisionReport.parse(r));
  const unmatchedReports: string[] = [];
  const insert = store.db.prepare(
    `INSERT INTO observations (run_id, image, pen_id, cell, auv, sim_time, standoff_m, target_id, model, quality_json, fouling, detections_json, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, image) DO NOTHING`,
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
      r.fouling_pct ?? null, JSON.stringify(r.detections), new Date().toISOString(),
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
    detections: JSON.parse(String(r.detections_json)),
  }));
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

/** What a set of images says about one cell. Openings need two good views to count as confirmed. */
export function assessCell(cell: number, obs: Observation[]): CellAssessment {
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
    const a = assessCell(obs[0].cell, obs);
    const result =
      a.status === 'confirmed_opening' ? `confirmed: opening seen from ${a.openingViews} viewpoints (best p=${a.opening.toFixed(2)})`
      : a.status === 'possible_opening' ? `possible opening (p=${a.opening.toFixed(2)}), one view only`
      : a.status === 'wear' ? `confirmed: wear sign (p=${a.wear.toFixed(2)})`
      : a.status === 'clear' ? `clear: ${a.images} good image${a.images > 1 ? 's' : ''}, nothing found`
      : `${a.status}: needs another look`;
    const robots = [...new Set(obs.map((o) => o.auv).filter((x): x is number => x !== null))].map((k) => `AUV-${k}`).join(', ');
    updateMission(store, missionId, { status: 'done', robot: robots || undefined, result });
    closed.push({ missionId, result });
  }
  return closed;
}

type Profile = Pick<PlanTarget, 'priority' | 'scan' | 'safety'> & { robots: number; kind: 'close_inspection' | 'reimage'; reason: { rule: string; text: string } };

const view = (dTheta = 0, dDepth = 0) => ({ d_theta_deg: dTheta, d_depth_frac: dDepth });

/** The plan rules: why a cell needs the robots, and how they should look at it. */
function profilesFor(a: CellAssessment | null, risk: { level: string; score: number }): Profile[] {
  const out: Profile[] = [];
  if (a?.status === 'possible_opening') {
    out.push({ kind: 'close_inspection', priority: 1, robots: 2, scan: { standoff_m: 1.4, shots: 2, viewpoints: [view(-6), view(6)] }, safety: { margin_m: 1.0 },
      reason: { rule: 'P1', text: `Possible opening (p=${a.opening.toFixed(2)}) seen once: confirm from two sides with two robots, keep off the net.` } });
  }
  if (a?.status === 'wear') {
    out.push({ kind: 'close_inspection', priority: 0.7, robots: 1, scan: { standoff_m: 1.2, shots: 2, viewpoints: [view()] }, safety: { margin_m: 0.9 },
      reason: { rule: 'P5', text: `Wear sign (p=${a.wear.toFixed(2)}): look closer, keep extra distance from weakened twine.` } });
  }
  if (a?.status === 'uncertain') {
    const p = Math.max(a.opening, a.wear);
    out.push({ kind: 'reimage', priority: Number((0.6 + 0.3 * p).toFixed(2)), robots: 1, scan: { standoff_m: 1.0, shots: 3, viewpoints: [view()] }, safety: { margin_m: 0.6 },
      reason: { rule: 'P2', text: `Unsure (p=${p.toFixed(2)}): re-image closer and with more shots.` } });
  }
  if (a?.status === 'unclear') {
    out.push({ kind: 'reimage', priority: 0.55, robots: 1, scan: { standoff_m: 0.9, shots: 2, viewpoints: [view()] }, safety: { margin_m: 0.6 },
      reason: { rule: 'P3', text: `Image too poor to judge (quality ${a.quality.toFixed(2)}): go closer.` } });
  }
  if (a && a.fouling >= 0.4 && a.status !== 'confirmed_opening') {
    out.push({ kind: 'reimage', priority: 0.5, robots: 1, scan: { standoff_m: 1.2, shots: 1, viewpoints: [view(-8), view(8)] }, safety: { margin_m: 0.6 },
      reason: { rule: 'P4', text: `Fouling covers ${Math.round(a.fouling * 100)}% and can hide holes: look from two angles.` } });
  }
  if ((risk.level === 'high' || risk.level === 'critical') && a?.status !== 'confirmed_opening' && a?.status !== 'clear') {
    out.push({ kind: 'close_inspection', priority: Number((0.35 + 0.4 * risk.score).toFixed(2)), robots: 1, scan: { standoff_m: 1.2, shots: 2, viewpoints: [view()] }, safety: { margin_m: 0.8 },
      reason: { rule: 'P6', text: `Risk model: ${risk.level} (${risk.score.toFixed(2)}) from history and exposure.` } });
  }
  return out;
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

/**
 * Builds the plan for one pen: targets best first, robots assigned so each goes where it is
 * closest and least busy, and two robots on anything that needs two perspectives.
 */
export function buildPlan(store: Store, input: { penId: number; day: number; robots?: number; maxTargets?: number }): InspectionPlan {
  const nRobots = input.robots ?? 3;
  const sim = penSim(input.penId);
  const strongCurrent = world.env.currentSpeed[input.day] >= STRONG_CURRENT_CM_S;
  const byCell = new Map<number, Observation[]>();
  for (const o of observations(store, { penId: input.penId })) byCell.set(o.cell, [...(byCell.get(o.cell) ?? []), o]);

  const candidates: Array<ReturnType<typeof merge> & { cell: number }> = [];
  for (let cell = 0; cell < GRID.sectors * GRID.wallRows; cell++) {
    const obs = byCell.get(cell);
    const risk = explainRisk(sim, cell, input.day);
    const profiles = profilesFor(obs ? assessCell(cell, obs) : null, risk);
    if (profiles.length === 0) continue;
    const merged = merge(profiles, strongCurrent ? 0.4 : 0);
    if (strongCurrent) merged.reasons.push({ rule: 'G1', text: `Strong current (${world.env.currentSpeed[input.day].toFixed(0)} cm/s): margin +0.4 m.` });
    candidates.push({ ...merged, cell });
  }
  candidates.sort((a, b) => b.priority - a.priority || a.cell - b.cell);
  const chosen = candidates.slice(0, input.maxTargets ?? 10);

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
      scan: t.scan, safety: t.safety, robots: picks.map((p) => p.id).sort((a, b) => a - b),
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
    rules_version: PLAN_RULES_VERSION,
    grid: { sectors: GRID.sectors, wall_rows: GRID.wallRows },
    robots: nRobots,
    targets,
    coverage,
  };
  return InspectionPlan.parse(plan);
}
