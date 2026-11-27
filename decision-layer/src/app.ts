/** Shared setup for the CLI and the HTTP server. */
import { fileURLToPath } from 'node:url';
import { DECISION_MODEL, defaultDecisionModel } from './d1.ts';
import { agentModel } from './llm.ts';
import { Store } from './store.ts';

const DEFAULT_DB = fileURLToPath(new URL('../../shoal.db', import.meta.url));

export function openStore(): Store {
  return new Store(process.env.SHOAL_DB ? fileURLToPath(new URL(process.env.SHOAL_DB, `file://${process.cwd()}/`)) : DEFAULT_DB);
}

/** Which models are live, so the UI and the demo can say so honestly. */
export function modelStatus(): { agent: string | null; d1: string | null } {
  return { agent: agentModel()?.id ?? null, d1: defaultDecisionModel() ? DECISION_MODEL : null };
}
