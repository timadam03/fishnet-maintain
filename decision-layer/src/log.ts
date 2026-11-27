/**
 * Decision log, missions and traces: what the layer saw, what it decided, what it asked the robots
 * to do and how that ended. Decisions are still computed from the world; recording a day writes
 * each non-OK decision once (per rules version), so the log keeps what was decided at the time
 * even after rules change.
 */
import type { Experimental_DecisionModel } from 'ai';
import { findingById, oxygenEventText, penDecisions } from './engine.ts';
import { sameFinding, similarEpisodes, type Link } from './memory.ts';
import { rulesVersion, type Outcome } from './rules/types.ts';
import type { Store } from './store.ts';
import { cellLabel, dayLabel, world } from './world.ts';

export type MissionKind = 'close_inspection' | 'reimage' | 'coverage' | 'resample_oxygen';
export type MissionStatus = 'requested' | 'assigned' | 'done' | 'cancelled';

export interface Mission {
  id: number;
  day: number;
  date: string;
  penId: number;
  kind: MissionKind;
  /** Net cells to visit (empty for an oxygen re-sample, which targets the pen). */
  cells: number[];
  areas: string[];
  priority: 'high' | 'normal';
  reason: string;
  status: MissionStatus;
  robot: string | null;
  /** What the robot found: "confirmed", "clear", or a short note. */
  result: string | null;
  note: string | null;
}

export interface LogEntry {
  id: number;
  day: number;
  date: string;
  loggedAt: string;
  penId: number;
  /** "cell:7:188", "finding:208" or "oxygen:3". */
  entity: string;
  outcome: Outcome['kind'];
  level: string | null;
  rules: string[];
  rulesVersion: string;
  reason: string;
  recommend: string | null;
  /** What the layer saw when it decided. */
  inputs: Record<string, unknown>;
  /** Memory links (d1 or fallback) it used. */
  links: Array<{ to: string; probability: number | null; linked: boolean; source: string }>;
  alertKey: string | null;
  missionId: number | null;
}

const now = (): string => new Date().toISOString();
const linkOf = (l: Link) => ({ to: l.episode.id, probability: l.probability, linked: l.linked, source: l.source });

/**
 * Returns the open mission for `base` (same target, not yet done or cancelled), or creates one.
 * So the same stale areas or risky cell don't produce a new mission every day; once a robot
 * finishes it, a later decision can ask again.
 */
function ensureMission(store: Store, base: string, m: Omit<Mission, 'id' | 'date' | 'areas' | 'status' | 'robot' | 'result' | 'note'>): number {
  const open = store.db
    .prepare("SELECT id FROM missions WHERE (key = ? OR key LIKE ? ESCAPE '\\') AND status IN ('requested', 'assigned') ORDER BY id DESC LIMIT 1")
    .get(base, `${base.replace(/[\\%_]/g, '\\$&')}@%`) as { id: number } | undefined;
  if (open) return Number(open.id);
  const key = `${base}@${m.day}`;
  store.db
    .prepare('INSERT INTO missions (key, created_at, day, pen_id, kind, cells_json, priority, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING')
    .run(key, now(), m.day, m.penId, m.kind, JSON.stringify(m.cells), m.priority, m.reason, now());
  return Number((store.db.prepare('SELECT id FROM missions WHERE key = ?').get(key) as { id: number }).id);
}

function writeEntry(store: Store, e: Omit<LogEntry, 'id' | 'date' | 'loggedAt'>): void {
  store.db
    .prepare(
      `INSERT INTO decision_log (key, logged_at, day, pen_id, entity, outcome, level, rules_json, rules_version, reason, recommend, inputs_json, links_json, alert_key, mission_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
    )
    .run(
      `${e.day}|${e.entity}|${e.rulesVersion}`, now(), e.day, e.penId, e.entity, e.outcome, e.level, JSON.stringify(e.rules), e.rulesVersion,
      e.reason, e.recommend, JSON.stringify(e.inputs), JSON.stringify(e.links), e.alertKey, e.missionId,
    );
}

function alreadyLogged(store: Store, day: number, rulesVersion: string): boolean {
  return store.db.prepare('SELECT 1 FROM decision_log WHERE day = ? AND rules_version = ? LIMIT 1').get(day, rulesVersion) !== undefined;
}

/**
 * Records every non-OK decision for `day` under the current rules, with its inputs, memory links
 * and missions. Safe to call repeatedly: a day is recorded once per rules version.
 */
export async function recordDay(store: Store, day: number, model: Experimental_DecisionModel | null): Promise<number> {
  const config = store.config();
  if (alreadyLogged(store, day, rulesVersion(config))) return 0;
  const reviews = store.reviews();
  let written = 0;
  for (const pen of world.pens) {
    const d = penDecisions(pen.id, day, config, reviews);
    const base = { day, penId: pen.id, rulesVersion: d.rulesVersion };

    // Stale areas become one coverage mission per pen instead of one per cell.
    const stale = d.cells.filter((c) => c.outcome.rules[0] === 'N1');
    const coverageId = stale.length > 0
      ? ensureMission(store, `coverage:${pen.id}`, { day, penId: pen.id, kind: 'coverage', cells: stale.map((c) => c.cell), priority: 'normal', reason: `${stale.length} areas not seen for 14+ days.` })
      : null;

    for (const c of d.cells) {
      const rule = c.outcome.rules[0];
      const missionId = rule === 'N1' ? coverageId
        : rule === 'N3' || rule === 'N4' ? ensureMission(store, `inspect:${pen.id}:${c.cell}`, { day, penId: pen.id, kind: 'close_inspection', cells: [c.cell], priority: rule === 'N3' ? 'high' : 'normal', reason: c.outcome.reason })
        : null;
      const alertKey = c.outcome.kind === 'ALERT' ? (rule === 'N2' ? `forecast:${pen.id}:${day}` : `net:${pen.id}:${c.cell}:${day}`) : null;
      writeEntry(store, { ...base, entity: `cell:${pen.id}:${c.cell}`, outcome: c.outcome.kind, level: c.outcome.level ?? null, rules: c.outcome.rules, reason: c.outcome.reason, recommend: c.outcome.recommend ?? null, inputs: { area: c.label, score: Number(c.score.toFixed(3)), level: c.level, factors: c.factors }, links: [], alertKey, missionId });
      written++;
    }

    for (const f of d.findings.filter((x) => x.outcome !== null)) {
      const outcome = f.outcome as Outcome;
      const link = await sameFinding(findingById(f.id), store, model);
      const missionId = outcome.kind === 'SAMPLE_MORE' ? ensureMission(store, `reimage:${f.id}`, { day, penId: pen.id, kind: 'reimage', cells: [f.cell], priority: 'normal', reason: outcome.reason }) : null;
      writeEntry(store, { ...base, entity: `finding:${f.id}`, outcome: outcome.kind, level: outcome.level ?? null, rules: outcome.rules, reason: outcome.reason, recommend: outcome.recommend ?? null, inputs: { kind: f.kind, area: f.label, confidence: Number(f.confidence.toFixed(2)) }, links: link ? [linkOf(link)] : [], alertKey: outcome.kind === 'ALERT' ? `finding:${f.id}` : null, missionId });
      written++;
    }

    const o = d.oxygen;
    if (o.kind !== 'OK' || o.flaggedSensors.length > 0) {
      const links = o.kind === 'ALERT' ? (await similarEpisodes({ kind: 'oxygen', penId: pen.id, day, text: oxygenEventText(pen.id, day, o.reason) }, store, model)).map(linkOf) : [];
      const missionId = o.kind === 'SAMPLE_MORE' ? ensureMission(store, `resample:${pen.id}`, { day, penId: pen.id, kind: 'resample_oxygen', cells: [], priority: 'high', reason: o.reason }) : null;
      const min = o.min ? { source: o.min.id, oxygen: Number(o.min.oxygen.toFixed(1)), depth: o.min.depth } : null;
      writeEntry(store, { ...base, entity: `oxygen:${pen.id}`, outcome: o.kind, level: o.level ?? null, rules: o.rules, reason: o.reason, recommend: o.recommend ?? null, inputs: { lowest: min, lowSources: o.lowSources.length, flaggedSensors: o.flaggedSensors }, links, alertKey: o.kind === 'ALERT' ? `o2:${pen.id}:${day}` : null, missionId });
      written++;
    }
  }
  return written;
}

function toEntry(r: Record<string, unknown>): LogEntry {
  return {
    id: Number(r.id), day: Number(r.day), date: dayLabel(Number(r.day)), loggedAt: String(r.logged_at), penId: Number(r.pen_id),
    entity: String(r.entity), outcome: r.outcome as Outcome['kind'], level: (r.level as string) ?? null, rules: JSON.parse(String(r.rules_json)),
    rulesVersion: String(r.rules_version), reason: String(r.reason), recommend: (r.recommend as string) ?? null,
    inputs: JSON.parse(String(r.inputs_json)), links: JSON.parse(String(r.links_json)), alertKey: (r.alert_key as string) ?? null,
    missionId: r.mission_id === null ? null : Number(r.mission_id),
  };
}

function toMission(r: Record<string, unknown>): Mission {
  const cells = JSON.parse(String(r.cells_json)) as number[];
  return {
    id: Number(r.id), day: Number(r.day), date: dayLabel(Number(r.day)), penId: Number(r.pen_id), kind: r.kind as MissionKind,
    cells, areas: cells.map(cellLabel), priority: r.priority as Mission['priority'], reason: String(r.reason),
    status: r.status as MissionStatus, robot: (r.robot as string) ?? null, result: (r.result as string) ?? null, note: (r.note as string) ?? null,
  };
}

export function logEntries(store: Store, filter: { day?: number; penId?: number; entity?: string }): LogEntry[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.day !== undefined) { where.push('day = ?'); args.push(filter.day); }
  if (filter.penId !== undefined) { where.push('pen_id = ?'); args.push(filter.penId); }
  if (filter.entity !== undefined) { where.push('entity = ?'); args.push(filter.entity); }
  const sql = `SELECT * FROM decision_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY day, id`;
  return (store.db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map(toEntry);
}

export function missions(store: Store, filter: { status?: MissionStatus; penId?: number }): Mission[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  if (filter.penId !== undefined) { where.push('pen_id = ?'); args.push(filter.penId); }
  const sql = `SELECT * FROM missions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority = 'high' DESC, id`;
  return (store.db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map(toMission);
}

/** A robot (or the simulator) reports progress on a mission. */
export function updateMission(store: Store, id: number, update: { status: MissionStatus; robot?: string; result?: string; note?: string }): Mission {
  const result = store.db
    .prepare('UPDATE missions SET status = ?, robot = COALESCE(?, robot), result = COALESCE(?, result), note = COALESCE(?, note), updated_at = ? WHERE id = ?')
    .run(update.status, update.robot ?? null, update.result ?? null, update.note ?? null, now(), id);
  if (result.changes === 0) throw new Error(`unknown mission ${id}`);
  return missions(store, {}).find((m) => m.id === id) as Mission;
}

export interface TraceStep {
  date: string;
  saw: Record<string, unknown>;
  decided: { outcome: string; level: string | null; rules: string[]; rulesVersion: string; reason: string; links: LogEntry['links'] };
  did: { mission: Mission | null; alert: string | null; recommend: string | null };
  outcome: { mission: string | null; alert: string | null; review: string | null };
}

/** Everything the layer decided about one entity, oldest first: saw → decided → did → outcome. */
export function trace(store: Store, entity: string): TraceStep[] {
  const closures = store.alertClosures();
  const reviews = store.reviews();
  const allMissions = new Map(missions(store, {}).map((m) => [m.id, m]));
  const findingId = entity.startsWith('finding:') ? Number(entity.split(':')[1]) : null;
  return logEntries(store, { entity }).map((e) => {
    const mission = e.missionId === null ? null : allMissions.get(e.missionId) ?? null;
    const closure = e.alertKey ? closures.get(e.alertKey) : undefined;
    return {
      date: e.date,
      saw: e.inputs,
      decided: { outcome: e.outcome, level: e.level, rules: e.rules, rulesVersion: e.rulesVersion, reason: e.reason, links: e.links },
      did: { mission, alert: e.alertKey, recommend: e.recommend },
      outcome: {
        mission: mission ? `${mission.status}${mission.result ? `: ${mission.result}` : ''}` : null,
        alert: e.alertKey ? (closure ? `${closure.status}${closure.reason ? `: ${closure.reason}` : ''}` : 'open') : null,
        review: findingId !== null ? (reviews.get(findingId) ?? null) : null,
      },
    };
  });
}
