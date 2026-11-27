/**
 * Episodic memory: past events with their outcomes, from seeded history plus the simulated world.
 * Two typed questions link new events to memory: "same finding?" and "similar past episode?".
 * d1 answers them with a probability; without d1 a stated fallback rule answers instead.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Experimental_DecisionModel } from 'ai';
import { askYesNo } from './d1.ts';
import type { Store } from './store.ts';
import { ANGLE_SECTORS, cellCol, cellLabel, cellRow, dayLabel, world, type Finding } from './world.ts';

export type EpisodeKind = 'oxygen' | 'net' | 'storm' | 'operation';

export interface Episode {
  id: string;
  penId: number | null;
  day: number;
  kind: EpisodeKind;
  text: string;
  outcome: string | null;
  seeded: boolean;
}

export interface Link {
  episode: Episode;
  /** d1 probability, or null when the fallback rule decided. */
  probability: number | null;
  linked: boolean;
  source: 'd1' | 'fallback';
  note: string;
}

/** Link threshold for d1 answers (BoligRadar used 0.6 for memory edges). Demo value. */
export const LINK_AT = 0.6;

const SEED_PATH = new URL('../../data/seed_memory.json', import.meta.url);

function seeded(): Episode[] {
  const raw = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { episodes: Array<Omit<Episode, 'seeded'>> };
  return raw.episodes.map((e) => ({ ...e, seeded: true }));
}

/** Final status of a finding as of `day` (live reviews override the simulated history). */
export function findingStatus(f: Finding, day: number, reviews: Map<number, string>): string {
  const live = reviews.get(f.id);
  if (live) return live;
  const steps = f.steps.filter((s) => s.day <= day);
  return steps.length > 0 ? steps[steps.length - 1].status : 'unreviewed';
}

function findingEpisode(f: Finding, reviews: Map<number, string>): Episode {
  const last = f.steps[f.steps.length - 1];
  return {
    id: `finding-${f.id}`,
    penId: f.penId,
    day: f.detectedDay,
    kind: 'net',
    text: `${f.kind} at ${cellLabel(f.cell)} in Pen ${f.penId}, confidence ${f.confidence.toFixed(2)}.`,
    outcome: reviews.has(f.id) ? `Operator: ${reviews.get(f.id)}.` : `${last.status}: ${last.note}`,
    seeded: false,
  };
}

/** Everything the memory knows up to and including `day`. */
export function episodes(day: number, reviews: Map<number, string>): Episode[] {
  const fromOps: Episode[] = world.operations
    .filter((op) => op.kind !== 'cleaning' && op.day <= day)
    .map((op) => ({
      id: `op-${op.kind}-${op.day}-${op.penId ?? 'site'}`,
      penId: op.penId,
      day: op.day,
      kind: op.kind === 'storm' ? 'storm' : 'operation',
      text: `${op.label} (${dayLabel(op.day)}).`,
      outcome: null,
      seeded: false,
    }));
  const fromFindings = world.findings.filter((f) => f.detectedDay <= day).map((f) => findingEpisode(f, reviews));
  return [...seeded(), ...fromOps, ...fromFindings].sort((a, b) => a.day - b.day);
}

export function searchMemory(text: string, day: number, reviews: Map<number, string>): Episode[] {
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return episodes(day, reviews)
    .map((e) => ({ e, hits: words.filter((w) => `${e.text} ${e.outcome ?? ''}`.toLowerCase().includes(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.e.day - a.e.day)
    .slice(0, 8)
    .map((x) => x.e);
}

/**
 * Is `event` like a past episode of the same kind? Asks d1 about the 3 most relevant earlier
 * episodes (same pen first). Fallback without d1: same kind and same pen counts as similar.
 */
export async function similarEpisodes(
  event: { kind: EpisodeKind; penId: number; day: number; text: string },
  store: Store,
  model: Experimental_DecisionModel | null,
): Promise<Link[]> {
  const candidates = episodes(event.day - 1, store.reviews())
    .filter((e) => e.kind === event.kind && e.outcome !== null)
    .sort((a, b) => Number(b.penId === event.penId) - Number(a.penId === event.penId) || b.day - a.day)
    .slice(0, 3);
  if (candidates.length === 0) return [];

  const state = similarState(event, candidates);
  // Keyed on the exact text sent, so changing what d1 is told never reuses a stale answer.
  const key = `similar:${createHash('sha256').update(state).digest('hex').slice(0, 16)}`;
  const answers = model ? await cachedAsk(store, key, model, state, candidateQuestions(candidates)) : null;

  return candidates.map((episode, i) => {
    const answer = answers?.[`similar_${i}`];
    if (answer) {
      return { episode, probability: answer.probability, linked: answer.probability >= LINK_AT, source: 'd1', note: `d1 p=${answer.probability.toFixed(2)}` };
    }
    const linked = episode.penId === event.penId;
    return { episode, probability: null, linked, source: 'fallback', note: 'd1 unavailable: fallback rule (same kind and same pen)' };
  });
}

function similarState(event: { text: string; day: number }, candidates: Episode[]): string {
  const lines = candidates.map((c, i) => `Past episode ${i + 1} (${dayLabel(c.day)}): ${c.text} Outcome: ${c.outcome}`);
  return [`New event (${dayLabel(event.day)}): ${event.text}`, ...lines].join('\n');
}

function candidateQuestions(candidates: Episode[]): Record<string, string> {
  return Object.fromEntries(
    candidates.map((_, i) => [`similar_${i}`, `Does the new event have the same likely cause and pattern as past episode ${i + 1}, so that its outcome is a useful guide?`]),
  );
}

const neighbours = (a: number, b: number): boolean => {
  const dr = Math.abs(cellRow(a) - cellRow(b));
  const dc = Math.abs(cellCol(a) - cellCol(b));
  return dr <= 1 && Math.min(dc, ANGLE_SECTORS - dc) <= 1;
};

/**
 * Is `finding` the same defect as an earlier finding in the same or a neighbouring cell within
 * 30 days? Fallback without d1: same cell, same kind or both wear signs (not holes), within 21 days.
 */
export async function sameFinding(finding: Finding, store: Store, model: Experimental_DecisionModel | null): Promise<Link | null> {
  const prior = world.findings
    .filter((f) => f.id !== finding.id && f.penId === finding.penId && f.detectedDay < finding.detectedDay && finding.detectedDay - f.detectedDay <= 30 && neighbours(f.cell, finding.cell))
    .sort((a, b) => b.detectedDay - a.detectedDay)[0];
  if (!prior) return null;
  const episode = findingEpisode(prior, store.reviews());

  if (model) {
    const state = `New detection (${dayLabel(finding.detectedDay)}): ${finding.kind} at ${cellLabel(finding.cell)}, confidence ${finding.confidence.toFixed(2)}.\nEarlier finding (${dayLabel(prior.detectedDay)}): ${episode.text} Status: ${episode.outcome}`;
    const answers = await cachedAsk(store, `same:${finding.id}:${prior.id}`, model, state, { same_finding: 'Is the new detection most likely the same physical defect as the earlier finding?' });
    const p = answers?.same_finding?.probability;
    if (p !== undefined) return { episode, probability: p, linked: p >= LINK_AT, source: 'd1', note: `d1 p=${p.toFixed(2)}` };
  }
  const wear = (kind: string): boolean => kind !== 'hole';
  const linked = (prior.kind === finding.kind || (wear(prior.kind) && wear(finding.kind))) && prior.cell === finding.cell && finding.detectedDay - prior.detectedDay <= 21;
  return { episode, probability: null, linked, source: 'fallback', note: 'd1 unavailable: fallback rule (same cell, same kind or both wear signs, ≤ 21 days)' };
}

/** One d1 call per cache key. A failed call returns null so callers fall back, never guess. */
async function cachedAsk(store: Store, key: string, model: Experimental_DecisionModel, state: string, questions: Record<string, string>) {
  const hit = store.cached<Awaited<ReturnType<typeof askYesNo>>>(key);
  if (hit) return hit;
  try {
    const answers = await askYesNo(model, state, questions);
    store.cache(key, answers);
    return answers;
  } catch (error) {
    console.error(`d1 call failed (${key}): ${(error as Error).message}`);
    return null;
  }
}
