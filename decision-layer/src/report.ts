/**
 * The report agent: for a case d1 #2 called critical, a draft report for the engineer on site, with
 * the photos the robots took. The engineer approves, edits or rejects it (escalate.ts).
 *
 * The agent writes the prose only. The facts in the report (what was decided, by whom, where,
 * which photos, the probabilities) are filled in by code from the case, so the agent can't change
 * the severity, move the defect or leave a photo out. It is told to use only the facts it is given.
 * Engineers' corrections of earlier drafts are passed in as examples, so the drafts move towards
 * how the engineers write (the report-writing half of the multi-farm loop).
 *
 * Without an agent model (no AGENT_MODEL, an error) the report is a fixed template and says so.
 */
import { relative } from 'node:path';

export type Escalation = 'critical' | 'human_review' | 'reinspect' | 'monitor' | 'auto_close';

export interface Evidence {
  /** Path relative to the run folder, e.g. auv_1/img_0042.png. */
  image: string;
  /** The detector's drawing of the same photo (overlays/...), when it exists. */
  overlay: string | null;
  auv: number | null;
  standoffM: number | null;
  /** What the detector found on this cell in this photo, in words. */
  found: string;
}

/** Everything a report may say: the decided facts of one case, nothing else. */
export interface CaseFacts {
  caseNo: number | null;
  missionId: number;
  farmId: string;
  penId: number;
  cell: number;
  cellLabel: string;
  decision: Escalation;
  decidedBy: 'd1' | 'rules';
  model: string | null;
  reason: string;
  /** d1 #2's answers (null when the rules decided). */
  probabilities: Record<string, number> | null;
  /** Why the robots were sent, and what the close-ups showed by the rules and d1 #1. */
  missionReason: string;
  stage1: string | null;
  robots: string[];
  /** Largest opening the detector measured on the close-ups, in metres. */
  sizeM: number | null;
  risk: string;
  earlier: string[];
  evidence: Evidence[];
  createdAt: string;
}

const TITLE: Record<Escalation, string> = {
  critical: 'CRITICAL: net defect, engineer action needed',
  human_review: 'For review: engineer to check the photos',
  reinspect: 'Re-inspection requested',
  monitor: 'Monitor',
  auto_close: 'Closed: nothing found',
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Image links relative to where the report file is saved. */
function link(path: string, reportDir: string | null, runDir: string | null): string {
  if (!reportDir || !runDir) return path;
  return relative(reportDir, `${runDir}/${path}`).replaceAll('\\', '/');
}

/** The parts code writes: header, location, decision, evidence. */
function factsHeader(f: CaseFacts): string {
  const probs = f.probabilities
    ? Object.entries(f.probabilities).map(([k, v]) => `${k.replace('_', ' ')} ${pct(v)}`).join(', ')
    : 'not asked (decided by the rules)';
  return [
    `# ${TITLE[f.decision]}`,
    '',
    `Farm ${f.farmId}, pen ${f.penId}, net cell ${f.cell} (${f.cellLabel}). Mission #${f.missionId}${f.caseNo !== null ? `, case ${f.caseNo}` : ''}. ${f.createdAt.slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    '## Decision',
    '',
    `- **${f.decision.replace('_', ' ')}**, decided by ${f.decidedBy === 'd1' ? `d1 #2 (${f.model ?? 'd1'})` : 'the rules'}. ${f.reason}`,
    `- d1 #2 answers: ${probs}.`,
    `- Why the robots went closer: ${f.missionReason}`,
    `- What the close-ups showed: ${f.stage1 ?? 'no result recorded'}`,
    f.sizeM !== null ? `- Largest opening measured by the detector: about ${f.sizeM.toFixed(2)} m across.` : '- The detector gave no size for this defect.',
    `- Risk model for this area: ${f.risk}.`,
    `- Robots: ${f.robots.length ? f.robots.join(', ') : 'not recorded'}.`,
  ].join('\n');
}

function evidenceSection(f: CaseFacts, reportDir: string | null, runDir: string | null): string {
  if (f.evidence.length === 0) return '## Evidence\n\nNo photos stored with this case.';
  const rows = f.evidence.map((e, i) => {
    const dist = e.standoffM === null ? 'distance unknown' : `${e.standoffM.toFixed(1)} m from the net`;
    const photo = `![photo ${i + 1}](${link(e.image, reportDir, runDir)})`;
    const overlay = e.overlay ? ` ![detector view ${i + 1}](${link(e.overlay, reportDir, runDir)})` : '';
    return `**Photo ${i + 1}**: AUV-${e.auv ?? '?'}, ${dist}. Detector: ${e.found}.\n\n${photo}${overlay}`;
  });
  return ['## Evidence', '', ...rows.flatMap((r) => [r, ''])].join('\n').trimEnd();
}

function templateProse(f: CaseFacts): string {
  const action =
    f.decision === 'critical' ? 'Check the net at this cell as soon as possible and plan a repair. Consider a diver or a net change if the opening is confirmed.'
    : f.decision === 'human_review' ? 'Look at the photos and decide: repair, another inspection, or close the case.'
    : f.decision === 'reinspect' ? 'No action for the engineer yet: the robots will look again.'
    : 'No action needed.';
  return [
    '## Summary',
    '',
    `Net cell ${f.cell} (${f.cellLabel}), pen ${f.penId}. ${f.reason}`,
    '',
    '## Recommended action',
    '',
    action,
  ].join('\n');
}

const SYSTEM = `You write anomaly reports about fish-farm net pens for the net engineer on site.
Robots photographed the net; a detector and a decision model judged the photos. You get the decided facts.
Rules:
- Use only the facts given. Do not invent measurements, causes, dates or repairs the facts do not support.
- Do not change the decision or its severity. Do not soften or exaggerate it.
- Plain language, metric units, short sentences. Under 250 words in total.
- Write exactly these Markdown sections, in this order, and nothing else:
## Summary  (2-3 sentences: what, where, how sure, how urgent)
## What the robots saw  (the photos and what they show, by photo number)
## Confidence and open questions  (what is certain, what is not, what the engineer should check)
## Recommended action  (concrete next steps for the engineer)`;

function agentPrompt(f: CaseFacts, examples: Array<{ draft: string; final: string }>): string {
  const facts = {
    decision: f.decision, decided_by: f.decidedBy, reason: f.reason, d1_answers: f.probabilities,
    location: `pen ${f.penId}, net cell ${f.cell} (${f.cellLabel})`, why_robots_went_closer: f.missionReason,
    close_up_result: f.stage1, largest_opening_m: f.sizeM, risk_model: f.risk, earlier_on_this_area: f.earlier,
    photos: f.evidence.map((e, i) => ({ photo: i + 1, robot: `AUV-${e.auv ?? '?'}`, distance_m: e.standoffM, detector: e.found })),
  };
  const ex = examples.length
    ? `\n\nEngineers corrected earlier drafts like this. Follow their corrections in style and content:\n${examples
        .map((e, i) => `--- Example ${i + 1}: draft ---\n${e.draft.slice(0, 1200)}\n--- Example ${i + 1}: as the engineer filed it ---\n${e.final.slice(0, 1200)}`)
        .join('\n')}`
    : '';
  return `Facts of the case (JSON):\n${JSON.stringify(facts, null, 2)}${ex}\n\nWrite the four sections.`;
}

/** Only the four sections the agent is allowed to write; anything else it sends is dropped. */
export function keepAgentSections(text: string): string {
  const allowed = ['## Summary', '## What the robots saw', '## Confidence and open questions', '## Recommended action'];
  const parts = text.replace(/\r\n/g, '\n').split(/^(?=## )/m);
  const kept = parts.filter((p) => allowed.some((h) => p.trimStart().startsWith(h))).map((p) => p.trim());
  return kept.join('\n\n');
}

export interface Draft {
  md: string;
  by: string;
}

/**
 * The report for one case. `agent` false (or no model) gives the template. `reportDir`/`runDir`
 * make the image links work from where the file is saved.
 */
export async function draftReport(
  f: CaseFacts,
  opts: { agent: boolean; examples?: Array<{ draft: string; final: string }>; reportDir?: string | null; runDir?: string | null },
): Promise<Draft> {
  const reportDir = opts.reportDir ?? null, runDir = opts.runDir ?? null;
  const footer = '---\nDraft for the engineer on site. Approve, edit or reject it: `npm run cli -- review <case> approve|edit <file>|reject`.';
  const assemble = (prose: string, by: string) => ({ md: [factsHeader(f), prose, evidenceSection(f, reportDir, runDir), `${footer}\nWritten by: ${by}.`].join('\n\n') + '\n', by });

  if (!opts.agent) return assemble(templateProse(f), 'template');
  const { agentModel, shortError } = await import('./llm.ts');
  const llm = agentModel();
  if (!llm) return assemble(templateProse(f), 'template (no agent model configured)');
  try {
    const { generateText } = await import('ai');
    const result = await generateText({ model: llm.model, maxRetries: 1, system: SYSTEM, prompt: agentPrompt(f, opts.examples ?? []) });
    const prose = keepAgentSections(result.text);
    if (!prose.includes('## Summary')) return assemble(templateProse(f), `template (the agent's answer had no Summary section)`);
    return assemble(prose, `report agent ${llm.id}`);
  } catch (error) {
    return assemble(templateProse(f), `template (agent failed: ${shortError(error)})`);
  }
}
