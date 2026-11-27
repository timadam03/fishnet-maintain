import { describe, expect, it } from 'vitest';
import { TODAY, WALL_ROWS, cellRow } from './model';
import { generateWorld } from './simulate';
import { swarmState } from './swarm';

const world = generateWorld();
const statusToday = (f: (typeof world.findings)[number]): string => f.steps.filter((s) => s.day <= TODAY).at(-1)!.status;
const unreviewed = world.findings.filter((f) => f.detectedDay <= TODAY && statusToday(f) === 'unreviewed');
const drones = swarmState(world, TODAY, unreviewed);

describe('swarmState', () => {
  it('gives every pen a crew and only shares an area for a two-drone confirmation (P1)', () => {
    const working = drones.filter((d) => d.penIndex !== null);
    expect(new Set(working.map((d) => d.penIndex)).size).toBe(world.pens.length);
    expect(working.length).toBeGreaterThan(world.pens.length);
    const byArea = new Map<string, typeof working>();
    for (const d of working) byArea.set(`${d.penIndex}/${d.cell}`, [...(byArea.get(`${d.penIndex}/${d.cell}`) ?? []), d]);
    for (const team of byArea.values()) if (team.length > 1) expect(team.map((d) => d.rule)).toEqual(['P1', 'P1']);
  });

  it('sends two drones, one each side, to confirm the likely opening in Pen 6', () => {
    const opening = unreviewed.find((f) => f.penId === 6 && f.kind === 'hole')!;
    expect(opening.confidence).toBeGreaterThanOrEqual(0.7);
    const team = drones.filter((d) => d.penIndex === 5 && d.cell === opening.cell);
    expect(team.map((d) => d.rule)).toEqual(['P1', 'P1']);
    expect(team[0].viewDeg).toBe(-team[1].viewDeg);
    expect(team[0].partner).toBe(team[1].id);
  });

  it('takes a closer look at the unsure opening in Pen 5 (P2)', () => {
    const opening = unreviewed.find((f) => f.penId === 5 && f.kind === 'hole')!;
    const d = drones.find((x) => x.penIndex === 4 && x.cell === opening.cell);
    expect(d?.rule).toBe('P2');
    expect(d!.standoffM).toBeLessThan(2);
  });

  it('keeps one drone docked and never sends anyone to Pen 8’s cone while it is', () => {
    expect(drones.filter((d) => d.status === 'docked')).toHaveLength(1);
    for (const d of drones.filter((x) => x.penIndex === 7)) expect(cellRow(d.cell!)).toBeLessThan(WALL_ROWS);
  });

  it('leaves the confirmed hole in Pen 2 to the repair crew', () => {
    const hole = world.findings.find((f) => f.penId === 2 && f.kind === 'hole' && f.detectedDay <= TODAY)!;
    expect(statusToday(hole)).toBe('work-order');
    expect(drones.some((d) => d.penIndex === 1 && d.cell === hole.cell)).toBe(false);
  });
});
