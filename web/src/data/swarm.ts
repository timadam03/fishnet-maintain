/**
 * The inspection swarm's state on a given day: which drone works where, how it looks, and why.
 *
 * Drones follow the plan rules of the decision layer (docs/contracts.md, P1–P6): most of the time
 * they sweep for coverage, stalest and riskiest areas first, a normal distance off the net. Areas
 * that need a better look get a targeted one instead: closer, from more angles, or with a second
 * drone. A possible opening seen once (P1) gets two drones, one on each side, because one drone
 * alone cannot confirm it. A confirmed hole leaves the plan: it needs the repair crew, not more
 * robot time. One drone has been docked for repair since day 70, which is why Pen 8's cone has not
 * been seen (the data-trust case).
 */
import { ANGLE_SECTORS, CELLS, TODAY, WALL_ROWS, cellCol, cellLabel, cellRow, dayLabel, rowDepth, type Finding, type World } from './model';
import { coverageAge, riskScore } from './risk';
import { hashNoise } from './rng';
import { CONE_DRONE_DOCKED_DAY } from './simulate';

export type DroneStatus = 'inspecting' | 'sampling' | 'returning' | 'docked';

/** Which plan rule a drone is working on; `sweep` is ordinary coverage. Rules as in docs/contracts.md. */
export type PlanRule = 'P1' | 'P2' | 'P4' | 'P5' | 'P6' | 'sweep';

export interface Drone {
  id: string;
  name: string;
  status: DroneStatus;
  /** Pen the drone works in, or null when at the barge. */
  penIndex: number | null;
  cell: number | null;
  depth: number;
  battery: number;
  task: string;
  reason: string;
  next: string[];
  /** Minutes since the last acoustic message reached the barge. */
  lastContactMin: number;
  health: string;
  rule: PlanRule;
  /** Distance from the net while taking photos, metres. */
  standoffM: number;
  /** Viewpoint offset around the pen from the area's centre, degrees (the other side for P1, P4). */
  viewDeg: number;
  /** The other drone on the same target (P1). */
  partner?: string;
}

interface Candidate {
  penIndex: number;
  cell: number;
  priority: number;
  risk: number;
  age: number | null;
  fouling: number;
  finding?: Finding;
}

/** Heavy fouling that can hide damage (P4). The simulated nets carry 40–60 % near the surface between cleanings, so the bar sits higher than the contract's 40 %. */
const HEAVY_FOULING = 0.7;
const SWEEP_STANDOFF_M = 4;

interface Look {
  rule: PlanRule;
  robots: 1 | 2;
  standoffM: number;
  views: number[];
  task: string;
  why: string;
}

/** How to look at an area, following the plan rules. */
function lookFor(c: Candidate, where: string): Look {
  const f = c.finding;
  const p = f ? `p=${f.confidence.toFixed(2)}` : '';
  if (f?.kind === 'hole' && f.confidence >= 0.7) {
    return { rule: 'P1', robots: 2, standoffM: 1.55, views: [-6, 6], task: `Confirming possible opening #${f.id} at ${where}`, why: `Possible opening (${p}) seen once. Two drones confirm it from either side, 1.6 m off the net: one drone alone cannot confirm an opening.` };
  }
  if (f && f.confidence < 0.7) {
    return { rule: 'P2', robots: 1, standoffM: 1.0, views: [0], task: `Closer look at ${f.kind === 'hole' ? 'possible opening' : 'wear'} #${f.id} at ${where}`, why: `Unsure (${p}). Closer, 1.0 m off the net, three photos.` };
  }
  if (f) {
    return { rule: 'P5', robots: 1, standoffM: 1.2, views: [0], task: `Close look at wear #${f.id} at ${where}`, why: `Wear sign (${p}). Closer look with extra margin, the twine may be weak.` };
  }
  if (c.fouling >= HEAVY_FOULING) {
    return { rule: 'P4', robots: 1, standoffM: 1.2, views: [-8, 8], task: `Two-angle look through fouling at ${where}`, why: `Heavy fouling (${Math.round(c.fouling * 100)} %) can hide holes. One drone looks from two angles.` };
  }
  if (c.risk >= 0.5) {
    return { rule: 'P6', robots: 1, standoffM: 1.2, views: [0], task: `Close inspection at ${where}`, why: `Hole risk high (${Math.round(c.risk * 100)}). Close inspection before it can open.` };
  }
  return { rule: 'sweep', robots: 1, standoffM: SWEEP_STANDOFF_M, views: [0], task: `Coverage sweep at ${where}`, why: '' };
}

/** Every area of each pen ranked by priority (highest first). */
function rankedCells(world: World, day: number, unreviewed: Finding[]): Candidate[][] {
  return world.pens.map((pen, penIndex) => {
    const sim = world.sims[penIndex];
    const out: Candidate[] = [];
    for (let cell = 0; cell < CELLS; cell++) {
      // Same gap as in the simulation: only the docked drone could film Pen 8's cone.
      if (pen.id === 8 && day >= CONE_DRONE_DOCKED_DAY && cellRow(cell) >= WALL_ROWS) continue;
      const age = coverageAge(sim, cell, day);
      const risk = riskScore(sim, cell, day);
      const fouling = sim.fouling[day * CELLS + cell];
      const finding = unreviewed.find((f) => f.penId === pen.id && f.cell === cell);
      // Detections waiting for a second look come first, then heavy fouling, then stale and risky areas.
      const priority = ((age ?? 30) + 1) * (0.2 + risk) + (finding ? 5 : 0) + (fouling >= HEAVY_FOULING ? 1.5 : 0);
      out.push({ penIndex, cell, priority, risk, age, fouling, finding });
    }
    return out.sort((a, b) => b.priority - a.priority);
  });
}

const near = (a: number, b: number): boolean => Math.abs(cellRow(a) - cellRow(b)) <= 1 && Math.min(Math.abs(cellCol(a) - cellCol(b)), ANGLE_SECTORS - Math.abs(cellCol(a) - cellCol(b))) <= 2;

/** Drones in service; one more is docked from day 70. */
const FLEET = 20;
const BASE_PER_PEN = 2;

/**
 * @param unreviewed detections nobody has reviewed yet; they get a targeted second look. Confirmed
 * findings are left to the crew.
 */
export function swarmState(world: World, day: number, unreviewed: Finding[]): Drone[] {
  const d = Math.min(day, TODAY);
  const ranked = rankedCells(world, d, unreviewed);
  const docked = d >= CONE_DRONE_DOCKED_DAY;
  const active = docked ? FLEET : FLEET + 1;

  // Every pen gets a base crew; spare drones go to the pens with the most urgent areas.
  const crew = world.pens.map(() => BASE_PER_PEN);
  const byUrgency = ranked.map((r, i) => [i, r[0]?.priority ?? 0] as const).sort((a, b) => b[1] - a[1]);
  for (let spare = active - BASE_PER_PEN * world.pens.length, k = 0; spare > 0; spare--, k++) crew[byUrgency[k % byUrgency.length][0]]++;

  const drones: Drone[] = [];
  let n = 0;
  ranked.forEach((cells, penIndex) => {
    const pen = world.pens[penIndex];
    const taken: number[] = [];
    // Drones still to place in this pen: a P1 target takes two at once.
    let left = crew[penIndex];
    while (left > 0) {
      // The next most urgent area that is not right next to a teammate's.
      const c = cells.find((x) => !taken.some((t) => near(t, x.cell))) ?? cells[crew[penIndex] - left];
      taken.push(c.cell);
      const where = `${pen.name}, ${cellLabel(c.cell)}`;
      const look = lookFor(c, where);
      const team = Math.min(look.robots, left);
      const ids = Array.from({ length: team }, (_, k) => `D${n + k + 1}`);
      for (let k = 0; k < team; k++) {
        const i = n++;
        const id = ids[k];
        const [d0, d1] = rowDepth(cellRow(c.cell));
        const battery = Math.round(38 + hashNoise(i, d, 11) * 58);
        const low = battery < 42 && look.rule === 'sweep';
        const sampling = look.rule === 'sweep' && c.risk < 0.2 && (c.age ?? 0) < 4;
        const partner = team === 2 ? ids[1 - k] : undefined;
        const seen = c.age === null ? 'never seen' : c.age === 0 ? 'last seen earlier today' : `not seen for ${c.age} day${c.age > 1 ? 's' : ''}`;
        const side = look.views.length > 1 ? (team === 2 ? (k === 0 ? ', left side' : ', right side') : ', two angles') : '';
        const task = low
          ? `Returning to the barge to charge after ${where}`
          : sampling
            ? `Survey sweep and oxygen profile in ${pen.name}`
            : `${look.task}${side}`;
        const reason =
          look.rule === 'sweep'
            ? `Coverage: the most urgent free area in ${pen.name}, risk ${Math.round(c.risk * 100)} and ${seen}. Sweeping ${SWEEP_STANDOFF_M} m off the net.`
            : `${look.rule}: ${look.why}${partner ? ` Working with ${partner}.` : ''}`;
        const later = cells.filter((x) => !taken.includes(x.cell)).slice((crew[penIndex] - left) * 2, (crew[penIndex] - left) * 2 + 2);
        drones.push({
          id,
          name: `Drone ${id}`,
          status: low ? 'returning' : sampling ? 'sampling' : 'inspecting',
          penIndex,
          cell: c.cell,
          depth: Math.round((d0 + d1) / 2),
          battery,
          task,
          reason,
          next: [...later.map((x) => `${pen.name}, ${cellLabel(x.cell)}`), 'Return to the barge and charge'],
          lastContactMin: Math.round(hashNoise(i, d, 23) * 6),
          health: hashNoise(i, d, 31) < 0.85 ? 'All systems normal' : 'Thruster 2 drawing slightly more current than usual',
          rule: look.rule,
          standoffM: look.standoffM,
          viewDeg: team === 2 ? look.views[k] : 0,
          partner,
        });
        left--;
      }
    }
  });
  if (docked) {
    const id = `D${FLEET + 1}`;
    drones.push({
      id,
      name: `Drone ${id}`,
      status: 'docked',
      penIndex: null,
      cell: null,
      depth: 0,
      battery: 100,
      task: `Docked for repair since ${dayLabel(CONE_DRONE_DOCKED_DAY)}: cone camera housing leak`,
      reason: 'It is the drone that films the bottom cones. The others cover wall areas, so Pen 8’s cone is going stale.',
      next: ['Back in service after the housing is replaced'],
      lastContactMin: 0,
      health: 'Cone camera out of service',
      rule: 'sweep',
      standoffM: 0,
      viewDeg: 0,
    });
  }
  return drones;
}
