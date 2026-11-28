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
 *   npm run cli -- import <run_dir> [--grader d1]   Isaac captures + vision reports → observations
 *   npm run cli -- plan [--grader rules|d1] [--out plan.json]   what the robots should do next
 *   npm run cli -- escalate <run_dir> [--grader rules|d1]   d1 #2 on the close-ups: critical? engineer? (reports in run_dir/reports)
 *   npm run cli -- review [all]                    the engineer's queue, and how often engineers agreed
 *   npm run cli -- review <case> approve|reject|edit <file> [--by name] [--note text]
 *   npm run cli -- report <case>                   print a case's report
 *   npm run cli -- export-cases <file.jsonl> [--all]   reviewed cases as training data (appends new ones)
 *   npm run cli -- import-cases <file.jsonl>       cases from other farms: calibration and report examples
 */
import { modelStatus, openStore } from './app.ts';
import { runCurator } from './curator.ts';
import { defaultDecisionModel } from './d1.ts';
import { findingById, oxygenEventText, penDecisions, siteAlerts } from './engine.ts';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FARM_ID, agreement, caseByNo, caseRecord, cases, d1EscalationAsk, escalateMissions, forgetCases, importCases, reviewCase } from './escalate.ts';
import { gradeWithD1, d1Ask, regradeMissions } from './grade-d1.ts';
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
      const penId = Number(flag('pen', String(ISAAC_PEN)));
      const regraded = new Map<number, string>();
      if (flag('grader', 'rules') === 'd1' && result.missionsClosed.length > 0) {
        const d1 = await d1Ask(store);
        if (!d1) console.log('d1: no AI_GATEWAY_API_KEY, missions closed by the rules only');
        else for (const r of await regradeMissions(store, { penId, day: TODAY, ask: d1.ask, missionIds: result.missionsClosed.map((m) => m.missionId) })) regraded.set(r.missionId, r.result);
      }
      for (const m of result.missionsClosed) console.log(`mission #${m.missionId} done → ${regraded.get(m.missionId) ?? m.result}`);
      return;
    }
    case 'plan': {
      // plan [--pen 7] [--robots 3] [--out plan.json]: what the robots should do next
      const penId = Number(flag('pen', String(ISAAC_PEN)));
      const grader = flag('grader', 'rules');
      if (grader !== 'rules' && grader !== 'd1') throw new Error(`--grader must be rules or d1, got ${grader}`);
      let grades;
      if (grader === 'd1') {
        const d1 = await d1Ask(store);
        if (!d1) console.log('d1: no AI_GATEWAY_API_KEY in ../.env, so every cell is graded by the rules');
        const g = await gradeWithD1(store, { penId, day: TODAY, ask: d1?.ask ?? null, model: d1?.model ?? null });
        grades = g.grades;
        console.log(`d1 (${g.model ?? 'none'}): graded ${g.asked} cells, ${g.grades.size - g.asked - g.fellBack.length} clean cells by the rules${g.fellBack.length ? `, ${g.fellBack.length} fell back to the rules (${g.fellBack[0].why})` : ''}`);
      }
      const plan = buildPlan(store, { penId, day: TODAY, robots: Number(flag('robots', '3')), grades });
      const out = flag('out', '');
      if (out) writeFileSync(out, JSON.stringify(plan, null, 2));
      for (const t of plan.targets) console.log(`${t.target_id} [${t.priority_label} ${t.priority}] cell ${t.cell} → AUV ${t.robots.join('+')}, ${t.scan.standoff_m} m, ${t.scan.viewpoints.length} view(s) × ${t.scan.shots}, margin ${t.safety.margin_m} m | ${t.reasons.slice(1).map((r) => r.rule).join('+')}: ${t.reasons[1].text}`);
      console.log(`${plan.targets.length} targets, then ${plan.coverage.length} cells of coverage${out ? `; written to ${out}` : ''}`);
      return;
    }
    case 'escalate': {
      // escalate <run_dir> [--pen N] [--grader rules|d1] [--again] [--no-agent]: d1 #2 on each closed mission's close-ups
      const dir = args[0];
      if (!dir || dir.startsWith('--')) throw new Error('usage: escalate <run_dir> [--pen N] [--grader rules|d1] [--again] [--no-agent]');
      const penId = Number(flag('pen', String(ISAAC_PEN)));
      const grader = flag('grader', 'rules');
      if (grader !== 'rules' && grader !== 'd1') throw new Error(`--grader must be rules or d1, got ${grader}`);
      const d1 = grader === 'd1' ? await d1EscalationAsk(store) : null;
      if (grader === 'd1' && !d1) console.log('d1 #2: no AI_GATEWAY_API_KEY, so the rules decide every case');
      const results = await escalateMissions(store, { penId, day: TODAY, ask: d1?.ask ?? null, model: d1?.model ?? null, runDir: dir, again: args.includes('--again'), agent: !args.includes('--no-agent') });
      if (results.length === 0) console.log('no new closed missions to decide');
      for (const r of results) {
        console.log(`case ${r.caseNo} (mission #${r.missionId}, cell ${r.cell}): ${r.decision.toUpperCase().replace('_', ' ')} by ${r.decidedBy}: ${r.reason}`);
        if (r.reportPath) console.log(`   report (${r.reportBy}): ${r.reportPath}`);
      }
      const n = (d: string) => results.filter((r) => r.decision === d).length;
      if (results.length) console.log(`${results.length} cases: ${n('critical')} critical, ${n('human_review')} for an engineer, ${n('reinspect')} to re-inspect, ${n('monitor')} to monitor, ${n('auto_close')} closed`);
      return;
    }
    case 'review': {
      const caseArg = args[0];
      if (caseArg === undefined || caseArg === 'all') {
        const list = caseArg === 'all' ? cases(store) : cases(store, { reviewStatus: 'pending' });
        if (list.length === 0) console.log(caseArg === 'all' ? 'no cases yet' : 'nothing waiting for an engineer');
        for (const c of list) console.log(`case ${c.caseNo} [${c.reviewStatus}${c.verdict ? `: ${c.verdict}` : ''}] ${c.decision.toUpperCase().replace('_', ' ')} ${c.farmId} pen ${c.penId} cell ${c.cell} (${c.cellLabel})${c.source === 'imported' ? ' (imported)' : ` mission #${c.missionId}`}: ${c.reason}${c.reportPath ? `\n   report: ${c.reportPath}` : ''}`);
        const a = agreement(store);
        if (a.reviewed) console.log(`engineers reviewed ${a.reviewed} cases: escalations ${a.escalatedReal} real / ${a.escalatedFalse} false alarm, ${a.missed} missed by the escalation, ${a.reportsEdited} reports edited`);
        return;
      }
      // review <case> approve|reject|edit <file> (aliases: real, false-alarm). On a case that was
      // closed without an engineer, approve/edit means "there is a defect after all": a missed case.
      const action = args[1];
      const by = flag('by', process.env.REVIEWER ?? '') || undefined;
      const note = flag('note', '') || undefined;
      let c;
      if (action === 'approve' || action === 'real') c = reviewCase(store, Number(caseArg), { verdict: 'real', reviewer: by, note });
      else if (action === 'reject' || action === 'false-alarm') c = reviewCase(store, Number(caseArg), { verdict: 'false_alarm', reviewer: by, note });
      else if (action === 'edit' && args[2] && !args[2].startsWith('--')) c = reviewCase(store, Number(caseArg), { verdict: 'real', reviewer: by, note, finalReportMd: readFileSync(args[2], 'utf8') });
      else throw new Error('usage: review <case> approve|reject|edit <file> [--by name] [--note text]');
      console.log(`case ${c.caseNo}: ${c.reviewStatus} (${c.verdict === 'real' ? 'real defect' : 'false alarm'})${c.reviewer ? ` by ${c.reviewer}` : ''}`);
      return;
    }
    case 'report': {
      const c = caseByNo(store, Number(args[0]));
      console.log(c.finalReportMd ?? c.reportMd ?? `case ${c.caseNo} has no report (${c.decision}: ${c.reason})`);
      return;
    }
    case 'export-cases': {
      // Appends cases not yet in the file, so one file can collect cases from many runs and farms.
      const file = args[0];
      if (!file || file.startsWith('--')) throw new Error('usage: export-cases <file.jsonl> [--all]');
      const have = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => (JSON.parse(l) as { case_id: string }).case_id) : []);
      const fresh = cases(store, { source: 'local' }).filter((c) => (args.includes('--all') || c.verdict !== null) && !have.has(c.caseId));
      for (const c of fresh) appendFileSync(file, `${JSON.stringify(caseRecord(c))}\n`);
      console.log(`${fresh.length} new case${fresh.length === 1 ? '' : 's'} from ${FARM_ID} added to ${file} (${have.size + fresh.length} in the file)${args.includes('--all') ? '' : '; only reviewed cases, --all for every case'}`);
      return;
    }
    case 'import-cases': {
      const file = args[0];
      if (!file) throw new Error('usage: import-cases <file.jsonl>');
      const records = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
      const own = records.filter((r) => r.farm_id === FARM_ID).length;
      const added = importCases(store, records.filter((r) => r.farm_id !== FARM_ID));
      console.log(`imported ${added} new cases from other farms (${own} of this farm's own skipped)`);
      return;
    }
    case 'forget-cases':
      forgetCases(store);
      console.log('cleared the case library (escalations, reviews, reports)');
      return;
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
      console.log('cleared reviews, alert closures, proposals, chat, decision log and missions (the case library stays: forget-cases clears it)');
      return;
    default:
      console.log('commands: demo | ask "<question>" | curator | accept <id> | record [day] | trace <entity> | missions [status] | mission <id> <assigned|done|cancelled> [result] | import <run_dir> [--pen N] [--vision file] [--grader d1] | plan [--pen N] [--robots N] [--grader rules|d1] [--out file] | escalate <run_dir> [--grader rules|d1] | review [all] | review <case> approve|reject|edit <file> | report <case> | export-cases <file> [--all] | import-cases <file> | forget-cases | reset');
      process.exitCode = 1;
  }
}

await main();
