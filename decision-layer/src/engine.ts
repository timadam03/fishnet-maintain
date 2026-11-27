/**
 * Runs every rule for a pen and day against the UI's world, and collects the alerts.
 * Pure recomputation: the same day, config and reviews always give the same decisions.
 */
import { findingStatus } from './memory.ts';
import { decideCell, decideFinding } from './rules/net.ts';
import { decideOxygen, type OxygenDecision, type OxygenSource } from './rules/oxygen.ts';
import { rulesVersion, type AlertLevel, type Outcome, type RulesConfig } from './rules/types.ts';
import { CELLS, cellLabel, cellRow, cellsSeenOn, explainRisk, penSim, rowDepth, sensorProfile, waterAt, world, type Finding } from './world.ts';

export interface CellDecision {
  cell: number;
  label: string;
  score: number;
  level: string;
  /** Top three factors behind the score, from the UI's risk model. */
  factors: string[];
  outcome: Outcome;
}

export interface FindingDecision {
  id: number;
  kind: string;
  cell: number;
  label: string;
  confidence: number;
  detectedDay: number;
  status: string;
  /** Only for findings detected on the decision day. */
  outcome: Outcome | null;
}

export interface PenDecisions {
  penId: number;
  day: number;
  rulesVersion: string;
  /** Cells whose outcome is not OK. */
  cells: CellDecision[];
  okCells: number;
  oxygen: OxygenDecision;
  findings: FindingDecision[];
}

export interface Alert {
  key: string;
  penId: number;
  day: number;
  source: 'net' | 'oxygen' | 'finding';
  ref: string;
  level: AlertLevel;
  title: string;
  reason: string;
  recommend: string | null;
  rules: string[];
  status: 'open' | 'confirmed' | 'dismissed';
  closedReason: string | null;
}

export function oxygenSources(penId: number, day: number): OxygenSource[] {
  const sensors: OxygenSource[] = sensorProfile(world, penId, day).map((s) => ({
    id: `sensor ${s.depth} m`,
    kind: 'sensor',
    depth: s.depth,
    oxygen: s.oxygen,
    readingDay: s.readingDay,
  }));
  const drones: OxygenSource[] = cellsSeenOn(penId, day).map((cell) => {
    const [d0, d1] = rowDepth(cellRow(cell));
    return { id: `drone at ${cellLabel(cell)}`, kind: 'drone', depth: (d0 + d1) / 2, oxygen: waterAt(world, penId, cell, day).oxygen, readingDay: day };
  });
  return [...sensors, ...drones];
}

export function penDecisions(penId: number, day: number, config: RulesConfig, reviews: Map<number, string>): PenDecisions {
  const sim = penSim(penId);
  const cells: CellDecision[] = [];
  for (let cell = 0; cell < CELLS; cell++) {
    const risk = explainRisk(sim, cell, day);
    const outcome = decideCell(risk);
    if (outcome.kind === 'OK') continue;
    // Consequence always has weight 1 in the UI's model, so rank condition and exposure factors only.
    const factors = risk.factors.filter((f) => f.group !== 'consequence').sort((a, b) => b.weight - a.weight).slice(0, 3).map((f) => f.label);
    cells.push({ cell, label: cellLabel(cell), score: risk.score, level: risk.level, factors, outcome });
  }
  cells.sort((a, b) => b.score - a.score);

  const findings = world.findings
    .filter((f) => f.penId === penId && f.detectedDay <= day)
    .map((f): FindingDecision => ({
      id: f.id,
      kind: f.kind,
      cell: f.cell,
      label: cellLabel(f.cell),
      confidence: f.confidence,
      detectedDay: f.detectedDay,
      status: findingStatus(f, day, reviews),
      outcome: f.detectedDay === day ? decideFinding(f, config) : null,
    }))
    .filter((f) => f.outcome !== null || f.status === 'unreviewed');

  return {
    penId,
    day,
    rulesVersion: rulesVersion(config),
    cells,
    okCells: CELLS - cells.length,
    oxygen: decideOxygen(oxygenSources(penId, day), day),
    findings,
  };
}

/** All alerts on the site for `day`, with their closure status. */
export function siteAlerts(
  day: number,
  config: RulesConfig,
  reviews: Map<number, string>,
  closures: Map<string, { status: 'confirmed' | 'dismissed'; reason: string | null }>,
): Alert[] {
  const alerts: Array<Omit<Alert, 'status' | 'closedReason'>> = [];
  for (const pen of world.pens) {
    const d = penDecisions(pen.id, day, config, reviews);
    // Forecast alerts (N2) are grouped into one per pen, so a storm forecast doesn't flood the feed.
    const forecast = d.cells.filter((c) => c.outcome.rules[0] === 'N2');
    if (forecast.length > 0) {
      const top = forecast[0];
      alerts.push({ key: `forecast:${pen.id}:${day}`, penId: pen.id, day, source: 'net', ref: `${forecast.length} cells`, level: 'low', title: `${pen.name}, forecast`, reason: `${forecast.length} areas forecast at high risk; highest ${top.label} (${top.score.toFixed(2)}).`, recommend: top.outcome.recommend ?? null, rules: ['N2'] });
    }
    for (const c of d.cells) {
      if (c.outcome.kind !== 'ALERT' || c.outcome.rules[0] === 'N2') continue;
      alerts.push({ key: `net:${pen.id}:${c.cell}:${day}`, penId: pen.id, day, source: 'net', ref: `cell ${c.cell}`, level: c.outcome.level ?? 'low', title: `${pen.name}, ${c.label}`, reason: c.outcome.reason, recommend: c.outcome.recommend ?? null, rules: c.outcome.rules });
    }
    if (d.oxygen.kind === 'ALERT') {
      alerts.push({ key: `o2:${pen.id}:${day}`, penId: pen.id, day, source: 'oxygen', ref: 'oxygen', level: d.oxygen.level ?? 'low', title: `${pen.name}, oxygen`, reason: d.oxygen.reason, recommend: d.oxygen.recommend ?? null, rules: d.oxygen.rules });
    }
    for (const f of d.findings) {
      if (f.outcome?.kind !== 'ALERT') continue;
      alerts.push({ key: `finding:${f.id}`, penId: pen.id, day, source: 'finding', ref: `finding ${f.id}`, level: f.outcome.level ?? 'low', title: `${pen.name}, ${f.kind} at ${f.label}`, reason: f.outcome.reason, recommend: f.outcome.recommend ?? null, rules: f.outcome.rules });
    }
  }
  const order: Record<AlertLevel, number> = { high: 0, medium: 1, low: 2 };
  return alerts
    .sort((a, b) => order[a.level] - order[b.level] || a.penId - b.penId)
    .map((a) => {
      const closed = closures.get(a.key);
      return { ...a, status: closed?.status ?? 'open', closedReason: closed?.reason ?? null };
    });
}

/**
 * Describes an oxygen event for memory questions, including what the farm was doing that day.
 * Without the operations, a decision model can't tell a delousing drop from a natural one.
 */
export function oxygenEventText(penId: number, day: number, reason: string): string {
  const ops = world.operations.filter((o) => o.day === day && (o.penId === penId || o.penId === null) && o.kind !== 'cleaning').map((o) => o.label);
  return `Pen ${penId}: ${reason}${ops.length > 0 ? ` Operations that day: ${ops.join('; ')}.` : ' No farm operations that day.'}`;
}

export function findingById(id: number): Finding {
  const f = world.findings.find((x) => x.id === id);
  if (!f) throw new Error(`unknown finding ${id}`);
  return f;
}
