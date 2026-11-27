/**
 * The curator turns closed outcomes into proposed rule changes. It can only propose changes from a
 * fixed list; a person accepts or rejects them. The statistics are computed in code; the model only
 * chooses among allowed proposals and writes the rationale. Without a model, a deterministic rule
 * makes the same proposal.
 */
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import { agentModel, shortError } from './llm.ts';
import { findingStatus } from './memory.ts';
import type { Proposal, Store } from './store.ts';
import { cellLabel, dayLabel, world } from './world.ts';

export interface BandStats {
  kind: string;
  band: string;
  reviewed: number;
  rejected: number;
  findings: Array<{ id: number; penId: number; cell: string; confidence: number; day: string; status: string; laterConfirmedNearby: string | null }>;
}

const band = (c: number): string => (c < 0.6 ? '< 0.6' : c < 0.7 ? '0.6–0.7' : '≥ 0.7');

/** Review outcomes per finding kind and confidence band, as of `day`. */
export function findingStats(day: number, reviews: Map<number, string>): BandStats[] {
  const groups = new Map<string, BandStats>();
  for (const f of world.findings.filter((x) => x.detectedDay <= day)) {
    const status = findingStatus(f, day, reviews);
    if (status === 'unreviewed') continue;
    const key = `${f.kind} ${band(f.confidence)}`;
    const g = groups.get(key) ?? { kind: f.kind, band: band(f.confidence), reviewed: 0, rejected: 0, findings: [] };
    g.reviewed++;
    if (status === 'rejected') g.rejected++;
    const later = world.findings.find((x) => x.penId === f.penId && x.cell === f.cell && x.detectedDay > f.detectedDay && x.detectedDay <= day && findingStatus(x, day, reviews) !== 'rejected' && findingStatus(x, day, reviews) !== 'unreviewed');
    g.findings.push({
      id: f.id,
      penId: f.penId,
      cell: cellLabel(f.cell),
      confidence: Number(f.confidence.toFixed(2)),
      day: dayLabel(f.detectedDay),
      status,
      laterConfirmedNearby: later ? `${later.kind} confirmed in the same cell on ${dayLabel(later.detectedDay)} (finding ${later.id})` : null,
    });
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The only changes the curator may propose. */
const ALLOWED = {
  reimage_low_confidence_fraying: { rule: 'F1', change: { frayingReimageBelow: 0.6 } },
} as const;
type AllowedId = keyof typeof ALLOWED;

function alreadyProposed(store: Store, id: AllowedId): boolean {
  const target = JSON.stringify(ALLOWED[id].change);
  return store.proposals().some((p) => p.status !== 'rejected' && JSON.stringify(p.change) === target);
}

/** Deterministic version: ≥ 3 reviewed low-confidence fraying findings, ≥ 75% rejected. */
function ruleBasedProposal(stats: BandStats[]): { id: AllowedId; rationale: string; evidence: string[] } | null {
  const g = stats.find((s) => s.kind === 'fraying' && s.band === '< 0.6');
  if (!g || g.reviewed < 3 || g.rejected / g.reviewed < 0.75) return null;
  const missed = g.findings.filter((f) => f.laterConfirmedNearby);
  const rationale =
    `${g.rejected} of ${g.reviewed} fraying findings below 0.6 confidence were rejected on review, so they cost operator time. ` +
    (missed.length > 0 ? `But ${missed.map((f) => `finding ${f.id} (Pen ${f.penId}, ${f.cell}) was followed by ${f.laterConfirmedNearby}`).join('; ')}. ` : '') +
    'Re-imaging these close up before asking the operator removes the noise without throwing the signal away.';
  return { id: 'reimage_low_confidence_fraying', rationale, evidence: g.findings.map((f) => `finding ${f.id}`) };
}

type CuratorResult = { proposals: Proposal[]; author: string; note: string };

function ruleBasedRun(store: Store, stats: BandStats[], why: string): CuratorResult {
  const p = ruleBasedProposal(stats);
  if (!p || alreadyProposed(store, p.id)) return { proposals: [], author: 'rules', note: `No new proposal (rule-based curator: ${why}).` };
  const saved = store.addProposal({ ...ALLOWED[p.id], change: { ...ALLOWED[p.id].change }, rationale: p.rationale, evidence: p.evidence, author: 'rules' });
  return { proposals: [saved], author: 'rules', note: `Rule-based curator (${why}).` };
}

export async function runCurator(store: Store, day: number): Promise<CuratorResult> {
  const stats = findingStats(day, store.reviews());
  const llm = agentModel();
  if (!llm) return ruleBasedRun(store, stats, 'no model configured');

  const created: Proposal[] = [];
  let result;
  try {
    result = await generateText({
    model: llm.model,
    maxRetries: 1,
    stopWhen: isStepCount(6),
    system:
      'You are the curator of a fish-farm net monitoring system. You review how operators closed past findings and propose at most one rule change, only from the allowed list, only when the evidence supports it. Cite finding ids. Be brief and factual; never invent numbers.',
    prompt: `Today is ${dayLabel(day)}. Review the finding outcomes and propose a change if warranted.`,
    tools: {
      finding_stats: tool({
        description: 'Review outcomes per finding kind and confidence band, with each finding and whether the same cell was later confirmed.',
        // Gemini rejects function declarations with an empty object schema, so the tool takes an optional filter.
        inputSchema: z.object({ kind: z.enum(['fraying', 'chafe', 'distortion', 'hole']).optional().describe('Only this finding kind') }),
        execute: async ({ kind }) => (kind ? stats.filter((s) => s.kind === kind) : stats),
      }),
      propose_change: tool({
        description: `Propose one allowed change for a person to accept. Allowed: ${Object.keys(ALLOWED).join(', ')} (re-image fraying findings below 0.6 confidence instead of sending them to operator review).`,
        inputSchema: z.object({
          change_id: z.enum(Object.keys(ALLOWED) as [AllowedId]),
          rationale: z.string().min(20).max(800),
          evidence_finding_ids: z.array(z.number()).min(1),
        }),
        execute: async ({ change_id, rationale, evidence_finding_ids }) => {
          if (alreadyProposed(store, change_id)) return { saved: false, reason: 'already proposed' };
          const known = new Set(world.findings.map((f) => f.id));
          const evidence = evidence_finding_ids.filter((id) => known.has(id)).map((id) => `finding ${id}`);
          const saved = store.addProposal({ ...ALLOWED[change_id], change: { ...ALLOWED[change_id].change }, rationale, evidence, author: llm.id });
          created.push(saved);
          return { saved: true, id: saved.id };
        },
      }),
    },
    });
  } catch (error) {
    if (created.length > 0) return { proposals: created, author: llm.id, note: `Model stopped early: ${shortError(error)}` };
    return ruleBasedRun(store, stats, `${llm.id} failed: ${shortError(error)}`);
  }
  return { proposals: created, author: llm.id, note: result.text };
}
