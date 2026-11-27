import assert from 'node:assert/strict';
import { test } from 'node:test';
import { standInReport } from '../scripts/stand-in-vision.ts';
import { InspectionPlan, SimCapture, VisionReport, type PlanTarget } from '../src/contracts.ts';
import { assessCell, buildPlan, importObservations, observations } from '../src/inspection.ts';
import { missions } from '../src/log.ts';
import { Store } from '../src/store.ts';
import { TODAY } from '../src/world.ts';

const R = 8; // Isaac pen radius
const SWEEP = 4; // Isaac's default sweep standoff (--standoff)
const PEN = 7;

/** An Isaac-style capture of `cell`, taken `standoff` metres from the net. */
function capture(run: string, i: number, cell: number, standoff: number, truth: Partial<SimCapture> = {}, auv = 0, target_id?: string): SimCapture {
  const theta = ((cell % 24) + 0.5) * 15 * (Math.PI / 180);
  const r = R - standoff;
  return SimCapture.parse({
    image: `${run}/auv_${auv}/img_${String(i).padStart(4, '0')}.png`, run_id: run, auv, sim_time: i * 10,
    theta_deg: (theta * 180) / Math.PI, depth: -1.5, position: [r * Math.cos(theta), r * Math.sin(theta), -1.5], cell,
    ...(target_id ? { target_id } : {}), fouling_frac: 0, thinning_frac: 0, holes_in_view: [], ...truth,
  });
}

/** A first, even sweep at Isaac's default 4 m: a big hole, a small hole, thinning, fouling and a clean cell. */
function firstPass(): SimCapture[] {
  return [
    capture('run1', 1, 30, SWEEP, { holes_in_view: [{ cell: 30, radius: 0.45 }] }),
    capture('run1', 2, 100, SWEEP, { holes_in_view: [{ cell: 100, radius: 0.1 }] }),
    capture('run1', 3, 150, SWEEP, { thinning_frac: 0.25 }),
    capture('run1', 4, 60, SWEEP, { fouling_frac: 0.6 }),
    capture('run1', 5, 5, SWEEP),
  ];
}

function importAll(store: Store, caps: SimCapture[]) {
  return importObservations(store, { penId: PEN, captures: caps, reports: caps.map((c) => standInReport(c, R)), cageRadiusM: R });
}

const target = (plan: InspectionPlan, cell: number): PlanTarget | undefined => plan.targets.find((t) => t.cell === cell);

test('contracts reject bad input instead of guessing', () => {
  assert.throws(() => VisionReport.parse({ image: 'a.png', model: 'm', detections: [{ class: 'hole', confidence: 1.4, bbox: [0, 0, 1, 1] }] }));
  assert.throws(() => SimCapture.parse({ image: 'a.png', run_id: 'r', auv: 0, sim_time: 1, theta_deg: 0, depth: -1, position: [0, 0, 0], cell: 999 }));
  const store = new Store(':memory:');
  const result = importObservations(store, { penId: PEN, captures: [], reports: [{ image: 'nowhere.png', model: 'm', detections: [] }] });
  assert.deepEqual(result.unmatchedReports, ['nowhere.png']);
});

test('a run made on a different cell grid is refused before anything is stored', () => {
  const store = new Store(':memory:');
  const caps = firstPass();
  const reports = caps.map((c) => standInReport(c, R));
  assert.throws(() => importObservations(store, { penId: PEN, captures: caps, reports, grid: { ui_sectors: 12, ui_wall_rows: 3 } }), /grid mismatch: run is 12x3/);
  assert.equal(observations(store, { penId: PEN }).length, 0);
  assert.equal(importObservations(store, { penId: PEN, captures: caps, reports, grid: { ui_sectors: 24, ui_wall_rows: 8 } }).imported, 5);
});

test('first pass: each cell gets the right status', () => {
  const store = new Store(':memory:');
  importAll(store, firstPass());
  const status = (cell: number) => assessCell(cell, observations(store, { penId: PEN, cell })).status;
  assert.equal(status(30), 'possible_opening');
  assert.equal(status(100), 'uncertain');
  assert.equal(status(150), 'uncertain');
  assert.equal(status(60), 'fouled');
  assert.equal(status(5), 'clear');
});

test('plan: possible hole first, two robots, two sides, extra margin; reachable standoffs everywhere', () => {
  const store = new Store(':memory:');
  importAll(store, firstPass());
  const plan = buildPlan(store, { penId: PEN, day: TODAY, robots: 3 });
  const hole = target(plan, 30)!;
  assert.equal(plan.targets[0].cell, 30);
  assert.equal(hole.priority_label, 'high');
  assert.equal(hole.robots.length, 2);
  assert.equal(hole.scan.viewpoints.length, 2);
  assert.ok(hole.safety.margin_m >= 1.0);
  assert.equal(target(plan, 100)!.scan.standoff_m, 1.15); // P2 asks for 1.0 m; S1 keeps it reachable under a 0.6 m margin
  assert.deepEqual(target(plan, 60)!.reasons.map((r) => r.rule), ['area', 'P4']);
  assert.equal(target(plan, 5), undefined);
  for (const t of plan.targets) assert.ok(t.scan.standoff_m >= t.safety.margin_m + 0.55, `target ${t.target_id} unreachable`);
  assert.equal(new Set(plan.targets.map((t) => t.target_id)).size, plan.targets.length);
  assert.ok(!plan.coverage.includes(30));
});

test('the loop: photos taken for the plan close its missions, and the next plan escalates what is still unsure', () => {
  const store = new Store(':memory:');
  importAll(store, firstPass());
  const plan = buildPlan(store, { penId: PEN, day: TODAY, robots: 3 });

  // Isaac executes the plan: every robot, viewpoint and shot, at the requested standoff.
  let i = 100;
  const truthOf: Record<number, Partial<SimCapture>> = { 30: { holes_in_view: [{ cell: 30, radius: 0.45 }] }, 100: { holes_in_view: [{ cell: 100, radius: 0.1 }] }, 150: { thinning_frac: 0.25 }, 60: { fouling_frac: 0.6 } };
  const second = plan.targets.flatMap((t) =>
    t.robots.flatMap((auv) => t.scan.viewpoints.flatMap(() => Array.from({ length: t.scan.shots }, () => capture('run2', i++, t.cell, t.scan.standoff_m, truthOf[t.cell] ?? {}, auv, t.target_id)))),
  );
  const result = importAll(store, second);

  const resultFor = (cell: number) => result.missionsClosed.find((m) => m.missionId === target(plan, cell)!.mission_id)?.result ?? '';
  assert.match(resultFor(30), /^confirmed: opening seen from 2 viewpoints/);
  assert.match(resultFor(100), /possible opening/); // closer look raised confidence above 0.7, but only one robot saw it
  assert.equal(missions(store, { status: 'requested' }).filter((m) => m.cells.includes(30)).length, 0);

  const next = buildPlan(store, { penId: PEN, day: TODAY, robots: 3 });
  assert.equal(target(next, 30), undefined); // confirmed: repair, not more robot time
  assert.equal(target(next, 100)!.robots.length, 2); // escalated to two perspectives (P1)
});

test('a clean close-up clears what a far photo was unsure about, so the cell leaves the plan', () => {
  const store = new Store(':memory:');
  importAll(store, [capture('run1', 1, 100, SWEEP, { holes_in_view: [{ cell: 100, radius: 0.1 }] })]);
  const plan = buildPlan(store, { penId: PEN, day: TODAY, robots: 3 });
  const t = target(plan, 100)!;
  assert.deepEqual(t.reasons.map((r) => r.rule), ['area', 'P2']);
  // The close-up finds nothing (the "hole" was a shadow in the far photo).
  const result = importAll(store, [capture('run2', 2, 100, t.scan.standoff_m, {}, 0, t.target_id), capture('run2', 3, 100, t.scan.standoff_m, {}, 0, t.target_id)]);
  assert.match(result.missionsClosed[0].result, /^clear: 2 good images/);
  assert.equal(assessCell(100, observations(store, { penId: PEN, cell: 100 })).status, 'clear');
  assert.equal(target(buildPlan(store, { penId: PEN, day: TODAY, robots: 3 }), 100), undefined);
});

test('strong current widens every safety margin (G1)', () => {
  const store = new Store(':memory:');
  importAll(store, firstPass());
  const calm = buildPlan(store, { penId: PEN, day: TODAY, robots: 3 });
  const storm = buildPlan(store, { penId: PEN, day: 59, robots: 3 }); // the simulated storm
  assert.equal(target(storm, 30)!.safety.margin_m, Number((target(calm, 30)!.safety.margin_m + 0.4).toFixed(2)));
  assert.ok(target(storm, 30)!.reasons.some((r) => r.rule === 'G1'));
});
