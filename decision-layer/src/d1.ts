/**
 * Typed yes/no questions to a "System One" decision model (d1 or Jev) through the Vercel AI
 * Gateway, following BoligRadar's lib/decisions.ts. The model returns a probability; code applies
 * the threshold. If the model is unavailable, callers use a fallback rule and say so: we never
 * invent a probability (PlugPilot's Rule 0).
 */
import { gateway } from '@ai-sdk/gateway';
import { experimental_decide as decide, type Experimental_DecisionModel } from 'ai';

export const DECISION_MODEL = process.env.DECISION_MODEL || 'liquid/d1.2-ultra';

/** USD per input token (BoligRadar, from the gateway model list, Nov 2026). Output is free. */
const PRICE_PER_INPUT_TOKEN: Record<string, number> = {
  'liquid/d1.2-ultra': 0.000000042,
  'liquid/d1.2': 0.00000002,
  'typesafe-ai/jev': 0.000000042,
};

export interface YesNo {
  probability: number;
  model: string;
  estimated_cost_usd: number | null;
}

/** The gateway model, or null when no key is configured. */
export function defaultDecisionModel(): Experimental_DecisionModel | null {
  return process.env.AI_GATEWAY_API_KEY ? gateway.decisionModel(DECISION_MODEL) : null;
}

/** Asks several yes/no questions against one shared state in a single call. */
export async function askYesNo(
  model: Experimental_DecisionModel,
  state: string,
  questions: Record<string, string>,
): Promise<Record<string, YesNo>> {
  if (state.length === 0 || state.length > 6000) throw new Error(`state must be 1–6000 chars, got ${state.length}`);
  const sdkQuestions = Object.fromEntries(Object.entries(questions).map(([name, instructions]) => [name, { type: 'boolean' as const, instructions }]));
  const result = await decide({ model, state, questions: sdkQuestions, maxRetries: 1 });
  const tokens = result.usage.inputTokens;
  const price = PRICE_PER_INPUT_TOKEN[DECISION_MODEL];
  const cost = tokens === undefined || price === undefined ? null : Number(((tokens * price) / Object.keys(questions).length).toFixed(8));
  const out: Record<string, YesNo> = {};
  for (const name of Object.keys(questions)) {
    const raw = result.answers[name] as { type: string; probability?: number };
    if (raw?.type !== 'boolean' || typeof raw.probability !== 'number') throw new Error(`no yes/no answer for ${name}`);
    out[name] = { probability: raw.probability, model: DECISION_MODEL, estimated_cost_usd: cost };
  }
  return out;
}
