import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideCell, decideFinding, type CellRiskInput } from '../src/rules/net.ts';
import { OXYGEN, decideOxygen, type OxygenSource } from '../src/rules/oxygen.ts';
import { DEFAULT_CONFIG } from '../src/rules/types.ts';

const risk = (over: Partial<CellRiskInput>): CellRiskInput => ({
  level: 'low', score: 0.1, stale: false, coverageAge: 1, predicted: false, knownHole: false, recommendation: 'r', ...over,
});

test('net rules: hole beats stale, stale beats score, forecast before critical', () => {
  assert.deepEqual(decideCell(risk({ knownHole: true, stale: true })).rules, ['N0']);
  assert.equal(decideCell(risk({ stale: true, level: 'critical' })).kind, 'SAMPLE_MORE');
  assert.deepEqual(decideCell(risk({ predicted: true, level: 'critical' })), { kind: 'ALERT', level: 'low', rules: ['N2'], reason: 'Forecast risk critical (0.10).', recommend: 'r' });
  assert.equal(decideCell(risk({ level: 'critical' })).level, 'medium');
  assert.equal(decideCell(risk({ level: 'high' })).kind, 'MISSION');
  assert.equal(decideCell(risk({ level: 'elevated' })).kind, 'OK');
  assert.equal(decideCell(risk({ predicted: true, level: 'elevated' })).kind, 'OK');
});

test('finding rules: F1 only when learned, and only below the threshold', () => {
  assert.equal(decideFinding({ kind: 'hole', confidence: 0.7 }, DEFAULT_CONFIG).level, 'high');
  assert.equal(decideFinding({ kind: 'hole', confidence: 0.69 }, DEFAULT_CONFIG).kind, 'REVIEW');
  assert.equal(decideFinding({ kind: 'fraying', confidence: 0.5 }, DEFAULT_CONFIG).kind, 'REVIEW');
  const v2 = { frayingReimageBelow: 0.6 };
  assert.deepEqual(decideFinding({ kind: 'fraying', confidence: 0.59 }, v2).rules, ['F1']);
  assert.equal(decideFinding({ kind: 'fraying', confidence: 0.6 }, v2).kind, 'REVIEW');
  assert.equal(decideFinding({ kind: 'chafe', confidence: 0.4 }, v2).kind, 'REVIEW');
});

const src = (id: string, oxygen: number, over: Partial<OxygenSource> = {}): OxygenSource => ({ id, kind: 'drone', depth: 10, oxygen, readingDay: 5, ...over });

test('oxygen rules: thresholds, counts and the stale-sensor flag', () => {
  assert.equal(decideOxygen([], 5).kind, 'ESCALATE');
  assert.deepEqual(decideOxygen([src('s', 30, { kind: 'sensor', readingDay: 3 })], 5).rules, ['O1', 'O0']);
  assert.equal(decideOxygen([src('a', OXYGEN.critical - 0.1), src('b', 90)], 5).level, 'high');
  const confirmed = decideOxygen([src('a', OXYGEN.warn - 1), src('b', OXYGEN.warn - 2), src('c', 90)], 5);
  assert.equal(confirmed.level, 'medium');
  assert.ok(confirmed.recommend?.includes('Pause feeding'));
  assert.equal(decideOxygen([src('a', OXYGEN.warn - 1), src('b', 90)], 5).kind, 'SAMPLE_MORE');
  assert.equal(decideOxygen([src('a', OXYGEN.warn), src('b', 90)], 5).kind, 'OK');
});

test('a frozen sensor reading low is excluded, not alerted on', () => {
  const d = decideOxygen([src('sensor 15 m', 40, { kind: 'sensor', readingDay: 2 }), src('a', 80)], 5);
  assert.equal(d.kind, 'OK');
  assert.deepEqual(d.flaggedSensors, ['sensor 15 m']);
});
