/**
 * Stage 2 of an inspection: the close-ups are back. Does a person need to look?
 *
 *   survey photos ─▶ detector ─▶ d1 #1 (grade-d1.ts): which cells need a closer look, in what order
 *     ─▶ plan ─▶ ROVs fly closer and take close-ups ─▶ missions close with a result (inspection.ts)
 *     ─▶ d1 #2 (here), on each mission's own close-ups: is it critical? does an engineer need to see it?
 *        are the photos enough to plan a repair?
 *     ─▶ critical: the report agent drafts a report with the photos for the engineer (report.ts)
 *     ─▶ the engineer approves, edits or rejects it (the review queue)
 *     ─▶ every reviewed case, tagged with its farm, is exported as training data for the detector,
 *        for d1 #2's thresholds and for the report writer; cases from other farms can be imported
 *
 * d1 answers yes/no questions with probabilities; code sets the thresholds (decideFromAnswers).
 * d1 can raise a case to an engineer, but it can't close one the rules call a confirmed opening:
 * those always reach a person. Without d1 (no key, an error) the rules decide and say so.
 *
 * Cases live in the `escalations` table. Store.reset() leaves it alone on purpose: it is the case
 * library (engineers' verdicts), and each case is keyed on farm, sim run and mission, so a new run
 * after a reset never collides with an old case. `forget-cases` clears it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRID } from './contracts.ts';
import { describePhoto, neighbours, summarise, type Ask } from './grade-d1.ts';
import { CLOSE_UP_M, assessCell, creditByCell, observations, observationsByCell, type CellAssessment, type CellStatus, type Observation } from './inspection.ts';
import { missions, type Mission } from './log.ts';
import { draftReport, type CaseFacts, type Escalation, type Evidence } from './report.ts';
import type { Store } from './store.ts';
import { cellLabel, explainRisk, penSim } from './world.ts';

export type { Escalation } from './report.ts';
export const ESCALATION_VERSION = 'escalate-v1';
export const FARM_ID = process.env.FARM_ID || 'farm-demo';
/** After this many close-up missions on a cell without a clear answer, a person decides. */
export const MAX_REINSPECT = 2;

/** d1 #2: one call per closed mission, on the mission's own close-ups. */
export const ESCALATION_QUESTIONS = {
  critical: 'Is this most likely a defect that could let fish escape, or that needs a repair within 24 hours (an open hole, or broken twine that could tear further)?',
  needs_human: 'Is the evidence ambiguous or the stakes high enough that a net engineer should look at these photos before the farm acts on them?',
  sufficient: 'Are these close-ups clear and complete enough for an engineer to plan a repair from them, without another dive?',
  recurring: 'Does this look like the continuation of an earlier finding on this cell or a neighbouring cell?',
} as const;
export type EscalationAnswers = Record<keyof typeof ESCALATION_QUESTIONS, number>;

export type ReviewStatus = 'pending' | 'not_needed' | 'approved' | 'edited' | 'rejected';
export type Verdict = 'real' | 'false_alarm';

export interface Decision {
  decision: Escalation;
  reason: string;
}

/** The thresholds for d1 #2's answers. `a` is the rules' view of the same close-ups. */
export function decideFromAnswers(a: CellAssessment, p: EscalationAnswers, attempts: number): Decision {
  const f = (x: number) => x.toFixed(2);
  if (p.critical >= 0.7) return { decision: 'critical', reason: `d1 #2: critical ${f(p.critical)} (fish could escape or repair within 24 h).` };
  if (a.status === 'confirmed_opening') {
    // The backstop: an opening seen from two viewpoints always reaches a person.
    return p.critical >= 0.4
      ? { decision: 'critical', reason: `Opening confirmed from ${a.openingViews} viewpoints by the rules; d1 #2 critical ${f(p.critical)}.` }
      : { decision: 'human_review', reason: `Opening confirmed from ${a.openingViews} viewpoints by the rules, but d1 #2 doubts it is critical (${f(p.critical)}): an engineer decides.` };
  }
  if (p.needs_human >= 0.5) return { decision: 'human_review', reason: `d1 #2: an engineer should look (${f(p.needs_human)}); critical ${f(p.critical)}.` };
  if (p.sufficient < 0.4) {
    return attempts < MAX_REINSPECT
      ? { decision: 'reinspect', reason: `d1 #2: the close-ups don't settle it (sufficient ${f(p.sufficient)}): the robots look again.` }
      : { decision: 'human_review', reason: `Still unclear after ${attempts} close-up missions (sufficient ${f(p.sufficient)}): an engineer decides.` };
  }
  if (a.status === 'clear' && p.critical < 0.2 && p.needs_human < 0.3) return { decision: 'auto_close', reason: `Close-ups clear by the rules and d1 #2 (critical ${f(p.critical)}, engineer ${f(p.needs_human)}).` };
  return { decision: 'monitor', reason: `Not critical (${f(p.critical)}), no engineer needed (${f(p.needs_human)}): keep watching at the next survey.` };
}

/** The fallback when d1 can't answer: the rules' status of the close-ups decides. */
export function decideByRules(a: CellAssessment, sizeM: number | null, attempts: number): Decision {
  const size = sizeM !== null ? `, about ${sizeM.toFixed(2)} m across` : '';
  switch (a.status) {
    case 'confirmed_opening':
      return { decision: 'critical', reason: `Rules: opening confirmed from ${a.openingViews} viewpoints (p=${a.opening.toFixed(2)}${size}).` };
    case 'possible_opening':
      return { decision: 'human_review', reason: `Rules: possible opening (p=${a.opening.toFixed(2)}${size}) from one viewpoint only: an engineer checks.` };
    case 'wear':
      return { decision: 'human_review', reason: `Rules: wear sign on the close-ups (p=${a.wear.toFixed(2)}): an engineer decides whether to repair.` };
    case 'uncertain':
    case 'unclear':
      return attempts < MAX_REINSPECT
        ? { decision: 'reinspect', reason: `Rules: close-ups ${a.status} (quality ${a.quality.toFixed(2)}): the robots look again.` }
        : { decision: 'human_review', reason: `Rules: still ${a.status} after ${attempts} close-up missions: an engineer decides.` };
    case 'fouled':
      return { decision: 'monitor', reason: `Rules: fouling ${Math.round(a.fouling * 100)}%, no defect seen: watch it.` };
    default:
      return { decision: 'auto_close', reason: `Rules: ${a.images} good close-up${a.images === 1 ? '' : 's'}, nothing found.` };
  }
}

const needsPerson = (d: Escalation) => d === 'critical' || d === 'human_review';

const OPENING = new Set(['hole', 'mesh_opening']);
function largestOpening(obs: Observation[]): number | null {
  const sizes = obs.flatMap((o) => o.detections.filter((d) => OPENING.has(d.class) && d.size_m !== undefined).map((d) => d.size_m as number));
  return sizes.length ? Math.max(...sizes) : null;
}

const best = (o: Observation) => Math.max(0, ...o.detections.map((d) => d.confidence));
const quality = (o: Observation) => (o.quality ? Math.min(o.quality.visibility, o.quality.sharpness) : 0.6);

/** The photos a person should see first: strongest detections, then the clearest. */
export function pickEvidence(own: Observation[], runDir: string | null, max = 4): Evidence[] {
  const ranked = [...own].sort((a, b) => best(b) - best(a) || quality(b) - quality(a)).slice(0, max);
  return ranked.map((o) => {
    const overlay = `overlays/${o.image}`;
    return {
      image: o.image,
      overlay: runDir && existsSync(join(runDir, overlay)) ? overlay : null,
      auv: o.auv,
      standoffM: o.standoffM,
      found: o.detections.length
        ? o.detections.map((d) => `${d.class} ${d.confidence.toFixed(2)}${d.size_m !== undefined ? ` (${d.size_m.toFixed(2)} m)` : ''}`).join(', ')
        : 'nothing on this cell',
    };
  });
}

// ------------------------------------------------------------------ the case library

export function ensureEscalations(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'local',
      farm_id TEXT NOT NULL, pen_id INTEGER NOT NULL, cell INTEGER NOT NULL, cell_label TEXT NOT NULL,
      run_id TEXT NOT NULL, mission_id INTEGER NOT NULL, run_dir TEXT, rules_status TEXT NOT NULL,
      decision TEXT NOT NULL, decided_by TEXT NOT NULL, model TEXT, probs_json TEXT, reason TEXT NOT NULL,
      stage1 TEXT, evidence_json TEXT NOT NULL, detections_json TEXT NOT NULL,
      report_md TEXT, report_by TEXT, report_path TEXT,
      review_status TEXT NOT NULL, verdict TEXT, reviewer TEXT, review_note TEXT, final_report_md TEXT,
      reviewed_at TEXT, created_at TEXT NOT NULL, version TEXT NOT NULL);
  `);
}

export interface Case {
  caseNo: number;
  caseId: string;
  source: 'local' | 'imported';
  farmId: string;
  penId: number;
  cell: number;
  cellLabel: string;
  runId: string;
  missionId: number;
  runDir: string | null;
  rulesStatus: CellStatus;
  decision: Escalation;
  decidedBy: 'd1' | 'rules';
  model: string | null;
  probabilities: Record<string, number> | null;
  reason: string;
  stage1: string | null;
  evidence: Evidence[];
  detections: Array<{ image: string; model: string; standoff_m: number | null; quality: Observation['quality']; detections: Observation['detections'] }>;
  reportMd: string | null;
  reportBy: string | null;
  reportPath: string | null;
  reviewStatus: ReviewStatus;
  verdict: Verdict | null;
  reviewer: string | null;
  reviewNote: string | null;
  finalReportMd: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

const parse = <T>(s: unknown): T | null => (s === null || s === undefined ? null : (JSON.parse(String(s)) as T));
function toCase(r: Record<string, unknown>): Case {
  return {
    caseNo: Number(r.id), caseId: String(r.case_id), source: r.source as Case['source'], farmId: String(r.farm_id), penId: Number(r.pen_id),
    cell: Number(r.cell), cellLabel: String(r.cell_label), runId: String(r.run_id), missionId: Number(r.mission_id), runDir: (r.run_dir as string) ?? null,
    rulesStatus: r.rules_status as CellStatus, decision: r.decision as Escalation, decidedBy: r.decided_by as Case['decidedBy'], model: (r.model as string) ?? null,
    probabilities: parse(r.probs_json), reason: String(r.reason), stage1: (r.stage1 as string) ?? null, evidence: parse<Evidence[]>(r.evidence_json) ?? [],
    detections: parse<Case['detections']>(r.detections_json) ?? [], reportMd: (r.report_md as string) ?? null, reportBy: (r.report_by as string) ?? null,
    reportPath: (r.report_path as string) ?? null, reviewStatus: r.review_status as ReviewStatus, verdict: (r.verdict as Verdict) ?? null,
    reviewer: (r.reviewer as string) ?? null, reviewNote: (r.review_note as string) ?? null, finalReportMd: (r.final_report_md as string) ?? null,
    reviewedAt: (r.reviewed_at as string) ?? null, createdAt: String(r.created_at),
  };
}

export function cases(store: Store, filter: { reviewStatus?: ReviewStatus; farmId?: string; source?: 'local' | 'imported' } = {}): Case[] {
  ensureEscalations(store);
  const where: string[] = [];
  const args: string[] = [];
  if (filter.reviewStatus) { where.push('review_status = ?'); args.push(filter.reviewStatus); }
  if (filter.farmId) { where.push('farm_id = ?'); args.push(filter.farmId); }
  if (filter.source) { where.push('source = ?'); args.push(filter.source); }
  const sql = `SELECT * FROM escalations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY decision = 'critical' DESC, id`;
  return (store.db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map(toCase);
}

export function caseByNo(store: Store, caseNo: number): Case {
  ensureEscalations(store);
  const r = store.db.prepare('SELECT * FROM escalations WHERE id = ?').get(caseNo) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`unknown case ${caseNo}`);
  return toCase(r);
}

/**
 * What engineers decided on earlier cases the rules judged the same way, across every farm in the
 * library: shown to d1 #2 so its call is anchored on how such cases turned out.
 */
export function fleetCalibration(store: Store, status: CellStatus): string {
  ensureEscalations(store);
  const rows = store.db.prepare("SELECT verdict, farm_id FROM escalations WHERE rules_status = ? AND verdict IS NOT NULL").all(status) as Array<{ verdict: Verdict; farm_id: string }>;
  if (rows.length === 0) return `No engineer verdicts yet on earlier cases the rules called ${status.replace('_', ' ')}.`;
  const real = rows.filter((r) => r.verdict === 'real').length;
  const farms = new Set(rows.map((r) => r.farm_id)).size;
  return `Engineers reviewed ${rows.length} earlier case${rows.length > 1 ? 's' : ''} the rules called ${status.replace('_', ' ')} (from ${farms} farm${farms > 1 ? 's' : ''}): ${real} real defect${real === 1 ? '' : 's'}, ${rows.length - real} false alarm${rows.length - real === 1 ? '' : 's'}.`;
}

/** Engineers' corrections of earlier drafts: examples for the report agent. Newest first. */
export function reportExamples(store: Store, max = 2): Array<{ draft: string; final: string }> {
  ensureEscalations(store);
  const rows = store.db.prepare("SELECT report_md, final_report_md FROM escalations WHERE review_status = 'edited' AND report_md IS NOT NULL AND final_report_md IS NOT NULL ORDER BY reviewed_at DESC LIMIT ?").all(max) as Array<{ report_md: string; final_report_md: string }>;
  return rows.map((r) => ({ draft: r.report_md, final: r.final_report_md }));
}

/** The text d1 #2 sees for one closed mission. */
export function escalationState(m: Mission, own: Observation[], byCell: Map<number, Observation[]>, ctx: { risk: ReturnType<typeof explainRisk>; earlier: string[]; fleet: string; attempts: number }): string {
  const cell = m.cells[0];
  const row = Math.floor(cell / GRID.sectors);
  const depthPart = row <= 1 ? 'upper wall, near the surface' : row >= GRID.wallRows - 2 ? 'lower wall, near the bottom' : 'middle of the wall';
  const ranked = [...own].sort((a, b) => best(b) - best(a)).slice(0, 10);
  const lines = [
    'Underwater inspection of one circular fish-farm net pen by small robots with cameras.',
    'The robots surveyed the whole net from far away; a first decision sent them closer to this cell; they are back with close-ups.',
    'The decision now: is this critical (fish could escape, or a repair is needed within 24 hours), should a net engineer look at the photos,',
    'and are the close-ups enough to plan a repair. A false "critical" costs a diver call-out; a missed hole can cost the fish in the pen.',
    'The detector is a classical computer-vision net inspector. Its confidences are not calibrated probabilities.',
    '"mesh_opening" is a gap it could not commit to calling a hole; "thinning" comes from how wide the twine looks.',
    '',
    `Cell ${cell}: ${cellLabel(cell)}, ${depthPart}. A cell is about 2 m wide and 1 m high.`,
    `Risk model for this area: ${ctx.risk.level} (${ctx.risk.score.toFixed(2)}).`,
    `Why the robots were sent: ${m.reason}`,
    `What the close-ups showed, by the rules${m.result?.includes('| d1:') ? ' and by the first decision' : ''}: ${m.result ?? 'no result'}`,
    `Close-up missions on this cell so far: ${ctx.attempts}.`,
    `Close-ups of this cell (${own.length}${own.length > ranked.length ? `, ${ranked.length} most informative shown` : ''}):`,
    ...ranked.map(describePhoto),
    'Neighbouring cells:',
    ...neighbours(cell).map((n) => `- Cell ${n.cell} (${n.where}): ${summarise(n.cell, byCell.get(n.cell))}.`),
    ctx.earlier.length ? `Earlier on this cell and next to it: ${ctx.earlier.join(' | ')}` : 'Nothing earlier on this cell or next to it.',
    ctx.fleet,
  ];
  let state = lines.join('\n');
  if (state.length > 5900) state = `${state.slice(0, 5880)}\n(truncated)`;
  return state;
}

/** d1 #2 behind the store's cache, keyed on the exact text sent. */
export async function d1EscalationAsk(store: Store): Promise<{ ask: Ask; model: string } | null> {
  const { defaultDecisionModel, askYesNo, DECISION_MODEL } = await import('./d1.ts');
  const model = defaultDecisionModel();
  if (!model) return null;
  const ask: Ask = async (state, questions) => {
    const key = `escalate:${DECISION_MODEL}:${createHash('sha256').update(state + JSON.stringify(questions)).digest('hex').slice(0, 20)}`;
    const hit = store.cached<Record<string, { probability: number }>>(key);
    if (hit) return hit;
    const answers = await askYesNo(model, state, questions);
    store.cache(key, answers);
    return answers;
  };
  return { ask, model: DECISION_MODEL };
}

export interface EscalateResult {
  caseNo: number;
  missionId: number;
  cell: number;
  decision: Escalation;
  decidedBy: 'd1' | 'rules';
  reason: string;
  reportPath: string | null;
  reportBy: string | null;
  fellBack: string | null;
}

/**
 * Decides every closed close-up mission of a pen that has no case yet (`again`: also re-decides
 * cases nobody has reviewed). Critical cases get a report from the agent, cases for review a
 * template card; both are written to <runDir>/reports/case_<n>_m<id>.md when runDir is given.
 */
export async function escalateMissions(
  store: Store,
  input: { penId: number; day: number; ask: Ask | null; model?: string | null; runDir?: string | null; missionIds?: number[]; again?: boolean; agent?: boolean; farmId?: string },
): Promise<EscalateResult[]> {
  ensureEscalations(store);
  const farmId = input.farmId ?? FARM_ID;
  const runDir = input.runDir ?? null;
  const byCell = observationsByCell(store, input.penId);
  const sim = penSim(input.penId);
  const all = missions(store, { penId: input.penId });
  const chosen = all.filter((m) => m.status === 'done' && m.cells.length > 0 && (m.kind === 'close_inspection' || m.kind === 'reimage') && (!input.missionIds || input.missionIds.includes(m.id)));
  const out: EscalateResult[] = [];

  for (const m of chosen) {
    const cell = m.cells[0];
    // The mission's own photos, credited to its cell (a close-up can also show the next cell).
    const ownAll = observations(store, { penId: input.penId, targetId: `m${m.id}` });
    if (ownAll.length === 0) continue;
    const own = creditByCell(ownAll).get(cell) ?? [];
    if (own.length === 0) continue;
    const runId = ownAll[0].runId;
    const caseId = `${farmId}:${runId}:m${m.id}`;
    const existing = store.db.prepare('SELECT id, review_status FROM escalations WHERE case_id = ?').get(caseId) as { id: number; review_status: ReviewStatus } | undefined;
    if (existing && (!input.again || !['pending', 'not_needed'].includes(existing.review_status))) continue;

    const a = assessCell(cell, own);
    const sizeM = largestOpening(own);
    const neighbourCells = new Set([cell, ...neighbours(cell).map((n) => n.cell)]);
    const earlierMissions = all.filter((x) => x.id !== m.id && x.cells.some((c) => neighbourCells.has(c)) && x.result).slice(-4).map((x) => `mission #${x.id} on cell ${x.cells[0]}: ${x.result}`);
    const earlierCases = (store.db.prepare(`SELECT cell, decision, verdict FROM escalations WHERE pen_id = ? AND farm_id = ? AND cell IN (${[...neighbourCells].join(',')}) AND case_id != ? ORDER BY id DESC LIMIT 3`).all(input.penId, farmId, caseId) as Array<{ cell: number; decision: string; verdict: string | null }>)
      .map((c) => `case on cell ${c.cell}: ${c.decision}${c.verdict ? `, engineer said ${c.verdict.replace('_', ' ')}` : ''}`);
    const earlier = [...earlierMissions, ...earlierCases];
    const attempts = all.filter((x) => x.status === 'done' && x.cells[0] === cell && x.id <= m.id && (x.kind === 'close_inspection' || x.kind === 'reimage')).length;
    const risk = explainRisk(sim, cell, input.day);

    let d: Decision;
    let decidedBy: 'd1' | 'rules' = 'rules';
    let probs: EscalationAnswers | null = null;
    let fellBack: string | null = null;
    if (input.ask) {
      const state = escalationState(m, own, byCell, { risk, earlier, fleet: fleetCalibration(store, a.status), attempts });
      try {
        const raw = await input.ask(state, ESCALATION_QUESTIONS);
        probs = Object.fromEntries(Object.keys(ESCALATION_QUESTIONS).map((k) => {
          const v = raw[k]?.probability;
          if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`no answer for ${k}`);
          return [k, Number(v.toFixed(3))];
        })) as EscalationAnswers;
        d = decideFromAnswers(a, probs, attempts);
        decidedBy = 'd1';
      } catch (err) {
        fellBack = err instanceof Error ? err.message : String(err);
        d = decideByRules(a, sizeM, attempts);
        d = { ...d, reason: `${d.reason} (d1 #2 unavailable: ${fellBack.slice(0, 80)})` };
      }
    } else {
      d = decideByRules(a, sizeM, attempts);
    }

    const evidence = pickEvidence(own, runDir);
    const detections = own.map((o) => ({ image: o.image, model: o.model, standoff_m: o.standoffM, quality: o.quality, detections: o.detections }));
    const now = new Date().toISOString();
    const robots = [...new Set(own.map((o) => o.auv).filter((x): x is number => x !== null))].map((k) => `AUV-${k}`);
    const label = cellLabel(cell);

    store.db.prepare(`
      INSERT INTO escalations (case_id, source, farm_id, pen_id, cell, cell_label, run_id, mission_id, run_dir, rules_status, decision, decided_by, model,
        probs_json, reason, stage1, evidence_json, detections_json, review_status, created_at, version)
      VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET run_dir = excluded.run_dir, rules_status = excluded.rules_status, decision = excluded.decision,
        decided_by = excluded.decided_by, model = excluded.model, probs_json = excluded.probs_json, reason = excluded.reason, stage1 = excluded.stage1,
        evidence_json = excluded.evidence_json, detections_json = excluded.detections_json, review_status = excluded.review_status,
        report_md = NULL, report_by = NULL, report_path = NULL, version = excluded.version`,
    ).run(caseId, farmId, input.penId, cell, label, runId, m.id, runDir, a.status, d.decision, decidedBy, decidedBy === 'd1' ? (input.model ?? null) : null,
      probs ? JSON.stringify(probs) : null, d.reason, m.result, JSON.stringify(evidence), JSON.stringify(detections), needsPerson(d.decision) ? 'pending' : 'not_needed', now, ESCALATION_VERSION);
    const caseNo = (store.db.prepare('SELECT id FROM escalations WHERE case_id = ?').get(caseId) as { id: number }).id;

    let reportPath: string | null = null;
    let reportBy: string | null = null;
    if (needsPerson(d.decision)) {
      const reportDir = runDir ? join(runDir, 'reports') : null;
      const facts: CaseFacts = {
        caseNo, missionId: m.id, farmId, penId: input.penId, cell, cellLabel: label, decision: d.decision, decidedBy, model: decidedBy === 'd1' ? (input.model ?? null) : null,
        reason: d.reason, probabilities: probs, missionReason: m.reason, stage1: m.result, robots, sizeM, risk: `${risk.level} (${risk.score.toFixed(2)})`, earlier, evidence, createdAt: now,
      };
      // Only critical cases get the agent; a case for review gets the template card with the photos.
      const draft = await draftReport(facts, { agent: d.decision === 'critical' && input.agent !== false, examples: reportExamples(store), reportDir, runDir });
      reportBy = draft.by;
      if (reportDir) {
        mkdirSync(reportDir, { recursive: true });
        reportPath = join(reportDir, `case_${caseNo}_m${m.id}.md`);
        writeFileSync(reportPath, draft.md);
      }
      store.db.prepare('UPDATE escalations SET report_md = ?, report_by = ?, report_path = ? WHERE id = ?').run(draft.md, draft.by, reportPath, caseNo);
    }
    out.push({ caseNo, missionId: m.id, cell, decision: d.decision, decidedBy, reason: d.reason, reportPath, reportBy, fellBack });
  }
  return out;
}

// ------------------------------------------------------------------ the engineer's review

/**
 * The engineer's verdict on a case. `real` with a changed report files it as edited (the edit is
 * what the report agent learns from); `false_alarm` rejects it (what the detector and d1 #2 learn
 * from). Engineers can also review cases nobody asked them about: a missed defect is the most
 * valuable label there is.
 */
export function reviewCase(store: Store, caseNo: number, input: { verdict: Verdict; reviewer?: string; note?: string; finalReportMd?: string }): Case {
  const c = caseByNo(store, caseNo);
  if (c.source !== 'local') throw new Error(`case ${caseNo} was imported from ${c.farmId}; review it there`);
  const edited = input.finalReportMd !== undefined && input.finalReportMd.trim() !== (c.reportMd ?? '').trim();
  const status: ReviewStatus = input.verdict === 'false_alarm' ? 'rejected' : edited ? 'edited' : 'approved';
  store.db.prepare('UPDATE escalations SET review_status = ?, verdict = ?, reviewer = ?, review_note = ?, final_report_md = ?, reviewed_at = ? WHERE id = ?').run(
    status, input.verdict, input.reviewer ?? null, input.note ?? null, input.verdict === 'real' ? (input.finalReportMd ?? c.reportMd) : null, new Date().toISOString(), caseNo,
  );
  return caseByNo(store, caseNo);
}

/** How often the engineers agreed with the escalation: the number to watch as farms join. */
export function agreement(store: Store): { reviewed: number; escalatedReal: number; escalatedFalse: number; missed: number; reportsEdited: number } {
  const reviewed = cases(store).filter((c) => c.verdict !== null);
  const escalated = reviewed.filter((c) => needsPerson(c.decision));
  return {
    reviewed: reviewed.length,
    escalatedReal: escalated.filter((c) => c.verdict === 'real').length,
    escalatedFalse: escalated.filter((c) => c.verdict === 'false_alarm').length,
    missed: reviewed.filter((c) => !needsPerson(c.decision) && c.verdict === 'real').length,
    reportsEdited: reviewed.filter((c) => c.reviewStatus === 'edited').length,
  };
}

// ------------------------------------------------------------------ cases between farms

export const CASE_SCHEMA = 'abyss-case-v1';

/** One case as training data: the photos, what each model said, and what the engineer decided. */
export function caseRecord(c: Case): Record<string, unknown> {
  return {
    schema: CASE_SCHEMA, case_id: c.caseId, farm_id: c.farmId, pen_id: c.penId, cell: c.cell, cell_label: c.cellLabel, run_id: c.runId,
    mission_id: c.missionId, created_at: c.createdAt,
    // Defect identification: the photos and the detector's output on each, with the engineer's label.
    images: c.evidence, detector: c.detections, close_up_m: CLOSE_UP_M,
    // The decisions: the rules and d1 #1 (stage1, the mission result), then d1 #2.
    rules_status: c.rulesStatus, stage1: c.stage1,
    stage2: { decision: c.decision, decided_by: c.decidedBy, model: c.model, probabilities: c.probabilities, reason: c.reason, version: ESCALATION_VERSION },
    engineer: { review_status: c.reviewStatus, verdict: c.verdict, reviewer: c.reviewer, note: c.reviewNote, reviewed_at: c.reviewedAt },
    // Report writing: the agent's draft and what the engineer filed.
    report: { draft_md: c.reportMd, draft_by: c.reportBy, final_md: c.finalReportMd, edited: c.reviewStatus === 'edited' },
  };
}

/** Cases from another farm's export, for calibration and report examples here. Returns how many were new. */
export function importCases(store: Store, records: unknown[]): number {
  ensureEscalations(store);
  const insert = store.db.prepare(`
    INSERT INTO escalations (case_id, source, farm_id, pen_id, cell, cell_label, run_id, mission_id, rules_status, decision, decided_by, model, probs_json,
      reason, stage1, evidence_json, detections_json, report_md, report_by, review_status, verdict, reviewer, review_note, final_report_md, reviewed_at, created_at, version)
    VALUES (?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(case_id) DO NOTHING`);
  let added = 0;
  for (const raw of records) {
    const r = raw as Record<string, any>;
    if (r?.schema !== CASE_SCHEMA || typeof r.case_id !== 'string') continue;
    const res = insert.run(
      r.case_id, String(r.farm_id), Number(r.pen_id), Number(r.cell), String(r.cell_label ?? ''), String(r.run_id ?? ''), Number(r.mission_id ?? 0),
      String(r.rules_status), String(r.stage2?.decision), String(r.stage2?.decided_by ?? 'rules'), r.stage2?.model ?? null,
      r.stage2?.probabilities ? JSON.stringify(r.stage2.probabilities) : null, String(r.stage2?.reason ?? ''), r.stage1 ?? null,
      JSON.stringify(r.images ?? []), JSON.stringify(r.detector ?? []), r.report?.draft_md ?? null, r.report?.draft_by ?? null,
      String(r.engineer?.review_status ?? 'not_needed'), r.engineer?.verdict ?? null, r.engineer?.reviewer ?? null, r.engineer?.note ?? null,
      r.report?.final_md ?? null, r.engineer?.reviewed_at ?? null, String(r.created_at ?? new Date().toISOString()), String(r.stage2?.version ?? CASE_SCHEMA),
    );
    added += Number(res.changes);
  }
  return added;
}

export function forgetCases(store: Store): void {
  ensureEscalations(store);
  store.db.exec("DELETE FROM escalations; DELETE FROM sqlite_sequence WHERE name = 'escalations';");
}
