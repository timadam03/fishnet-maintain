import { describe, expect, it } from 'vitest';
import { CELLS, DAYS, TODAY, WALL_ROWS, cellIndex } from './model';
import { explainRisk, riskLevel, riskScore } from './risk';
import { generateWorld } from './simulate';

const world = generateWorld();

describe('risk model', () => {
  it('maps scores to levels at the documented thresholds', () => {
    expect(riskLevel(0.1)).toBe('low');
    expect(riskLevel(0.25)).toBe('elevated');
    expect(riskLevel(0.5)).toBe('high');
    expect(riskLevel(0.7)).toBe('critical');
  });

  it('agrees between the fast path and the explanation', () => {
    for (const sim of world.sims) {
      for (let c = 0; c < CELLS; c += 7) {
        for (const d of [0, 40, TODAY, DAYS - 1]) expect(explainRisk(sim, c, d).score).toBeCloseTo(riskScore(sim, c, d), 6);
      }
    }
  });

  it('keeps every score in [0, 1] with a range that contains it', () => {
    for (const sim of world.sims) {
      for (let c = 0; c < CELLS; c++) {
        const r = explainRisk(sim, c, TODAY);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(r.range[0]).toBeLessThanOrEqual(r.score);
        expect(r.range[1]).toBeGreaterThanOrEqual(r.score);
      }
    }
  });

  it('rates the Pen 4 chafe high on the day it was found, and blames weight contact', () => {
    const chafe = world.findings.find((f) => f.penId === 4 && f.cell === cellIndex(4, 9) && f.kind === 'chafe')!;
    const r = explainRisk(world.sims[3], chafe.cell, chafe.detectedDay);
    expect(r.score).toBeGreaterThanOrEqual(0.5);
    const top = r.factors.filter((f) => f.group === 'exposure').sort((a, b) => b.weight - a.weight)[0];
    expect(top.label).toMatch(/Contact with weights/);
    expect(r.recommendation).toMatch(/weight/i);
  });

  it('marks the unwatched Pen 8 cone as stale and asks for more sampling', () => {
    const r = explainRisk(world.sims[7], cellIndex(WALL_ROWS, 3), TODAY);
    expect(r.stale).toBe(true);
    expect(r.range[1] - r.range[0]).toBeGreaterThan(0.2);
    // Even at a low score, stale data must never read as "no action".
    expect(r.score).toBeLessThan(0.15);
    expect(r.recommendation).toMatch(/^Sample more/);
  });

  it('widens uncertainty further into the forecast', () => {
    const sim = world.sims[6];
    const c = cellIndex(7, 20);
    const width = (d: number): number => {
      const r = explainRisk(sim, c, d).range;
      return r[1] - r[0];
    };
    expect(width(TODAY + 5)).toBeGreaterThan(width(TODAY + 1));
  });
});
