// Offline: a fake decision model stands in for d1, so no credit is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Experimental_DecisionModelV4 } from '@ai-sdk/provider';
import { findingById } from '../src/engine.ts';
import { sameFinding, similarEpisodes } from '../src/memory.ts';
import { Store } from '../src/store.ts';

function fakeModel(probabilities: Record<string, number>, calls: { n: number } = { n: 0 }): Experimental_DecisionModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake/decider',
    supportedQuestionTypes: ['boolean'],
    async doDecide(options) {
      calls.n++;
      const answers = Object.fromEntries(Object.keys(options.questions).map((name) => [name, { type: 'boolean', probability: probabilities[name] ?? 0.1 }]));
      return { answers, usage: { inputTokens: 500, outputTokens: 0 }, warnings: [] } as never;
    },
  };
}

const failing: Experimental_DecisionModelV4 = { ...fakeModel({}), async doDecide() { throw new Error('model renamed'); } };

test('same finding: d1 links the rejected fraying (202) to the later chafe (203), and the answer is cached', async () => {
  const store = new Store(':memory:');
  const calls = { n: 0 };
  const link = await sameFinding(findingById(203), store, fakeModel({ same_finding: 0.83 }, calls));
  assert.equal(link?.episode.id, 'finding-202');
  assert.equal(link?.source, 'd1');
  assert.equal(link?.linked, true);
  await sameFinding(findingById(203), store, fakeModel({ same_finding: 0.83 }, calls));
  assert.equal(calls.n, 1);
});

test('same finding: a d1 failure falls back to the stated rule, never a made-up probability', async () => {
  const link = await sameFinding(findingById(203), new Store(':memory:'), failing);
  assert.equal(link?.source, 'fallback');
  assert.equal(link?.probability, null);
  assert.equal(link?.linked, true); // same cell, both wear signs, 6 days apart
});

test('similar episode: the delousing drop recalls the seeded June episode', async () => {
  const event = { kind: 'oxygen' as const, penId: 3, day: 70, text: 'Oxygen critical in Pen 3 during delousing.' };
  const viaD1 = await similarEpisodes(event, new Store(':memory:'), fakeModel({ similar_0: 0.91 }));
  assert.equal(viaD1[0].episode.id, 'seed-o2-june');
  assert.equal(viaD1[0].linked, true);
  const fallback = await similarEpisodes(event, new Store(':memory:'), null);
  assert.equal(fallback[0].source, 'fallback');
  assert.equal(fallback[0].linked, true);
});
