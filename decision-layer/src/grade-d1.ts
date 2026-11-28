/**
 * The d1 grader: the image pipeline's output for each net cell goes to the decision model (d1 via
 * the Vercel AI Gateway), which grades the cell and sets how urgently the robots should look at it.
 *
 *   classifier (vision.jsonl) ─▶ observations, credited by cell ─▶ d1: six yes/no questions per cell
 *                             ─▶ status + priority per cell ─▶ plan rules (scan, robots, HOCBF margin)
 *
 * What d1 decides: what is most likely in the cell (opening, wear, fouling, nothing), whether the
 * photos settle it, and how urgent it is. What it never decides: distances, viewpoints, robots or
 * safety margins. Those come from the plan rules for the status d1 chose (inspection.ts), so the
 * model can reorder and reclassify the work but can't make a target unreachable or unsafe.
 *
 * Every cell d1 can't answer (no key, an error, rate limit) is graded by the rules instead and says
 * so in its reason: never a made-up probability. Answers are cached on the exact text sent.
 */
import { createHash } from 'node:crypto';
import type { Experimental_DecisionModel } from 'ai';
import { GRID } from './contracts.ts';
import { CLOSE_UP_M, assessCell, observationsByCell, type Grade, type Observation } from './inspection.ts';
import { missions } from './log.ts';
import type { Store } from './store.ts';
import { explainRisk, penSim } from './world.ts';

export const D1_GRADER_VERSION = 'd1-grade-v1';

export type Ask = (state: string, questions: Record<string, string>) => Promise<Record<string, { probability: number }>>;

/** The questions, one d1 call per cell. Each is answered with a probability; code sets the thresholds. */
export const QUESTIONS = {
  opening: 'Is there most likely a hole or a gap in the mesh (missing or broken twine) in this cell?',
  wear: 'Is the twine in this cell most likely worn, thinned or frayed, but not yet open?',
  fouling: 'Is the net in this cell heavily fouled, with growth covering the mesh?',
  hidden: 'Could damage in this cell be missed because the photos are too far away, too unclear or covered by fouling?',
  settled: 'Do the photos already settle what is in this cell, so that a closer look would not change the decision?',
  urgent: 'Considering what was seen, how large it may be, the neighbouring cells and the risk of this area, should the robots check this cell before most other cells of the net?',
} as const;
type Answers = Record<keyof typeof QUESTIONS, number>;

/** d1 behind a cache in the store, keyed on the exact state and questions sent. */
export async function d1Ask(store: Store): Promise<{ ask: Ask; model: string } | null> {
  const { defaultDecisionModel, askYesNo, DECISION_MODEL } = await import('./d1.ts');
  const model: Experimental_DecisionModel | null = defaultDecisionModel();
  if (!model) return null;
  const ask: Ask = async (state, questions) => {
    const key = `grade:${DECISION_MODEL}:${createHash('sha256').update(state + JSON.stringify(questions)).digest('hex').slice(0, 20)}`;
    const hit = store.cached<Record<string, { probability: number }>>(key);
    if (hit) return hit;
    const answers = await askYesNo(model, state, questions);
    store.cache(key, answers);
    return answers;
  };
  return { ask, model: DECISION_MODEL };
}

const qualityOf = (o: Observation): number => (o.quality ? Math.min(o.quality.visibility, o.quality.sharpness) : 0.6);
const sectorDeg = 360 / GRID.sectors;
const rowOf = (cell: number) => Math.floor(cell / GRID.sectors);
const colOf = (cell: number) => cell % GRID.sectors;
const cellAt = (row: number, col: number) => row * GRID.sectors + (((col % GRID.sectors) + GRID.sectors) % GRID.sectors);

export function neighbours(cell: number): Array<{ cell: number; where: string }> {
  const r = rowOf(cell), c = colOf(cell);
  const out = [
    { cell: cellAt(r, c + 1), where: 'next sector anticlockwise' },
    { cell: cellAt(r, c - 1), where: 'next sector clockwise' },
  ];
  if (r > 0) out.push({ cell: cellAt(r - 1, c), where: 'above' });
  if (r < GRID.wallRows - 1) out.push({ cell: cellAt(r + 1, c), where: 'below' });
  return out;
}

export function describePhoto(o: Observation, i: number): string {
  const dist = o.standoffM === null ? 'distance unknown' : `${o.standoffM.toFixed(1)} m from the net (${o.standoffM <= CLOSE_UP_M ? 'close-up' : 'far survey'})`;
  const q = o.quality ? `image quality ${qualityOf(o).toFixed(2)} (visibility ${o.quality.visibility.toFixed(2)}, sharpness ${o.quality.sharpness.toFixed(2)})` : 'image quality not reported';
  const purpose = o.targetId ? `taken for mission ${o.targetId}` : 'routine sweep';
  const dets = o.detections.length
    ? o.detections.map((d) => `${d.class} confidence ${d.confidence.toFixed(2)}${d.size_m !== undefined ? `, about ${d.size_m.toFixed(2)} m across` : ''}${d.severity ? `, severity ${d.severity}` : ''}`).join('; ')
    : 'nothing found on this cell';
  const foul = o.fouling !== null ? `, fouling over ${Math.round(o.fouling * 100)}% of the frame` : '';
  return `- Photo ${i + 1}: AUV ${o.auv ?? '?'}, ${purpose}, ${dist}, ${q}${foul}. On this cell: ${dets}.`;
}

export function summarise(cell: number, obs: Observation[] | undefined): string {
  if (!obs?.length) return 'not photographed';
  const a = assessCell(cell, obs);
  const found = [
    a.opening > 0 ? `opening up to ${a.opening.toFixed(2)}` : '',
    a.wear > 0 ? `wear up to ${a.wear.toFixed(2)}` : '',
    a.fouling >= 0.1 ? `fouling ${Math.round(a.fouling * 100)}%` : '',
  ].filter(Boolean);
  return `${obs.length} photo${obs.length > 1 ? 's' : ''}, ${found.length ? found.join(', ') : 'nothing found'}`;
}

/** The text d1 sees for one cell: what was photographed, what the detector found, the area around it. */
export function cellState(cell: number, obs: Observation[], byCell: Map<number, Observation[]>, context: { risk: ReturnType<typeof explainRisk>; history: string[] }): string {
  const row = rowOf(cell), col = colOf(cell);
  const depthPart = row <= 1 ? 'upper wall, near the surface' : row >= GRID.wallRows - 2 ? 'lower wall, near the bottom' : 'middle of the wall';
  // Close-ups first, then the strongest detections: the most informative photos survive the length cap.
  const best = (o: Observation) => Math.max(0, ...o.detections.map((d) => d.confidence));
  const ranked = [...obs].sort((a, b) => Number((b.standoffM ?? 9) <= CLOSE_UP_M) - Number((a.standoffM ?? 9) <= CLOSE_UP_M) || best(b) - best(a)).slice(0, 12);
  const factors = [...context.risk.factors].sort((a, b) => b.weight - a.weight).slice(0, 3).map((f) => f.label).join('; ');
  const lines = [
    'Underwater inspection of one circular fish-farm net pen by a swarm of small robots with cameras.',
    'A robot first surveys the whole net from far away; the decision is which areas need a closer look, and in what order.',
    'The detector is a classical computer-vision net inspector. Its confidences are not calibrated probabilities.',
    '"mesh_opening" means it saw a gap it could not commit to calling a hole; "thinning" comes from how wide the twine looks;',
    'it needs a dozen or so clear mesh openings in view to judge the mesh, so far or unclear photos miss small defects.',
    '',
    `Cell ${cell}: sector ${col + 1} of ${GRID.sectors} (${col * sectorDeg}–${(col + 1) * sectorDeg}°), wall row ${row + 1} of ${GRID.wallRows} (${depthPart}). A cell is about 2 m wide and 1 m high.`,
    `Risk model for this area (history and exposure): ${context.risk.level} (${context.risk.score.toFixed(2)}). Main factors: ${factors}.`,
    `Photos of this cell (${obs.length}${obs.length > ranked.length ? `, ${ranked.length} most informative shown` : ''}):`,
    ...ranked.map(describePhoto),
    'Neighbouring cells:',
    ...neighbours(cell).map((n) => `- Cell ${n.cell} (${n.where}): ${summarise(n.cell, byCell.get(n.cell))}.`),
    context.history.length ? `Earlier missions on this cell: ${context.history.join(' | ')}` : 'No earlier missions on this cell.',
  ];
  let state = lines.join('\n');
  if (state.length > 5900) state = `${state.slice(0, 5880)}\n(truncated)`;
  return state;
}

/** A cell worth a d1 call: anything found on it or next to it, a poor photo, or fouling. Clean, clear cells stay with the rules. */
function worthAsking(cell: number, obs: Observation[], byCell: Map<number, Observation[]>): boolean {
  const a = assessCell(cell, obs);
  if (a.status !== 'clear') return true;
  if (obs.some((o) => o.detections.some((d) => d.confidence >= 0.15))) return true;
  return neighbours(cell).some((n) => {
    const nb = byCell.get(n.cell);
    return nb ? assessCell(n.cell, nb).opening >= 0.5 : false;
  });
}

/** d1's answers to a status and a priority. The two-view rule for a confirmed opening stays. */
export function gradeFromAnswers(cell: number, obs: Observation[], p: Answers): Grade {
  const rules = assessCell(cell, obs);
  const open = p.settled < 0.5;
  const status: Grade['status'] =
    p.opening >= 0.75 && rules.openingViews >= 2 ? 'confirmed_opening'
    : p.opening >= 0.55 ? 'possible_opening'
    : p.wear >= 0.6 ? 'wear'
    : open && Math.max(p.opening, p.wear) >= 0.25 ? 'uncertain'
    : p.hidden >= 0.6 && rules.quality < 0.5 ? 'unclear'
    : p.fouling >= 0.6 || (p.hidden >= 0.6 && rules.fouling >= 0.2) ? 'fouled'
    : 'clear';
  // How much a closer look is worth here: the strongest reason, discounted when the photos already settle it.
  const need = Math.max(p.opening, 0.75 * p.wear, 0.6 * p.hidden * (1 - p.settled), 0.45 * p.fouling);
  const priority = Number(Math.min(1, 0.2 + 0.55 * need + 0.25 * p.urgent).toFixed(2));
  const pct = (x: number) => x.toFixed(2);
  const note = `d1 graded ${status.replace('_', ' ')}: opening ${pct(p.opening)}, wear ${pct(p.wear)}, fouling ${pct(p.fouling)}, could be hidden ${pct(p.hidden)}, settled ${pct(p.settled)}, urgent ${pct(p.urgent)} → priority ${priority.toFixed(2)}.`;
  return { ...rules, status, by: 'd1', priority, note };
}

export interface D1Grading {
  grades: Map<number, Grade>;
  model: string | null;
  asked: number;
  fellBack: Array<{ cell: number; why: string }>;
}

/**
 * Grades every photographed cell of a pen: d1 for the cells worth asking about, rules for the rest
 * (clean cells, and any cell d1 couldn't answer). `ask` = null grades everything by the rules.
 */
export async function gradeWithD1(store: Store, input: { penId: number; day: number; ask: Ask | null; model?: string | null; concurrency?: number }): Promise<D1Grading> {
  const byCell = observationsByCell(store, input.penId);
  const sim = penSim(input.penId);
  const history = new Map<number, string[]>();
  for (const m of missions(store, { penId: input.penId })) {
    for (const c of m.cells) history.set(c, [...(history.get(c) ?? []), `#${m.id} ${m.kind} ${m.status}${m.result ? `: ${m.result}` : ''}`]);
  }

  const grades = new Map<number, Grade>();
  const queue: number[] = [];
  for (const [cell, obs] of byCell) {
    grades.set(cell, { ...assessCell(cell, obs), by: 'rules' });
    if (input.ask && worthAsking(cell, obs, byCell)) queue.push(cell);
  }

  const fellBack: D1Grading['fellBack'] = [];
  let asked = 0;
  const worker = async () => {
    for (let cell = queue.shift(); cell !== undefined; cell = queue.shift()) {
      const obs = byCell.get(cell)!;
      const state = cellState(cell, obs, byCell, { risk: explainRisk(sim, cell, input.day), history: history.get(cell) ?? [] });
      try {
        const raw = await input.ask!(state, QUESTIONS);
        const p = Object.fromEntries(Object.keys(QUESTIONS).map((k) => {
          const v = raw[k]?.probability;
          if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`no answer for ${k}`);
          return [k, v];
        })) as Answers;
        grades.set(cell, gradeFromAnswers(cell, obs, p));
        asked++;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        fellBack.push({ cell, why });
        const g = grades.get(cell)!;
        grades.set(cell, { ...g, note: `rules (d1 unavailable for this cell: ${why.slice(0, 80)})` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, input.concurrency ?? 4) }, worker));
  return { grades, model: input.model ?? null, asked, fellBack };
}

/**
 * After a plan run: d1's verdict on each mission's own close-ups, added to the mission result next
 * to the rules' verdict, so the trace shows both. Missions d1 can't answer keep the rules' result.
 */
export async function regradeMissions(store: Store, input: { penId: number; day: number; ask: Ask; missionIds: number[] }): Promise<Array<{ missionId: number; result: string }>> {
  const all = observationsByCell(store, input.penId);
  const sim = penSim(input.penId);
  const out: Array<{ missionId: number; result: string }> = [];
  for (const id of input.missionIds) {
    const m = missions(store, { penId: input.penId }).find((x) => x.id === id);
    const cell = m?.cells[0];
    if (!m || cell === undefined || !m.result) continue;
    const own = (all.get(cell) ?? []).filter((o) => o.targetId === `m${id}`);
    if (own.length === 0) continue;
    const state = cellState(cell, own, all, { risk: explainRisk(sim, cell, input.day), history: [] });
    try {
      const raw = await input.ask(state, QUESTIONS);
      const p = Object.fromEntries(Object.keys(QUESTIONS).map((k) => [k, raw[k].probability])) as Answers;
      const g = gradeFromAnswers(cell, own, p);
      const result = `${m.result.replace(/ \| d1: .*$/, '')} | d1: ${g.status.replace('_', ' ')} (opening ${p.opening.toFixed(2)}, wear ${p.wear.toFixed(2)}, settled ${p.settled.toFixed(2)})`;
      store.db.prepare('UPDATE missions SET result = ?, updated_at = ? WHERE id = ?').run(result, new Date().toISOString(), id);
      out.push({ missionId: id, result });
    } catch {
      // keep the rules' result
    }
  }
  return out;
}
