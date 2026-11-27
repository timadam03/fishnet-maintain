/**
 * Raster layers for the "heat field" site version, drawn in site-map coordinates so they can sit
 * inside the SVG and zoom with it: a bathymetric background (depth bands and contour lines, as on a
 * sea chart) and a continuous risk field spreading from each pen's risky sides.
 */
import { ANGLE_SECTORS, SECTOR_DEG } from '../data/model';
import { riskColor } from './layers';
import { color } from './tokens';

export interface FieldImage {
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function parse(c: string): [number, number, number] {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0'];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/** Water depth (m) at a map point: shallow under the shore at the top, deeper towards the open fjord. */
export function depthAt(x: number, y: number): number {
  const shore = 60 + 50 * Math.sin(x / 210) + 30 * Math.cos(x / 97);
  return Math.max(0, (y - shore) * 0.16 + 6 * Math.sin(x / 140 + y / 170) + 4 * Math.cos(y / 75 - x / 260));
}

/** Depth bands every 10 m from light to slightly darker sea, with thin smooth contour lines between bands. */
export function bathymetryImage(): FieldImage {
  const box = { x: -600, y: -300, width: 2200, height: 1300 };
  const scale = 0.6; // pixels per map unit
  const w = Math.round(box.width * scale);
  const h = Math.round(box.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { href: '', ...box };
  const img = ctx.createImageData(w, h);
  const shallow = parse(color.sea);
  const deep = parse(color.seaDeep);
  const line = parse(color.coast);
  const step = 10;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = box.x + px / scale;
      const y = box.y + py / scale;
      const d = depthAt(x, y);
      // Distance to the nearest contour, in pixels, from the local slope: gives even, anti-aliased lines.
      const gx = (depthAt(x + 1, y) - d) / scale;
      const gy = (depthAt(x, y + 1) - d) / scale;
      const slope = Math.hypot(gx, gy) || 1e-6;
      const f = d / step - Math.floor(d / step);
      const px2line = (Math.min(f, 1 - f) * step) / slope;
      const ink = Math.max(0, 1 - px2line / 0.9) * 0.4;
      const t = Math.min(1, Math.floor(d / step) / 7);
      const at = (py * w + px) * 4;
      for (let k = 0; k < 3; k++) {
        const base = shallow[k] + (deep[k] - shallow[k]) * t;
        img.data[at + k] = base + (line[k] - base) * ink;
      }
      img.data[at + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { href: canvas.toDataURL(), ...box };
}

export interface PenHeat {
  cx: number;
  cy: number;
  radius: number;
  sectorRisk: Float32Array;
}

/**
 * Risk spreading from each pen's sides into the surrounding water: a sum of soft kernels placed at
 * every side of the net, weighted by that side's worst risk, then banded and faded out where calm.
 */
export function riskFieldImage(pens: PenHeat[], box: { x: number; y: number; width: number; height: number }): FieldImage {
  const scale = 0.5;
  const w = Math.round(box.width * scale);
  const h = Math.round(box.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { href: '', ...box };
  const field = new Float32Array(w * h);
  const sigma = 30;
  const reach = sigma * 3;
  for (const pen of pens) {
    for (let k = 0; k < ANGLE_SECTORS; k++) {
      const v = pen.sectorRisk[k];
      if (v < 0.2) continue;
      const a = ((k + 0.5) * SECTOR_DEG * Math.PI) / 180;
      const sx = pen.cx + pen.radius * Math.sin(a);
      const sy = pen.cy - pen.radius * Math.cos(a);
      const x0 = Math.max(0, Math.floor((sx - reach - box.x) * scale));
      const x1 = Math.min(w - 1, Math.ceil((sx + reach - box.x) * scale));
      const y0 = Math.max(0, Math.floor((sy - reach - box.y) * scale));
      const y1 = Math.min(h - 1, Math.ceil((sy + reach - box.y) * scale));
      for (let py = y0; py <= y1; py++) {
        const dy = box.y + py / scale - sy;
        for (let px = x0; px <= x1; px++) {
          const dx = box.x + px / scale - sx;
          // A flatter-topped kernel spreads a risky side into a plume rather than a dot.
          const kernel = Math.exp(-Math.pow((dx * dx + dy * dy) / (2 * sigma * sigma), 0.75));
          const i = py * w + px;
          // Max, not sum: the colour never shows more risk than the riskiest nearby side actually has.
          field[i] = Math.max(field[i], v * kernel);
        }
      }
    }
  }
  const img = ctx.createImageData(w, h);
  const bands = 12;
  for (let i = 0; i < field.length; i++) {
    const v = Math.min(1, field[i]);
    if (v < 0.18) continue;
    const banded = Math.round(v * bands) / bands;
    const [r, g, b] = parse(riskColor(Math.max(banded, 0.12)));
    const at = i * 4;
    img.data[at] = r;
    img.data[at + 1] = g;
    img.data[at + 2] = b;
    img.data[at + 3] = Math.round(255 * Math.min(0.9, (banded - 0.1) * 1.6));
  }
  ctx.putImageData(img, 0, 0);
  return { href: canvas.toDataURL(), ...box };
}
