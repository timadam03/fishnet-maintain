import { describe, expect, it } from 'vitest';
import { ANGLE_SECTORS } from './model';
import { sampleTelemetry, simCell, simToPen, type RunTelemetry } from './runs';

/** The packing script's own tests are in scripts/pack-run.test.mjs. */
describe('placing the sim pen on the dashboard pen', () => {
  const cage = { radius_m: 8, depth_m: 8 };

  it('picks the same cell as the sim ui_cell (depth as a fraction of the cage, 15° sectors)', () => {
    expect(simCell(97.5, -1.5, cage)).toBe(30); // row 1, col 6: the first photo of contracts/example-run
    expect(simCell(0, 0, cage)).toBe(0);
    expect(simCell(359.9, -7.99, cage)).toBe(7 * ANGLE_SECTORS + 23);
    expect(simCell(-15, -8.5, cage)).toBe(7 * ANGLE_SECTORS + 23); // angles wrap, depth clamps to the last wall row
  });

  it('places a sim position in the column of its angle, scaled to the dashboard pen', () => {
    // From contracts/example-run: a photo at 97.5°, 1.5 m down, 6 m from the axis.
    const p = simToPen([-0.783, 5.949, -1.5], cage);
    expect(Math.floor(p.deg / (360 / ANGLE_SECTORS))).toBe(6);
    expect(p.depth).toBeCloseTo((1.5 / 8) * 20, 5);
    expect(p.radius).toBeCloseTo((Math.hypot(-0.783, 5.949) / 8) * 25, 5);
  });

  it('interpolates telemetry between samples and turns the short way round', () => {
    const tel: RunTelemetry = {
      hz: 1,
      t: [0, 1],
      rov: [{ pos: [[0, 0, -1], [2, 4, -3]], yaw: [3, -3], filter: [0, 1], clr: [1, 2], contacts: [0, 0], shots: [0, 1] }],
      shots: [],
    };
    const [mid] = sampleTelemetry(tel, 0.5);
    expect(mid.pos).toEqual([1, 2, -2]);
    expect(Math.abs(mid.yaw)).toBeGreaterThan(3); // through ±π, not through 0
    expect(sampleTelemetry(tel, 5)[0].pos).toEqual([2, 4, -3]);
  });
});
