import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findingStats, runCurator } from '../src/curator.ts';
import { findingById, penDecisions } from '../src/engine.ts';
import { decideFinding } from '../src/rules/net.ts';
import { Store } from '../src/store.ts';
import { TODAY } from '../src/world.ts';

test('stats: all reviewed low-confidence fraying findings were rejected, and one cell later had confirmed chafe', () => {
  const low = findingStats(TODAY, new Map()).find((s) => s.kind === 'fraying' && s.band === '< 0.6');
  assert.ok(low);
  assert.equal(low.reviewed, 4);
  assert.equal(low.rejected, 4);
  assert.ok(low.findings.find((f) => f.id === 202)?.laterConfirmedNearby?.includes('finding 203'));
});

test('curator (rule-based, no model): proposes F1 once; accepting it changes the decision for finding 206', async () => {
  const saved = { gemini: process.env.GEMINI_MODEL };
  delete process.env.GEMINI_MODEL;
  try {
    const store = new Store(':memory:');
    const first = await runCurator(store, TODAY);
    assert.equal(first.proposals.length, 1);
    assert.deepEqual(first.proposals[0].change, { frayingReimageBelow: 0.6 });
    assert.equal((await runCurator(store, TODAY)).proposals.length, 0);

    assert.equal(decideFinding(findingById(206), store.config()).kind, 'REVIEW');
    store.decideProposal(first.proposals[0].id, 'accepted');
    assert.equal(decideFinding(findingById(206), store.config()).kind, 'SAMPLE_MORE');
    assert.equal(penDecisions(5, 84, store.config(), new Map()).rulesVersion, 'v2 (F1 < 0.6)');
  } finally {
    if (saved.gemini !== undefined) process.env.GEMINI_MODEL = saved.gemini;
  }
});

test('a live operator review overrides the simulated history', () => {
  const store = new Store(':memory:');
  assert.equal(penDecisions(7, TODAY, store.config(), store.reviews()).findings.find((f) => f.id === 208)?.status, 'unreviewed');
  store.addReview(208, 'confirmed', null);
  assert.equal(penDecisions(7, TODAY, store.config(), store.reviews()).findings.find((f) => f.id === 208)?.status, 'confirmed');
});
