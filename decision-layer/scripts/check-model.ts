/**
 * One tiny live request to check that a model works with the keys in .env. Used by setup.
 *   tsx scripts/check-model.ts decision liquid/d1.2-ultra
 *   tsx scripts/check-model.ts agent nvidia/nemotron-3.5-lightning-free
 * Prints "ok" or a one-line reason; exits 0 either way so setup can offer another choice.
 */
import { gateway } from '@ai-sdk/gateway';
import { generateText } from 'ai';
import { askYesNo } from '../src/d1.ts';
import { agentModel, shortError } from '../src/llm.ts';

const [kind, id] = process.argv.slice(2);

async function check(): Promise<string> {
  if (kind === 'decision') {
    if (!process.env.AI_GATEWAY_API_KEY) return 'needs AI_GATEWAY_API_KEY';
    const answers = await askYesNo(gateway.decisionModel(id), 'A drone found a torn mesh in the net.', { damage: 'Does the text describe net damage?' });
    return `ok (p=${answers.damage.probability.toFixed(2)})`;
  }
  if (kind === 'agent') {
    process.env.AGENT_MODEL = id;
    const llm = agentModel();
    if (!llm) return id.includes('/') ? 'needs AI_GATEWAY_API_KEY' : 'needs GOOGLE_GENERATIVE_AI_API_KEY';
    await generateText({ model: llm.model, prompt: 'Reply with the word ok.', maxOutputTokens: 5, maxRetries: 0 });
    return 'ok';
  }
  return 'usage: check-model.ts decision|agent <model id>';
}

check().then(
  (result) => console.log(result),
  (error) => console.log(shortError(error).replace(/ Add AI Gateway credits.*/, ' (needs paid AI Gateway credits)')),
);
