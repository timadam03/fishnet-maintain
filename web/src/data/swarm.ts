/**
 * The inspection swarm's state on a given day: which drone works where, and why.
 *
 * Tasks follow the same rule the simulated swarm inspects by: priority = (days since an area was
 * last seen + 1) × (0.2 + its hole risk). Each pen gets at most one drone, so the swarm spreads out;
 * open findings pull a drone back for re-inspection. One drone has been docked for repair since
 * day 70, which is why Pen 8's cone has not been seen (the data-trust case).
 */
import { CELLS, TODAY, WALL_ROWS, cellLabel, cellRow, dayLabel, rowDepth, type Finding, type World } from './model';
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

const NAMES = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];

interface Candidate {
  penIndex: number;
  cell: number;
  priority: number;
  risk: number;
  age: number | null;
  finding?: Finding;
}

function bestCellPerPen(world: World, day: number, openFindings: Finding[]): Candidate[] {
  return world.pens.map((pen, penIndex) => {
    const sim = world.sims[penIndex];
    let best: Candidate = { penIndex, cell: 0, priority: -1, risk: 0, age: 0 };
    for (let cell = 0; cell < CELLS; cell++) {
      // Same gap as in the simulation: only the docked drone could film Pen 8's cone.
      if (pen.id === 8 && day >= CONE_DRONE_DOCKED_DAY && cellRow(cell) >= WALL_ROWS) continue;
      const age = coverageAge(sim, cell, day);
      const risk = riskScore(sim, cell, day);
      const finding = openFindings.find((f) => f.penId === pen.id && f.cell === cell);
      const priority = ((age ?? 30) + 1) * (0.2 + risk) + (finding ? 5 : 0);
      if (priority > best.priority) best = { penIndex, cell, priority, risk, age, finding };
    }
    return best;
  });
}

export function swarmState(world: World, day: number, openFindings: Finding[]): Drone[] {
  const d = Math.min(day, TODAY);
  const candidates = bestCellPerPen(world, d, openFindings).sort((a, b) => b.priority - a.priority);
  const drones: Drone[] = [];
  const active = d >= CONE_DRONE_DOCKED_DAY ? 6 : 7;

  for (let i = 0; i < active; i++) {
    const c = candidates[i];
    const pen = world.pens[c.penIndex];
    const [d0, d1] = rowDepth(cellRow(c.cell));
    const battery = Math.round(38 + hashNoise(i, d, 11) * 58);
    const low = battery < 45;
    const sampling = !c.finding && c.risk < 0.2 && (c.age ?? 0) < 4;
    const where = `${pen.name}, ${cellLabel(c.cell)}`;
    const task = low
      ? `Returning to the barge to charge after ${where}`
      : c.finding
        ? `Re-inspecting ${c.finding.kind === 'hole' ? 'hole' : 'wear'} #${c.finding.id} at ${where}`
        : sampling
          ? `Survey sweep and oxygen profile in ${pen.name}`
          : `Close inspection at ${where}`;
    const reason = c.finding
      ? `Open finding here, so the swarm keeps a drone on it until it is repaired and verified.`
      : `Highest priority in ${pen.name}: risk ${Math.round(c.risk * 100)} and ${c.age === null ? 'never seen' : c.age === 0 ? 'last seen earlier today' : `not seen for ${c.age} day${c.age > 1 ? 's' : ''}`}. No other drone is assigned to this pen.`;
    const nextCandidates = candidates.slice(active).map((n) => `${world.pens[n.penIndex].name}, ${cellLabel(n.cell)}`);
    drones.push({
      id: NAMES[i],
      name: `Drone ${NAMES[i]}`,
      status: low ? 'returning' : sampling ? 'sampling' : 'inspecting',
      penIndex: c.penIndex,
      cell: c.cell,
      depth: Math.round((d0 + d1) / 2),
      battery,
      task,
      reason,
      next: [nextCandidates[i % Math.max(1, nextCandidates.length)] ?? 'Survey sweep', 'Return to barge and charge'].filter(Boolean),
      lastContactMin: Math.round(hashNoise(i, d, 23) * 6),
      health: hashNoise(i, d, 31) < 0.85 ? 'All systems normal' : 'Thruster 2 drawing slightly more current than usual',
    });
  }
  if (active === 6) {
    drones.push({
      id: 'D7',
      name: 'Drone D7',
      status: 'docked',
      penIndex: null,
      cell: null,
      depth: 0,
      battery: 100,
      task: `Docked for repair since ${dayLabel(CONE_DRONE_DOCKED_DAY)}: cone camera housing leak`,
      reason: 'It covered the bottom cones. The other drones take wall areas first, so Pen 8’s cone is going stale.',
      next: ['Back in service after the housing is replaced'],
      lastContactMin: 0,
      health: 'Cone camera out of service',
    });
  }
  return drones;
}
