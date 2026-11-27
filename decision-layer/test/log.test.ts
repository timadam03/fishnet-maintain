import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logEntries, missions, recordDay, trace, updateMission } from '../src/log.ts';
import { Store } from '../src/store.ts';
import { TODAY } from '../src/world.ts';

test('recording a day is idempotent under the same rules', async () => {
  const store = new Store(':memory:');
  const first = await recordDay(store, TODAY, null);
  assert.ok(first > 0);
  assert.equal(await recordDay(store, TODAY, null), 0);
  assert.equal(logEntries(store, { day: TODAY }).length, first);
});

test('the same stale areas reuse one open coverage mission across days', async () => {
  const store = new Store(':memory:');
  await recordDay(store, 84, null);
  await recordDay(store, TODAY, null);
  const coverage = missions(store, {}).filter((m) => m.kind === 'coverage' && m.penId === 8);
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0].cells.length, 72);
});

test('trace shows what the layer saw, decided, did, and what the robot reported', async () => {
  const store = new Store(':memory:');
  await recordDay(store, TODAY, null);
  const [step] = trace(store, 'cell:7:188');
  assert.equal(step.saw.level, 'high');
  assert.deepEqual(step.decided.rules, ['N4']);
  assert.equal(step.did.mission?.kind, 'close_inspection');
  assert.equal(step.outcome.mission, 'requested');

  updateMission(store, step.did.mission!.id, { status: 'done', robot: 'ROV-2', result: 'confirmed: fraying at the sinker tube' });
  assert.equal(trace(store, 'cell:7:188')[0].outcome.mission, 'done: confirmed: fraying at the sinker tube');
  assert.throws(() => updateMission(store, 9999, { status: 'done' }), /unknown mission/);
});

test('a rule change adds a new log entry instead of rewriting history', async () => {
  const store = new Store(':memory:');
  await recordDay(store, 84, null);
  const p = store.addProposal({ rule: 'F1', change: { frayingReimageBelow: 0.6 }, rationale: 'test', evidence: [], author: 'test' });
  store.decideProposal(p.id, 'accepted');
  await recordDay(store, 84, null);

  const steps = trace(store, 'finding:206');
  assert.deepEqual(steps.map((s) => [s.decided.rulesVersion, s.decided.outcome]), [['v1', 'REVIEW'], ['v2 (F1 < 0.6)', 'SAMPLE_MORE']]);
  assert.equal(steps[1].did.mission?.kind, 'reimage');
  assert.equal(steps[0].did.mission, null);
});

test('an oxygen alert is logged with its memory links (fallback without d1)', async () => {
  const store = new Store(':memory:');
  await recordDay(store, 70, null);
  const [entry] = logEntries(store, { day: 70, entity: 'oxygen:3' });
  assert.equal(entry.outcome, 'ALERT');
  assert.equal(entry.links[0].to, 'seed-o2-june');
  assert.equal(entry.links[0].source, 'fallback');
  assert.equal(entry.alertKey, 'o2:3:70');
});
