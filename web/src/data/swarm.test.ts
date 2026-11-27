import { describe, expect, it } from 'vitest';
import { TODAY, WALL_ROWS, cellRow } from './model';
import { generateWorld } from './simulate';
import { swarmState } from './swarm';

const world = generateWorld();
const open = world.findings.filter((f) => f.detectedDay <= TODAY && !f.steps.some((s) => s.status === 'verified' || s.status === 'rejected'));
const drones = swarmState(world, TODAY, open);

describe('swarmState', () => {
  it('gives every pen a crew and never puts two drones on the same area', () => {
    const working = drones.filter((d) => d.penIndex !== null);
    expect(new Set(working.map((d) => d.penIndex)).size).toBe(world.pens.length);
    const areas = working.map((d) => `${d.penIndex}/${d.cell}`);
    expect(new Set(areas).size).toBe(areas.length);
    expect(working.length).toBeGreaterThan(world.pens.length);
  });

  it('keeps one drone docked and never sends anyone to Pen 8’s cone while it is', () => {
    expect(drones.filter((d) => d.status === 'docked')).toHaveLength(1);
    for (const d of drones.filter((x) => x.penIndex === 7)) expect(cellRow(d.cell!)).toBeLessThan(WALL_ROWS);
  });

  it('keeps a drone on the open hole in Pen 2', () => {
    const hole = open.find((f) => f.penId === 2 && f.kind === 'hole')!;
    expect(drones.some((d) => d.penIndex === 1 && d.cell === hole.cell)).toBe(true);
  });
});
