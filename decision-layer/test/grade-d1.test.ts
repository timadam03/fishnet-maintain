// Offline: a fake `ask` stands in for d1, so no credit is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimCapture, type VisionReport } from '../src/contracts.ts';
import { QUESTIONS, cellState, gradeFromAnswers, gradeWithD1, type Ask } from '../src/grade-d1.ts';
import { buildPlan, creditByCell, importObservations, observations, observationsByCell } from '../src/inspection.ts';
import { Store } from '../src/store.ts';
import { TODAY } from '../src/world.ts';

const R = 8;
const PEN = 7;

function capture(i: number, cell: number, standoff: number, target_id?: string): SimCapture {
  const theta = ((cell % 24) + 0.5) * 15 * (Math.PI / 180);
  const r = R - standoff;
  return SimCapture.parse({
    image: `auv_0/img_${String(i).padStart(4, '0')}.png`, run_id: 'run', auv: 0, sim_time: i, theta_deg: (theta * 180) / Math.PI,
    depth: -2, position: [r * Math.cos(theta), r * Math.sin(theta), -2], cell, ...(target_id ? { target_id } : {}),
  });
}
const report = (c: SimCapture, detections: VisionReport['detections'], cells_in_view?: number[]): VisionReport => ({
  image: c.image, model: 'net-inspect-cv-v1', quality: { visibility: 0.9, sharpness: 0.9 }, fouling_pct: 0, detections, ...(cells_in_view ? { cells_in_view } : {}),
});

/** A far photo centred on cell 50 that shows cells 49–51 and 73–75, with a hole at the edge on cell 74. */
function farSweep(store: Store) {
  const c = capture(1, 50, 6.5);
  importObservations(store, {
    penId: PEN, captures: [c], cageRadiusM: R,
    reports: [report(c, [{ class: 'hole', confidence: 0.8, bbox: [1100, 600, 60, 60], cell: 74 }], [49, 50, 51, 73, 74, 75])],
  });
}

test('a detection at the edge of a far photo is credited to its own cell, and the photo clears the rest of its view', () => {
  const store = new Store(':memory:');
  farSweep(store);
  const byCell = creditByCell(observations(store, { penId: PEN }));
  assert.deepEqual([...byCell.keys()].sort((a, b) => a - b), [49, 50, 51, 73, 74, 75]);
  assert.equal(byCell.get(50)![0].detections.length, 0);
  assert.equal(byCell.get(74)![0].detections[0].class, 'hole');

  const plan = buildPlan(store, { penId: PEN, day: TODAY, robots: 3 });
  assert.ok(plan.targets.some((t) => t.cell === 74), 'the close-up goes where the hole is');
  assert.ok(!plan.targets.some((t) => t.cell === 50 && t.reasons.some((r) => r.rule === 'P1')), 'not to the photo centre');
});

test('d1 grades: answers become a status and a priority; the two-view rule for confirming stays', () => {
  const store = new Store(':memory:');
  farSweep(store);
  const obs = observationsByCell(store, PEN).get(74)!;
  const p = { opening: 0.9, wear: 0.1, fouling: 0.05, hidden: 0.2, settled: 0.3, urgent: 0.8 };
  const g = gradeFromAnswers(74, obs, p);
  assert.equal(g.status, 'possible_opening'); // one view only, however sure d1 is
  assert.equal(g.by, 'd1');
  assert.equal(g.priority, Number((0.2 + 0.55 * 0.9 + 0.25 * 0.8).toFixed(2)));
  assert.equal(gradeFromAnswers(74, obs, { ...p, opening: 0.1, settled: 0.9, urgent: 0.1 }).status, 'clear');
});

test('the d1 plan: d1 reorders and reclassifies, the plan rules still set distance, robots and margin', async () => {
  const store = new Store(':memory:');
  const caps = [capture(1, 50, 6.5), capture(2, 100, 6.5), capture(3, 150, 6.5)];
  importObservations(store, {
    penId: PEN, captures: caps, cageRadiusM: R,
    reports: [
      report(caps[0], [{ class: 'mesh_opening', confidence: 0.35, bbox: [600, 300, 40, 40] }]), // weak: rules say "uncertain"
      report(caps[1], [{ class: 'hole', confidence: 0.75, bbox: [600, 300, 40, 40] }]), // rules: possible opening
      report(caps[2], []), // clean: not asked
    ],
  });
  const asked: string[] = [];
  // d1 thinks the weak cell 50 is the real hole and 100 a shadow.
  const ask: Ask = async (state) => {
    asked.push(state);
    const is50 = state.includes('Cell 50:');
    return Object.fromEntries(Object.keys(QUESTIONS).map((k) => [k, { probability: k === 'opening' ? (is50 ? 0.85 : 0.2) : k === 'settled' ? (is50 ? 0.2 : 0.8) : k === 'urgent' ? (is50 ? 0.9 : 0.1) : 0.1 }]));
  };
  const g = await gradeWithD1(store, { penId: PEN, day: TODAY, ask, model: 'fake/d1' });
  assert.equal(g.asked, 2);
  assert.ok(asked.every((s) => s.length <= 6000 && s.includes('Photos of this cell')));

  const rules = buildPlan(store, { penId: PEN, day: TODAY, robots: 3 });
  const d1 = buildPlan(store, { penId: PEN, day: TODAY, robots: 3, grades: g.grades });
  assert.equal(rules.targets[0].cell, 100);
  assert.equal(d1.targets[0].cell, 50);
  assert.equal(d1.rules_version, 'plan-v2+d1');
  const t50 = d1.targets[0];
  assert.equal(t50.reasons[1].rule, 'D1');
  assert.equal(t50.robots.length, 2); // P1 for a possible opening: two robots, two sides
  assert.ok(t50.scan.standoff_m >= t50.safety.margin_m + 0.55);
  assert.ok(!d1.targets.some((t) => t.cell === 100), 'd1 cleared the shadow');
});

test('d1 failing for a cell falls back to the rules for that cell and says so', async () => {
  const store = new Store(':memory:');
  const c = capture(1, 100, 6.5);
  importObservations(store, { penId: PEN, captures: [c], cageRadiusM: R, reports: [report(c, [{ class: 'hole', confidence: 0.75, bbox: [600, 300, 40, 40] }])] });
  const g = await gradeWithD1(store, { penId: PEN, day: TODAY, ask: async () => { throw new Error('rate limited'); } });
  assert.equal(g.fellBack.length, 1);
  assert.equal(g.grades.get(100)!.status, 'possible_opening');
  const plan = buildPlan(store, { penId: PEN, day: TODAY, robots: 3, grades: g.grades });
  assert.ok(plan.targets[0].reasons.some((r) => r.rule === 'D1-fallback' && /rate limited/.test(r.text)));
  assert.equal(plan.rules_version, 'plan-v2');
});

test('the d1 state names the cell, its photos, its neighbours and the area risk', () => {
  const store = new Store(':memory:');
  farSweep(store);
  const byCell = observationsByCell(store, PEN);
  const s = cellState(74, byCell.get(74)!, byCell, { risk: { level: 'high', score: 0.6, factors: [{ group: 'exposure', label: 'Contact with weights/chains 40 h in 30 d', weight: 0.5 }] } as never, history: [] });
  assert.match(s, /Cell 74: sector 3 of 24/);
  assert.match(s, /hole confidence 0\.80/);
  assert.match(s, /Cell 50 \(above\): 1 photo, nothing found/);
  assert.match(s, /Contact with weights/);
});
