/**
 * Surroundings of the 3D site: a fjord shore to the north, a headland to the west, a small island to
 * the east, and a seabed that deepens towards the open fjord. One height function drives both the
 * terrain mesh and its chart-like texture (depth bands, contour lines, coastline, soundings).
 * Illustrative only; not real bathymetry.
 */
import type { Environment } from './environment';
import { color } from './tokens';

export const TERRAIN = { width: 6400, depth: 5200 };

const bump = (x: number, z: number, cx: number, cz: number, r: number, h: number): number => h * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * r * r));

/** Height in metres at (x, z): positive is land, negative is water depth. Farm centre is (0, 0). */
export function heightAt(x: number, z: number): number {
  const shoreZ = -280 + 45 * Math.sin(x / 230) + 25 * Math.cos(x / 97);
  const north = shoreZ - z; // > 0 on the land side of the shore line
  // Continuous across the shore line: land rises gently into mountains behind the farm; the seabed
  // shelves off and then deepens towards the middle of the fjord.
  const ridges = 18 * Math.sin(x / 83) * Math.cos(z / 67) + 60 * Math.sin(x / 410 + 1.3) * Math.cos(z / 330) + 25 * Math.sin(x / 170 - z / 230);
  let h =
    north > 0
      ? Math.min(420, north * 0.38 + north * north * 0.00035) + ridges * Math.min(1, north / 180)
      : -Math.min(78, -north * 0.32 * Math.exp(north / 90) + -north * 0.19 + 5 * Math.sin(x / 160 + z / 190) * Math.min(1, -north / 60));
  // The far shore across the fjord, to the south.
  const south = z - (1350 + 120 * Math.sin(x / 520) + 60 * Math.cos(x / 230));
  if (south > -300) h = Math.max(h, -78 + (south + 300) * 0.26 + Math.max(0, south) * Math.max(0, south) * 0.0004 + ridges * Math.min(1, Math.max(0, south) / 200));
  h += bump(x, z, 340, 250, 60, 112); // island
  h += bump(x, z, -470, -170, 110, 70); // headland
  return h;
}

function parse(c: string): [number, number, number] {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0'];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/**
 * Paints the terrain: water deepening from light to darker teal, a sandy shore, conifer slopes rising
 * to grey rock, soft hill shading, thin contour lines and a crisp coastline.
 */
export function paintTerrain(canvas: HTMLCanvasElement, env: Environment): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const sx = TERRAIN.width / w;
  const sz = TERRAIN.depth / h;
  const shallow = parse(env.shallow);
  const deep = parse(env.deep);
  const sand = parse(env.sand);
  const forest = parse(env.forest);
  const meadow = parse(env.meadow);
  const snow = parse(env.snow);
  const rock = parse(env.rock);
  const ink = parse(env.contour);
  const mix = (a: number[], b: number[], t: number): number[] => a.map((c, k) => c + (b[k] - c) * Math.max(0, Math.min(1, t)));
  // Light from the north-west, as on printed relief maps.
  const light = [-0.55, 0.7, -0.45];
  const img = ctx.createImageData(w, h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = -TERRAIN.width / 2 + px * sx;
      const z = -TERRAIN.depth / 2 + py * sz;
      const v = heightAt(x, z);
      const dx = (heightAt(x + sx, z) - v) / sx;
      const dz = (heightAt(x, z + sz) - v) / sz;
      const slope = Math.hypot(dx * sx, dz * sz) || 1e-6; // metres per pixel
      let base: number[];
      if (v >= 0) {
        // Shore sand, meadow, conifer forest, then bare rock and snow on the peaks.
        base =
          v < 2 ? sand : v < 25 ? mix(sand, meadow, v / 6) : v < 160 ? mix(meadow, forest, (v - 25) / 40) : v < 300 ? mix(forest, rock, (v - 160) / 60) : mix(rock, snow, (v - 300) / 50);
        const n = [-dx, 1, -dz];
        const len = Math.hypot(n[0], n[1], n[2]);
        const shade = (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / len;
        base = base.map((c) => c * (0.72 + 0.4 * shade));
      } else {
        base = mix(shallow, deep, Math.pow(Math.min(1, -v / 70), 0.8));
      }
      const step = v >= 0 ? 50 : 10;
      const f = v / step - Math.floor(v / step);
      const toContour = (Math.min(f, 1 - f) * step) / slope;
      const contour = Math.max(0, 1 - toContour / 0.8) * (v >= 0 ? 0.12 : 0.22);
      const shoreline = Math.max(0, 1 - Math.abs(v) / slope / 1.2) * 0.55;
      const a = Math.max(contour, shoreline);
      const at = (py * w + px) * 4;
      for (let k = 0; k < 3; k++) img.data[at + k] = base[k] + (ink[k] - base[k]) * a;
      img.data[at + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Soundings: depth figures scattered over the water, as on a chart.
  ctx.fillStyle = color.ink3;
  ctx.font = `italic ${Math.round(w / 280)}px 'IBM Plex Sans', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  for (let i = 0; i < 26; i++) {
    const x = -1050 + ((i * 397) % 2100);
    const z = -150 + ((i * 271) % 1000);
    const v = heightAt(x, z);
    if (v > -12 || (Math.abs(x) < 300 && Math.abs(z) < 130)) continue; // skip land, shallows and the farm
    ctx.fillText(String(Math.round(-v)), ((x + TERRAIN.width / 2) / TERRAIN.width) * w, ((z + TERRAIN.depth / 2) / TERRAIN.depth) * h);
  }
}
