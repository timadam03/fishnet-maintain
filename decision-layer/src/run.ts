/**
 * CLI for building and rehearsing the demo.
 *   npm run cli -- demo            the four demo beats, printed
 *   npm run cli -- ask "question"  investigator
 *   npm run cli -- curator         run the curator once
 *   npm run cli -- accept <id>     accept a proposal
 *   npm run cli -- reset           clear reviews, closures, proposals and chat
 */
import { modelStatus, openStore } from './app.ts';
import { runCurator } from './curator.ts';
import { defaultDecisionModel } from './d1.ts';
import { findingById, oxygenEventText, penDecisions, siteAlerts } from './engine.ts';
import { ask } from './investigator.ts';
import { sameFinding, similarEpisodes } from './memory.ts';
import { decideFinding } from './rules/net.ts';
import { TODAY, dayLabel } from './world.ts';

const store = openStore();
const [command, ...args] = process.argv.slice(2);

async function demo(): Promise<void> {
  const models = modelStatus();
  const d1 = defaultDecisionModel();
  console.log(`models: agent ${models.agent ?? 'none'}, d1 ${models.d1 ?? 'none (fallback rules)'}; rules ${store.config().frayingReimageBelow === null ? 'v1' : 'v2'}\n`);

  console.log(`1. Today (${dayLabel(TODAY)}): site alerts`);
  for (const a of siteAlerts(TODAY, store.config(), store.reviews(), store.alertClosures())) console.log(`   [${a.level}] ${a.title}: ${a.reason} (${a.rules.join('+')})`);
  const pen7 = penDecisions(7, TODAY, store.config(), store.reviews());
  console.log(`   Pen 7 oxygen: ${pen7.oxygen.kind} (${pen7.oxygen.rules.join('+')}) ${pen7.oxygen.reason}`);
  for (const c of pen7.cells.slice(0, 2)) console.log(`   Pen 7 ${c.label}: ${c.outcome.kind} ${c.outcome.reason} Factors: ${c.factors.join('; ')}`);

  const delousing = 70;
  console.log(`\n2. ${dayLabel(delousing)}: delousing oxygen drop, with memory recall`);
  const pen3 = penDecisions(3, delousing, store.config(), store.reviews());
  console.log(`   Pen 3 oxygen: ${pen3.oxygen.kind} ${pen3.oxygen.level ?? ''} ${pen3.oxygen.reason}`);
  for (const l of await similarEpisodes({ kind: 'oxygen', penId: 3, day: delousing, text: oxygenEventText(3, delousing, pen3.oxygen.reason) }, store, d1)) {
    console.log(`   ${l.linked ? 'LINKED ' : 'not linked'} ${dayLabel(l.episode.day)}: ${l.episode.text} → ${l.episode.outcome} [${l.note}]`);
  }

  console.log('\n3. Pen 4 chafe: was the rejected low-confidence finding the same defect?');
  const link = await sameFinding(findingById(203), store, d1);
  console.log(`   finding 203 (chafe, ${dayLabel(findingById(203).detectedDay)}) vs ${link?.episode.id}: ${link?.linked ? 'same defect' : 'not linked'} [${link?.note}] ${link?.episode.outcome}`);

  console.log('\n4. Learning: low-confidence fraying finding 206');
  console.log(`   v1 → ${decideFinding(findingById(206), { frayingReimageBelow: null }).reason}`);
  console.log(`   active rules → ${decideFinding(findingById(206), store.config()).reason}`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'demo':
      return demo();
    case 'ask': {
      const answer = await ask(store, args.join(' '));
      console.log(answer.text);
      console.log(`\ntools: ${answer.toolCalls.map((c) => c.tool).join(', ') || 'none'} (${answer.model ?? 'no model'})`);
      return;
    }
    case 'curator': {
      const result = await runCurator(store, TODAY);
      console.log(result.note);
      for (const p of result.proposals) console.log(`proposal ${p.id} [${p.rule}] ${JSON.stringify(p.change)}: ${p.rationale}`);
      return;
    }
    case 'accept': {
      const p = store.decideProposal(Number(args[0]), 'accepted');
      console.log(`accepted proposal ${p.id}: ${JSON.stringify(p.change)}`);
      return;
    }
    case 'reset':
      store.reset();
      console.log('cleared reviews, alert closures, proposals and chat');
      return;
    default:
      console.log('commands: demo | ask "<question>" | curator | accept <id> | reset');
      process.exitCode = 1;
  }
}

await main();
