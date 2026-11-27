import { describe, expect, it } from 'vitest';
import { TODAY, WALL_ROWS, cellRow } from './model';
import { generateWorld } from './simulate';
import { swarmState } from './swarm';

const world = generateWorld();
const open = world.findings.filter((f) => f.detectedDay <= TODAY && !f.steps.some((s) => s.status === 'verified' || s.status === 'rejected'));
const drones = swarmState(world, TODAY, open);

describe('swarmState', () => {
  it('spreads drones out: at most one per pen', () => {
    const pens = drones.filter((d) => d.penIndex !== null).map((d) => d.penIndex);
    expect(new Set(pens).size).toBe(pens.length);
  });

  it('keeps D7 docked and never sends anyone to Pen 8’s cone while it is', () => {
    expect(drones.find((d) => d.id === 'D7')?.status).toBe('docked');
    const pen8 = drones.find((d) => d.penIndex === 7);
    if (pen8?.cell !== undefined && pen8.cell !== null) expect(cellRow(pen8.cell)).toBeLessThan(WALL_ROWS);
  });

  it('keeps a drone on the open hole in Pen 2', () => {
    const hole = open.find((f) => f.penId === 2 && f.kind === 'hole')!;
    expect(drones.some((d) => d.penIndex === 1 && d.cell === hole.cell)).toBe(true);
  });
});
