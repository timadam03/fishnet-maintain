/**
 * The decision layer reads the operator UI's simulated world (web/src/data) as its single source of
 * truth for nets, sensors, findings and risk scores. It never changes those files; it only adds
 * decisions, memory and learning on top.
 */
import { CELLS, type PenSim } from '../../web/src/data/model';
import { generateWorld } from '../../web/src/data/simulate';

export { explainRisk, type CellRisk } from '../../web/src/data/risk';
export { sensorProfile, waterAt } from '../../web/src/data/water';
export {
  ANGLE_SECTORS,
  CELLS,
  TODAY,
  cellCol,
  cellLabel,
  cellRow,
  dayLabel,
  rowDepth,
  type Finding,
  type World,
} from '../../web/src/data/model';

/** Same seed as the UI, so both show the same site. */
export const world = generateWorld();

export function penSim(penId: number): PenSim {
  const index = world.pens.findIndex((p) => p.id === penId);
  if (index < 0) throw new Error(`unknown pen ${penId}`);
  return world.sims[index];
}

/** Cells a drone inspected on `day`; their oxygen readings count as drone measurements. */
export function cellsSeenOn(penId: number, day: number): number[] {
  const sim = penSim(penId);
  const seen: number[] = [];
  for (let cell = 0; cell < CELLS; cell++) {
    if (sim.lastSeen[day * CELLS + cell] === day) seen.push(cell);
  }
  return seen;
}
