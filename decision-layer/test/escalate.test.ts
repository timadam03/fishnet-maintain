// d1 #2, the review queue, the report and the case export. Offline: a fake `ask` stands in for d1.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SimCapture, type VisionReport } from '../src/contracts.ts';
import {
  ESCALATION_QUESTIONS, agreement, caseByNo, caseRecord, cases, decideByRules, decideFromAnswers, escalateMissions, fleetCalibration, importCases, reviewCase,
} from '../src/escalate.ts';
import type { Ask } from '../src/grade-d1.ts';
import { buildPlan, importObservations } from '../src/inspection.ts';
import { keepAgentSections } from '../src/report.ts';
import { Store } from '../src/store.ts';
import { TODAY } from '../src/world.ts';

const R = 8;
const PEN = 7;

function capture(i: number, cell: number, standoff: number, auv: number, target_id?: string, run_id = 'run1'): SimCapture {
  const theta = ((cell % 24) + 0.5) * 15 * (Math.PI / 180);
  const r = R - standoff;
  return SimCapture.parse({
    image: `auv_${auv}/img_${String(i).padStart(4, '0')}.png`, run_id, auv, sim_time: i, theta_deg: (theta * 180) / Math.PI,
    depth: -2, position: [r * Math.cos(theta), r * Math.sin(theta), -2], cell, ...(target_id ? { target_id } : {}),
  });
}
const report = (c: SimCapture, detections: VisionReport['detections']): VisionReport => ({
  image: c.image, model: 'net-inspect-cv-v1', quality: { visibility: 0.9, sharpness: 0.9 }, fouling_pct: 0, detections,
});
const hole = (confidence: number, size_m?: number): VisionReport['detections'][number] => ({ class: 'hole', confidence, bbox: [600, 300, 40, 40], ...(size_m ? { size_m } : {}) });

/** Survey sees a possible hole on cell 74, the plan sends a mission, the close-ups come back. */
function closedMission(store: Store, closeUps: VisionReport['detections'][]): number {
  const far = capture(1, 74, 6.5, 0);
  importObservations(store, { penId: PEN, captures: [far], cageRadiusM: R, reports: [report(far, [hole(0.75)])] });
  const plan = buildPlan(store, { penId: PEN, day: TODAY, robots: 3 });
  const t = plan.targets.find((x) => x.cell === 74)!;
  const caps = closeUps.map((_, i) => capture(10 + i, 74, 1.4, i % 2, t.target_id, 'run2'));
  const res = importObservations(store, { penId: PEN, captures: caps, cageRadiusM: R, reports: caps.map((c, i) => report(c, closeUps[i])) });
  assert.equal(res.missionsClosed.length, 1);
  return t.mission_id;
}

const fakeAsk = (p: Partial<Record<keyof typeof ESCALATION_QUESTIONS, number>>, seen: string[] = []): Ask => async (state) => {
  seen.push(state);
  return Object.fromEntries(Object.keys(ESCALATION_QUESTIONS).map((k) => [k, { probability: p[k as keyof typeof p] ?? 0.1 }]));
};

test('thresholds: d1 #2 can raise a case, but a confirmed opening always reaches a person', () => {
  const confirmed = { cell: 74, status: 'confirmed_opening', images: 2, opening: 0.9, openingViews: 2, wear: 0, fouling: 0, quality: 0.9 } as const;
  const clear = { ...confirmed, status: 'clear', opening: 0, openingViews: 0 } as const;
  assert.equal(decideFromAnswers(confirmed, { critical: 0.9, needs_human: 0.2, sufficient: 0.9, recurring: 0 }, 1).decision, 'critical');
  assert.equal(decideFromAnswers(confirmed, { critical: 0.1, needs_human: 0.1, sufficient: 0.9, recurring: 0 }, 1).decision, 'human_review');
  assert.equal(decideFromAnswers(clear, { critical: 0.05, needs_human: 0.1, sufficient: 0.9, recurring: 0 }, 1).decision, 'auto_close');
  assert.equal(decideFromAnswers(clear, { critical: 0.1, needs_human: 0.6, sufficient: 0.9, recurring: 0 }, 1).decision, 'human_review');
  assert.equal(decideFromAnswers(clear, { critical: 0.1, needs_human: 0.1, sufficient: 0.2, recurring: 0 }, 1).decision, 'reinspect');
  assert.equal(decideFromAnswers(clear, { critical: 0.1, needs_human: 0.1, sufficient: 0.2, recurring: 0 }, 2).decision, 'human_review', 'no endless re-inspection');
  assert.equal(decideByRules(confirmed, 0.3, 1).decision, 'critical');
  assert.equal(decideByRules({ ...confirmed, status: 'possible_opening', openingViews: 1 }, null, 1).decision, 'human_review');
  assert.equal(decideByRules(clear, null, 1).decision, 'auto_close');
});

test('a confirmed hole: d1 #2 calls it critical, a report with the photos is written, the engineer approves', async () => {
  const store = new Store(':memory:');
  const id = closedMission(store, [[hole(0.92, 0.3)], [hole(0.88, 0.25)]]); // two robots both see it
  const dir = mkdtempSync(join(tmpdir(), 'esc-'));
  const seen: string[] = [];
  const [r] = await escalateMissions(store, { penId: PEN, day: TODAY, ask: fakeAsk({ critical: 0.93, needs_human: 0.4, sufficient: 0.8 }, seen), model: 'fake/d1', runDir: dir, agent: false });
  assert.equal(r.missionId, id);
  assert.equal(r.decision, 'critical');
  assert.equal(r.decidedBy, 'd1');
  assert.ok(seen[0].length <= 6000 && /Close-ups of this cell \(2\)/.test(seen[0]) && /Why the robots were sent/.test(seen[0]));

  const md = readFileSync(r.reportPath!, 'utf8');
  assert.match(md, /^# CRITICAL/);
  assert.match(md, /about 0\.30 m across/);
  assert.match(md, /!\[photo 1\]\(\.\.\/auv_0\/img_0010\.png\)/, 'image links work from the reports folder');
  assert.equal(cases(store, { reviewStatus: 'pending' }).length, 1);

  // Running it again does nothing: the case exists.
  assert.equal((await escalateMissions(store, { penId: PEN, day: TODAY, ask: fakeAsk({}), runDir: dir, agent: false })).length, 0);

  const c = reviewCase(store, r.caseNo, { verdict: 'real', reviewer: 'site engineer', finalReportMd: `${md}\nDiver booked for 14:00.` });
  assert.equal(c.reviewStatus, 'edited');
  assert.equal(agreement(store).escalatedReal, 1);
  assert.match(fleetCalibration(store, 'confirmed_opening'), /1 earlier case .*1 real defect, 0 false alarms/);
});

test('without d1 the rules decide; a clear close-up closes without bothering anyone', async () => {
  const store = new Store(':memory:');
  closedMission(store, [[], []]);
  const [r] = await escalateMissions(store, { penId: PEN, day: TODAY, ask: null, agent: false });
  assert.equal(r.decision, 'auto_close');
  assert.equal(r.decidedBy, 'rules');
  assert.equal(r.reportPath, null);
  assert.equal(caseByNo(store, r.caseNo).reviewStatus, 'not_needed');
});

test('d1 failing falls back to the rules and says so', async () => {
  const store = new Store(':memory:');
  closedMission(store, [[hole(0.8)], []]); // one robot only: possible opening
  const [r] = await escalateMissions(store, { penId: PEN, day: TODAY, ask: async () => { throw new Error('rate limited'); }, agent: false });
  assert.equal(r.decision, 'human_review');
  assert.equal(r.decidedBy, 'rules');
  assert.match(r.reason, /d1 #2 unavailable: rate limited/);
});

test('cases travel between farms: export, import elsewhere, and the verdicts inform the other farm', async () => {
  const a = new Store(':memory:');
  closedMission(a, [[hole(0.8)], []]);
  const [r] = await escalateMissions(a, { penId: PEN, day: TODAY, ask: null, agent: false, farmId: 'farm-a' });
  reviewCase(a, r.caseNo, { verdict: 'false_alarm', reviewer: 'eng-a', note: 'shadow of a rope' });
  const rec = caseRecord(caseByNo(a, r.caseNo));
  assert.equal((rec.engineer as { verdict: string }).verdict, 'false_alarm');
  assert.ok(Array.isArray(rec.detector) && (rec.detector as unknown[]).length === 2);

  const b = new Store(':memory:');
  assert.equal(importCases(b, [JSON.parse(JSON.stringify(rec)), { schema: 'other' }]), 1);
  assert.equal(importCases(b, [rec]), 0, 'importing twice adds nothing');
  assert.match(fleetCalibration(b, 'possible_opening'), /1 earlier case .*from 1 farm.*0 real defects, 1 false alarm/);
  assert.throws(() => reviewCase(b, cases(b)[0].caseNo, { verdict: 'real' }), /imported from farm-a/);

  // Farm B's own d1 #2 call sees farm A's verdict in its state.
  const seen: string[] = [];
  closedMission(b, [[hole(0.8)], []]);
  await escalateMissions(b, { penId: PEN, day: TODAY, ask: fakeAsk({ needs_human: 0.6 }, seen), agent: false, farmId: 'farm-b' });
  assert.match(seen[0], /Engineers reviewed 1 earlier case the rules called possible opening/);
});

test('the report agent may only write its four sections', () => {
  const text = '# My own title\n## Summary\nHole.\n## Decision\nnot critical\n## Recommended action\nRepair.';
  const kept = keepAgentSections(text);
  assert.match(kept, /## Summary/);
  assert.match(kept, /## Recommended action/);
  assert.doesNotMatch(kept, /not critical|My own title/);
});
