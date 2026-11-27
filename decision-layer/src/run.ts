/**
 * CLI for building and rehearsing the demo.
 *   npm run cli -- demo            the four demo beats, printed
 *   npm run cli -- ask "question"  investigator
 *   npm run cli -- curator         run the curator once
 *   npm run cli -- accept <id>     accept a proposal
 *   npm run cli -- record [day]    record a day's decisions in the log
 *   npm run cli -- trace <entity>  saw → decided → did → outcome, e.g. cell:7:188 or finding:206
 *   npm run cli -- missions [status]           list missions for the robots
 *   npm run cli -- mission <id> <status> [result]  report a mission's progress, as a robot would
 *   npm run cli -- reset           clear reviews, closures, proposals, chat, log and missions
 */
import { modelStatus, openStore } from './app.ts';
import { runCurator } from './curator.ts';
import { defaultDecisionModel } from './d1.ts';
import { findingById, oxygenEventText, penDecisions, siteAlerts } from './engine.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlan, importObservations } from './inspection.ts';
import { ask } from './investigator.ts';
import { missions, recordDay, trace, updateMission } from './log.ts';
import { sameFinding, similarEpisodes } from './memory.ts';
import { decideFinding } from './rules/net.ts';
import { TODAY, dayLabel } from './world.ts';

const store = openStore();
const [command, ...args] = process.argv.slice(2);
/** Which UI pen the Isaac pen stands in for (the sag case in Pen 7 by default). */
const ISAAC_PEN = Number(process.env.ISAAC_PEN ?? 7);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

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

  // Record the days the beats use, so their decisions are in the log under the active rules.
  for (const day of [delousing, findingById(206).detectedDay, TODAY]) await recordDay(store, day, d1);
  console.log('\n5. Trace: Pen 7, 17.5–20 m, 300–315° (what it saw → decided → did → outcome)');
  printTrace('cell:7:188');
  console.log(`   open missions: ${missions(store, { status: 'requested' }).map((m) => `#${m.id} ${m.kind} Pen ${m.penId} (${m.priority})`).join(', ')}`);
}

function printTrace(entity: string): void {
  const steps = trace(store, entity);
  if (steps.length === 0) console.log(`   (nothing logged for ${entity})`);
  for (const s of steps) {
    const links = s.decided.links.map((l) => `${l.to} ${l.linked ? 'linked' : 'not linked'} ${l.probability === null ? '(fallback)' : `p=${l.probability.toFixed(2)}`}`).join('; ');
    console.log(`   ${s.date} [${s.decided.rulesVersion}] saw ${JSON.stringify(s.saw)}`);
    console.log(`      decided ${s.decided.outcome}${s.decided.level ? ` (${s.decided.level})` : ''} by ${s.decided.rules.join('+')}: ${s.decided.reason}${links ? ` | memory: ${links}` : ''}`);
    console.log(`      did ${s.did.mission ? `mission #${s.did.mission.id} ${s.did.mission.kind}` : s.did.alert ? `alert ${s.did.alert}` : 'nothing'}${s.did.recommend ? ` | recommends: ${s.did.recommend}` : ''}`);
    console.log(`      outcome mission: ${s.outcome.mission ?? '-'} | alert: ${s.outcome.alert ?? '-'} | review: ${s.outcome.review ?? '-'}`);
  }
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
    case 'record': {
      const day = args[0] === undefined ? TODAY : Number(args[0]);
      console.log(`recorded ${await recordDay(store, day, defaultDecisionModel())} decisions for ${dayLabel(day)} (0 = already recorded under these rules)`);
      return;
    }
    case 'trace':
      printTrace(args[0] ?? '');
      return;
    case 'import': {
      // import <run_dir> [--pen 7] [--vision <file>]: Isaac captures + pipeline reports → observations
      const dir = args[0];
      if (!dir || dir.startsWith('--')) throw new Error('usage: import <run_dir> [--pen N] [--vision <file>]');
      const lines = (path: string): unknown[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const truthPath = join(dir, 'ground_truth.json');
      const grid = existsSync(truthPath) ? (JSON.parse(readFileSync(truthPath, 'utf8')).grid as { ui_sectors?: number; ui_wall_rows?: number; cage_radius_m?: number } | undefined) : undefined;
      const result = importObservations(store, {
        penId: Number(flag('pen', String(ISAAC_PEN))),
        captures: lines(join(dir, 'captures.jsonl')),
        reports: lines(flag('vision', join(dir, 'vision.jsonl'))),
        cageRadiusM: grid?.cage_radius_m ?? 8,
        grid,
      });
      console.log(`imported ${result.imported} observations; ${result.awaitingVision} captures have no vision report yet; ${result.unmatchedReports.length} reports had no capture`);
      for (const m of result.missionsClosed) console.log(`mission #${m.missionId} done → ${m.result}`);
      return;
    }
    case 'plan': {
      // plan [--pen 7] [--robots 3] [--out plan.json]: what the robots should do next
      const plan = buildPlan(store, { penId: Number(flag('pen', String(ISAAC_PEN))), day: TODAY, robots: Number(flag('robots', '3')) });
      const out = flag('out', '');
      if (out) writeFileSync(out, JSON.stringify(plan, null, 2));
      for (const t of plan.targets) console.log(`${t.target_id} [${t.priority_label} ${t.priority}] cell ${t.cell} → AUV ${t.robots.join('+')}, ${t.scan.standoff_m} m, ${t.scan.viewpoints.length} view(s) × ${t.scan.shots}, margin ${t.safety.margin_m} m | ${t.reasons.slice(1).map((r) => r.rule).join('+')}: ${t.reasons[1].text}`);
      console.log(`${plan.targets.length} targets, then ${plan.coverage.length} cells of coverage${out ? `; written to ${out}` : ''}`);
      return;
    }
    case 'missions':
      for (const m of missions(store, { status: args[0] as never })) console.log(`#${m.id} ${m.status} ${m.kind} Pen ${m.penId} ${m.priority} ${m.areas.slice(0, 3).join('; ')}${m.areas.length > 3 ? ` (+${m.areas.length - 3})` : ''}: ${m.reason}${m.result ? ` → ${m.result}` : ''}`);
      return;
    case 'mission': {
      const m = updateMission(store, Number(args[0]), { status: args[1] as 'assigned' | 'done' | 'cancelled', result: args.slice(2).join(' ') || undefined });
      console.log(`mission #${m.id}: ${m.status}${m.result ? ` → ${m.result}` : ''}`);
      return;
    }
    case 'reset':
      store.reset();
      console.log('cleared reviews, alert closures, proposals, chat, decision log and missions');
      return;
    default:
      console.log('commands: demo | ask "<question>" | curator | accept <id> | record [day] | trace <entity> | missions [status] | mission <id> <assigned|done|cancelled> [result] | import <run_dir> [--pen N] [--vision file] | plan [--pen N] [--robots N] [--out file] | reset');
      process.exitCode = 1;
  }
}

await main();
