/**
 * The language model for the agents: Gemini directly with an AI Studio key, else Gemini through
 * the Vercel AI Gateway, else none (agents then fall back to deterministic answers).
 */
import { gateway } from '@ai-sdk/gateway';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';

export function agentModel(): { model: LanguageModel; id: string } | null {
  const id = process.env.GEMINI_MODEL;
  if (!id) return null;
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return { model: google(id), id: `google:${id}` };
  if (process.env.AI_GATEWAY_API_KEY) return { model: gateway(id), id: `gateway:${id}` };
  return null;
}

export const NO_MODEL_NOTE = 'No agent model configured (set GEMINI_MODEL and GOOGLE_GENERATIVE_AI_API_KEY in .env).';
