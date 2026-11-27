/**
 * The inspection swarm's state on a given day: which drone works where, and why.
 *
 * Tasks follow the same rule the simulated swarm inspects by: priority = (days since an area was
 * last seen + 1) × (0.2 + its hole risk). Every pen keeps a small crew working inside the net; spare
 * drones go to the pens with the most urgent areas, teammates never take neighbouring areas, and open
 * findings keep a drone on them until they are verified. One drone has been docked for repair since
 * day 70, which is why Pen 8's cone has not been seen (the data-trust case).
 */
import { ANGLE_SECTORS, CELLS, TODAY, WALL_ROWS, cellCol, cellLabel, cellRow, dayLabel, rowDepth, type Finding, type World } from './model';
import { coverageAge, riskScore } from './risk';
import { hashNoise } from './rng';
import { CONE_DRONE_DOCKED_DAY } from './simulate';

export type DroneStatus = 'inspecting' | 'sampling' | 'returning' | 'docked';

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
}


interface Candidate {
  penIndex: number;
  cell: number;
  priority: number;
  risk: number;
  age: number | null;
  finding?: Finding;
}

/** Every area of each pen ranked by priority (highest first). */
function rankedCells(world: World, day: number, openFindings: Finding[]): Candidate[][] {
  return world.pens.map((pen, penIndex) => {
    const sim = world.sims[penIndex];
    const out: Candidate[] = [];
    for (let cell = 0; cell < CELLS; cell++) {
      // Same gap as in the simulation: only the docked drone could film Pen 8's cone.
      if (pen.id === 8 && day >= CONE_DRONE_DOCKED_DAY && cellRow(cell) >= WALL_ROWS) continue;
      const age = coverageAge(sim, cell, day);
      const risk = riskScore(sim, cell, day);
      const finding = openFindings.find((f) => f.penId === pen.id && f.cell === cell);
      out.push({ penIndex, cell, priority: ((age ?? 30) + 1) * (0.2 + risk) + (finding ? 5 : 0), risk, age, finding });
    }
    return out.sort((a, b) => b.priority - a.priority);
  });
}

const near = (a: number, b: number): boolean => Math.abs(cellRow(a) - cellRow(b)) <= 1 && Math.min(Math.abs(cellCol(a) - cellCol(b)), ANGLE_SECTORS - Math.abs(cellCol(a) - cellCol(b))) <= 2;

/** Drones in service; one more is docked from day 70. */
const FLEET = 20;
const BASE_PER_PEN = 2;

export function swarmState(world: World, day: number, openFindings: Finding[]): Drone[] {
  const d = Math.min(day, TODAY);
  const ranked = rankedCells(world, d, openFindings);
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
    for (let j = 0; j < crew[penIndex]; j++) {
      // Each drone takes the next most urgent area that is not right next to a teammate's.
      const c = cells.find((x) => !taken.some((t) => near(t, x.cell))) ?? cells[j];
      taken.push(c.cell);
      const i = n++;
      const id = `D${i + 1}`;
      const [d0, d1] = rowDepth(cellRow(c.cell));
      const battery = Math.round(38 + hashNoise(i, d, 11) * 58);
      const low = battery < 42;
      const sampling = !c.finding && c.risk < 0.2 && (c.age ?? 0) < 4;
      const where = `${pen.name}, ${cellLabel(c.cell)}`;
      const task = low
        ? `Returning to the barge to charge after ${where}`
        : c.finding
          ? `Re-inspecting ${c.finding.kind === 'hole' ? 'hole' : 'wear'} #${c.finding.id} at ${where}`
          : sampling
            ? `Survey sweep and oxygen profile in ${pen.name}`
            : `Close inspection at ${where}`;
      const seen = c.age === null ? 'never seen' : c.age === 0 ? 'last seen earlier today' : `not seen for ${c.age} day${c.age > 1 ? 's' : ''}`;
      const reason = c.finding
        ? 'Open finding here, so the swarm keeps a drone on it until it is repaired and verified.'
        : `Most urgent free area in ${pen.name}: risk ${Math.round(c.risk * 100)} and ${seen}. ${crew[penIndex] - 1} other drone${crew[penIndex] === 2 ? '' : 's'} cover the rest of this pen.`;
      const later = cells.filter((x) => !taken.includes(x.cell)).slice(j * 2, j * 2 + 2);
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
      });
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
    });
  }
  return drones;
}
