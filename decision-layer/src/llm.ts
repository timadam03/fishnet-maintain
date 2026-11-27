/**
 * The chat model for the two agents (investigator, curator). Decision questions don't use it: those
 * go to the decision model in d1.ts. AGENT_MODEL is a gateway id like "nvidia/nemotron-3.5-lightning-free"
 * (uses AI_GATEWAY_API_KEY), or a plain Gemini name like "gemini-3.8-flash" (uses an AI Studio key).
 * Without a model, the curator uses its rule-based version and the investigator says it's off.
 */
import { gateway } from '@ai-sdk/gateway';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';

export function agentModel(): { model: LanguageModel; id: string } | null {
  const id = process.env.AGENT_MODEL;
  if (!id) return null;
  if (id.includes('/')) return process.env.AI_GATEWAY_API_KEY ? { model: gateway(id), id: `gateway:${id}` } : null;
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY ? { model: google(id), id: `google:${id}` } : null;
}

/** First line of a model error, without the request dump the SDK attaches. */
export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const quota = /limit: 0/.test(message) ? ' (this model has no free-tier quota on your key: pick another model with npm run setup)' : '';
  return message.split('\n')[0].replace(/^Failed after \d+ attempts\. Last error: /, '').slice(0, 220) + quota;
}

export const NO_MODEL_NOTE = 'No agent model configured (run npm run setup, or set AGENT_MODEL and its key in .env).';
