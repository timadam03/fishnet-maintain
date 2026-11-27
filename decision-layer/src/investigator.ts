/**
 * The investigator answers operator questions ("why is this area high risk?", "what happened in
 * Pen 3 on 6 Nov?") from the decision layer's own data. Read-only tools; it never makes decisions.
 */
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import { oxygenSources, penDecisions } from './engine.ts';
import { agentModel, NO_MODEL_NOTE } from './llm.ts';
import { findingStatus, searchMemory, similarEpisodes } from './memory.ts';
import { defaultDecisionModel } from './d1.ts';
import { decideOxygen } from './rules/oxygen.ts';
import type { Store } from './store.ts';
import { CELLS, TODAY, cellLabel, dayLabel, explainRisk, penSim, world } from './world.ts';

const SYSTEM = `You help a fish-farm site manager understand what the monitoring system decided and why.
Answer in 2–4 short sentences: the answer, the top evidence with dates, and what to do next.
Use only facts returned by tools. If the tools don't have it, say so. Day indices are internal: always say dates.`;

export interface Answer {
  text: string;
  toolCalls: Array<{ tool: string; input: unknown }>;
  model: string | null;
}

export async function ask(store: Store, question: string, day = TODAY): Promise<Answer> {
  const llm = agentModel();
  if (!llm) return { text: NO_MODEL_NOTE, toolCalls: [], model: null };
  const reviews = store.reviews();
  const config = store.config();
  const penId = z.number().int().min(1).max(world.pens.length);
  const cell = z.number().int().min(0).max(CELLS - 1);
  const dayIndex = z.number().int().min(0).max(96).describe(`Day index; today is ${TODAY} (${dayLabel(TODAY)})`);

  const result = await generateText({
    model: llm.model,
    stopWhen: isStepCount(8),
    system: SYSTEM,
    prompt: `Today is ${dayLabel(day)} (day index ${day}). Day index d is ${dayLabel(0)} + d days. Question: ${question}`,
    tools: {
      pen_summary: tool({
        description: 'Decisions for one pen on one day: cells needing action, oxygen decision, open and new findings.',
        inputSchema: z.object({ pen_id: penId, day: dayIndex }),
        execute: async ({ pen_id, day: d }) => {
          const p = penDecisions(pen_id, d, config, reviews);
          return { ...p, cells: p.cells.slice(0, 10), oxygen: { ...p.oxygen, lowSources: p.oxygen.lowSources.length } };
        },
      }),
      cell_detail: tool({
        description: 'Risk score, every factor and the recommendation for one net cell, now and 7 and 14 days earlier.',
        inputSchema: z.object({ pen_id: penId, cell, day: dayIndex }),
        execute: async ({ pen_id, cell: c, day: d }) => {
          const sim = penSim(pen_id);
          const at = (x: number) => (x < 0 ? null : (({ score, level, factors, recommendation, coverageAge }) => ({ date: dayLabel(x), score, level, factors: factors.map((f) => f.label), recommendation, coverageAge }))(explainRisk(sim, c, x)));
          return { cell: cellLabel(c), now: at(d), weekBefore: at(d - 7), twoWeeksBefore: at(d - 14) };
        },
      }),
      oxygen_detail: tool({
        description: 'Oxygen decision for a pen and day, plus similar past episodes from memory.',
        inputSchema: z.object({ pen_id: penId, day: dayIndex }),
        execute: async ({ pen_id, day: d }) => {
          const decision = decideOxygen(oxygenSources(pen_id, d), d);
          const recall = decision.kind === 'ALERT' ? await similarEpisodes({ kind: 'oxygen', penId: pen_id, day: d, text: decision.reason }, store, defaultDecisionModel()) : [];
          return { decision: { ...decision, lowSources: decision.lowSources.length }, similarPast: recall.map((l) => ({ date: dayLabel(l.episode.day), text: l.episode.text, outcome: l.episode.outcome, linked: l.linked, how: l.note })) };
        },
      }),
      findings: tool({
        description: 'All findings for a pen up to a day, with their review status and history.',
        inputSchema: z.object({ pen_id: penId, day: dayIndex }),
        execute: async ({ pen_id, day: d }) =>
          world.findings
            .filter((f) => f.penId === pen_id && f.detectedDay <= d)
            .map((f) => ({ id: f.id, kind: f.kind, cell: f.cell, area: cellLabel(f.cell), confidence: f.confidence, detected: dayLabel(f.detectedDay), status: findingStatus(f, d, reviews), steps: f.steps.filter((s) => s.day <= d).map((s) => `${dayLabel(s.day)}: ${s.note}`) })),
      }),
      operations: tool({
        description: 'Farm operations (storms, delousing, wellboat, cleaning, net changes) for a pen within a day range.',
        inputSchema: z.object({ pen_id: penId, from_day: dayIndex, to_day: dayIndex }),
        execute: async ({ pen_id, from_day, to_day }) =>
          world.operations.filter((o) => (o.penId === pen_id || o.penId === null) && o.day >= from_day && o.day <= to_day).map((o) => `${dayLabel(o.day)}: ${o.label}`),
      }),
      search_memory: tool({
        description: 'Search past episodes and their outcomes, including history from before the shown period.',
        inputSchema: z.object({ text: z.string().min(2) }),
        execute: async ({ text }) => searchMemory(text, day, reviews).map((e) => ({ date: dayLabel(e.day), pen: e.penId, text: e.text, outcome: e.outcome })),
      }),
    },
  });

  const toolCalls = result.steps.flatMap((s) => s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })));
  store.addChat('user', question);
  store.addChat('assistant', result.text, toolCalls);
  return { text: result.text, toolCalls, model: llm.id };
}
