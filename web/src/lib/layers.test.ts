import { describe, expect, it } from 'vitest';
import { generateWorld } from '../data/simulate';
import { TODAY } from '../data/model';
import { computeLayerGrid, fitLayer, layerById } from './layers';
import { fromHash, toHash } from './state';

const world = generateWorld();

describe('fitLayer', () => {
  it('fits the temperature scale around the day’s values with at least the minimum span', () => {
    const grid = computeLayerGrid(world, 2, TODAY, 'temperature');
    const fitted = fitLayer(layerById('temperature'), grid.values);
    expect(fitted.max - fitted.min).toBeGreaterThanOrEqual(1);
    for (const v of grid.values) {
      expect(v).toBeGreaterThanOrEqual(fitted.min);
      expect(v).toBeLessThanOrEqual(fitted.max);
    }
  });

  it('leaves fixed-scale layers alone', () => {
    const risk = layerById('risk');
    expect(fitLayer(risk, new Float32Array([0.1, 0.9]))).toBe(risk);
  });
});

describe('URL state', () => {
  it('round-trips a view through the hash', () => {
    const view = { penIndex: 3, cell: 105, findingId: 203, day: 51, layer: 'oxygen' as const };
    expect(fromHash(toHash(view), 8)).toEqual(view);
  });

  it('falls back to the default view on bad input', () => {
    expect(fromHash('#pen=99&day=-4&layer=nope', 8)).toEqual({ penIndex: null, cell: null, findingId: null, day: TODAY, layer: 'risk' });
  });
});

describe('replay', () => {
  it('starts from the beginning of history when started at now, and stops when it reaches now', async () => {
    const { reducer, initialState } = await import('./state');
    const started = reducer(initialState, { type: 'play', playing: true });
    expect(started.day).toBe(0);
    expect(started.playing).toBe(true);
    const atNow = reducer({ ...started, day: TODAY - 1 }, { type: 'day', day: TODAY });
    expect(atNow.playing).toBe(false);
  });
});

describe('heat sampling', () => {
  it('stays within the layer scale and wraps around 0°/360° without a seam', async () => {
    const { colorField, sampleValue } = await import('./heat');
    const grid = computeLayerGrid(world, 1, TODAY, 'risk');
    const field = colorField(grid, layerById('risk'));
    for (let r = 0; r <= 11; r += 0.37) for (let c = 0; c <= 24; c += 0.53) {
      const v = sampleValue(field, r, c);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(sampleValue(field, 3, 0)).toBeCloseTo(sampleValue(field, 3, 24), 6);
  });
});
