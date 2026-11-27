import { describe, expect, it } from 'vitest';
import { generateWorld } from '../data/simulate';
import { heightAt } from './terrain';

const world = generateWorld();

describe('terrain', () => {
  it('leaves enough water under every pen (net 30 m plus weight)', () => {
    // Same placement as the 3D site: pen positions centred on the farm.
    for (const p of world.pens) expect(-heightAt(p.x - 450, p.y - 212)).toBeGreaterThan(36);
  });

  it('has land to the north and is continuous across the shore', () => {
    expect(heightAt(0, -600)).toBeGreaterThan(20);
    for (let z = -400; z < -100; z += 1) expect(Math.abs(heightAt(0, z + 1) - heightAt(0, z))).toBeLessThan(1.5);
  });
});
