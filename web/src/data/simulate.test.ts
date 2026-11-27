import { describe, expect, it } from 'vitest';
import { CELLS, DAYS, STALE_AFTER_DAYS, TODAY, WALL_ROWS, cellIndex, cellRow } from './model';
import { generateWorld } from './simulate';
import { FROZEN_SENSOR, sensorProfile, waterAt } from './water';

const world = generateWorld();

describe('generateWorld', () => {
  it('is deterministic for a given seed', () => {
    const again = generateWorld();
    expect(again.findings.map((f) => [f.id, f.penId, f.cell, f.detectedDay])).toEqual(world.findings.map((f) => [f.id, f.penId, f.cell, f.detectedDay]));
    expect(Array.from(again.sims[3].fray.slice(0, CELLS * 5))).toEqual(Array.from(world.sims[3].fray.slice(0, CELLS * 5)));
  });

  it('keeps wear values in [0, 1] for every pen, day and cell', () => {
    for (const sim of world.sims) {
      for (const arr of [sim.coating, sim.fray, sim.distortion, sim.fouling]) {
        for (const v of arr) expect(v >= 0 && v <= 1).toBe(true);
      }
    }
  });

  it('never inspects in the forecast', () => {
    for (const sim of world.sims) {
      for (let c = 0; c < CELLS; c++) {
        for (let d = TODAY + 1; d < DAYS; d++) expect(sim.lastSeen[d * CELLS + c]).toBe(sim.lastSeen[TODAY * CELLS + c]);
      }
    }
  });

  it('covers every cell within a week, except the cone whose drone is docked', () => {
    world.sims.forEach((sim, i) => {
      for (let c = 0; c < CELLS; c++) {
        const age = TODAY - sim.lastSeen[TODAY * CELLS + c];
        if (world.pens[i].id === 8 && cellRow(c) >= WALL_ROWS) expect(age).toBeGreaterThan(STALE_AFTER_DAYS);
        else expect(age).toBeLessThanOrEqual(7);
      }
    });
  });

  it('catches the Pen 4 chafe as wear, before it becomes a hole', () => {
    const chafe = world.findings.find((f) => f.penId === 4 && f.cell === cellIndex(4, 9) && f.kind === 'chafe');
    expect(chafe).toBeDefined();
    expect(chafe!.steps.map((s) => s.status)).toContain('repaired');
    expect(world.findings.some((f) => f.penId === 4 && f.kind === 'hole')).toBe(false);
  });

  it('finds the sudden predator-bite hole in Pen 2 within one swarm revisit (~4 days)', () => {
    const hole = world.findings.find((f) => f.penId === 2 && f.kind === 'hole');
    expect(hole).toBeDefined();
    expect(hole!.detectedDay - hole!.openedDay!).toBeLessThanOrEqual(4);
  });

  it('never records a lifecycle step in the future, and leaves only recent findings unreviewed', () => {
    for (const f of world.findings) {
      for (const s of f.steps) expect(s.day).toBeLessThanOrEqual(TODAY);
      if (f.detectedDay < TODAY - 1) expect(f.steps.length).toBeGreaterThan(1);
    }
  });
});

describe('water', () => {
  it('has less oxygen at depth than near the surface', () => {
    const top = waterAt(world, 1, cellIndex(0, 0), 40).oxygen;
    const deep = waterAt(world, 1, cellIndex(9, 0), 40).oxygen;
    expect(deep).toBeLessThan(top);
  });

  it('shows the oxygen drop during delousing in Pen 3', () => {
    const before = waterAt(world, 3, cellIndex(3, 5), 68).oxygen;
    const during = waterAt(world, 3, cellIndex(3, 5), 70).oxygen;
    expect(during).toBeLessThan(before - 15);
  });

  it('flags the frozen sensor and repeats its last value', () => {
    const a = sensorProfile(world, FROZEN_SENSOR.penId, TODAY).find((r) => r.depth === FROZEN_SENSOR.depth)!;
    const b = sensorProfile(world, FROZEN_SENSOR.penId, TODAY - 2).find((r) => r.depth === FROZEN_SENSOR.depth)!;
    expect(a.stale).toBe(true);
    expect(a.oxygen).toBe(b.oxygen);
    expect(sensorProfile(world, 1, TODAY).every((r) => !r.stale)).toBe(true);
  });
});

describe('demo cases for today', () => {
  it('has an open hole in Pen 2 with a repair ordered but not done', () => {
    const hole = world.findings.find((f) => f.penId === 2 && f.kind === 'hole');
    expect(hole).toBeDefined();
    const statuses = hole!.steps.map((s) => s.status);
    expect(statuses).toContain('work-order');
    expect(statuses).not.toContain('repaired');
  });
});

describe('water inside the pen', () => {
  it('has less oxygen where the water leaves the pen than where it enters', async () => {
    const { waterAtPoint } = await import('./water');
    const dir = (world.env.currentDir[TODAY] * Math.PI) / 180;
    const enter = waterAtPoint(world, 1, 10, -Math.sin(dir), -Math.cos(dir), TODAY).oxygen;
    const leave = waterAtPoint(world, 1, 10, Math.sin(dir), Math.cos(dir), TODAY).oxygen;
    expect(leave).toBeLessThan(enter);
  });
});
