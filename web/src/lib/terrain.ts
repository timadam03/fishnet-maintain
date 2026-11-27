/**
 * Surroundings of the 3D site: a fjord shore to the north, a headland to the west, a small island to
 * the east, and a seabed that deepens towards the open fjord. One height function drives both the
 * terrain mesh and its chart-like texture (depth bands, contour lines, coastline, soundings).
 * Illustrative only; not real bathymetry.
 */
import { color } from './tokens';

export const TERRAIN = { width: 2400, depth: 1800 };

const bump = (x: number, z: number, cx: number, cz: number, r: number, h: number): number => h * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * r * r));

/** Height in metres at (x, z): positive is land, negative is water depth. Farm centre is (0, 0). */
export function heightAt(x: number, z: number): number {
  const shoreZ = -280 + 45 * Math.sin(x / 230) + 25 * Math.cos(x / 97);
  const north = shoreZ - z; // > 0 on the land side of the shore line
  // Continuous across the shore line: land rises gently, the seabed shelves off and then deepens.
  const ripple = 4 * Math.sin(x / 83) * Math.cos(z / 67);
  let h =
    north > 0
      ? Math.min(90, north * 0.4) + ripple * Math.min(1, north / 40)
      : -Math.min(78, -north * 0.32 * Math.exp(north / 90) + -north * 0.19 + 5 * Math.sin(x / 160 + z / 190) * Math.min(1, -north / 60));
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

/** Paints the terrain like a sea chart: tinted depth and height bands with thin contours and soundings. */
export function paintTerrain(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const sx = TERRAIN.width / w;
  const sz = TERRAIN.depth / h;
  const sea = parse(color.sea);
  const deep = parse(color.seaDeep);
  const land = parse(color.land);
  const high = parse(color.paper);
  const ink = parse(color.coast);
  const img = ctx.createImageData(w, h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = -TERRAIN.width / 2 + px * sx;
      const z = -TERRAIN.depth / 2 + py * sz;
      const v = heightAt(x, z);
      const slope = Math.hypot(heightAt(x + sx, z) - v, heightAt(x, z + sz) - v) || 1e-6; // metres per pixel
      const step = v >= 0 ? 15 : 10;
      const f = v / step - Math.floor(v / step);
      const toContour = (Math.min(f, 1 - f) * step) / slope; // pixels to the nearest contour
      const coast = Math.abs(v) / slope;
      let base: number[];
      if (v >= 0) {
        const t = Math.min(1, Math.floor(v / step) / 6);
        base = land.map((c, k) => c + (high[k] - c) * t * 0.6);
      } else {
        const t = Math.min(1, Math.floor(-v / step) / 7);
        base = sea.map((c, k) => c + (deep[k] - c) * t);
      }
      const contour = Math.max(0, 1 - toContour / 0.9) * (v >= 0 ? 0.25 : 0.32);
      const shoreline = Math.max(0, 1 - coast / 1.2) * 0.8;
      const a = Math.max(contour, shoreline);
      const at = (py * w + px) * 4;
      for (let k = 0; k < 3; k++) img.data[at + k] = base[k] + (ink[k] - base[k]) * a;
      img.data[at + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Soundings: depth figures scattered over the water, as on a chart.
  ctx.fillStyle = color.ink3;
  ctx.font = `italic ${Math.round(w / 110)}px 'IBM Plex Sans', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  for (let i = 0; i < 26; i++) {
    const x = -1050 + ((i * 397) % 2100);
    const z = -150 + ((i * 271) % 1000);
    const v = heightAt(x, z);
    if (v > -12 || (Math.abs(x) < 300 && Math.abs(z) < 130)) continue; // skip land, shallows and the farm
    ctx.fillText(String(Math.round(-v)), ((x + TERRAIN.width / 2) / TERRAIN.width) * w, ((z + TERRAIN.depth / 2) / TERRAIN.depth) * h);
  }
}
