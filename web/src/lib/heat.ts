/**
 * Smooth heatmap painting for the net. Cell values are interpolated bicubically between cell centres
 * (wrapping around the pen), then coloured in bands, so the net reads as a continuous surface with soft
 * contours instead of a grid of boxes. Used for the unrolled net map and as the 3D model's texture.
 */
import { ANGLE_SECTORS, CELLS, ROWS, cellCol, cellRow, type Finding } from '../data/model';
import { cellColor, type LayerDef, type LayerGrid } from './layers';
import { color } from './tokens';

/** Number of colour bands; values are smoothed first, then banded, which draws soft contour lines. */
const BANDS = 16;

export interface ColorField {
  /** Layer value per cell, normalised to 0..1 over the layer's scale (unknown cells sit at 0). */
  t: Float32Array;
  /** Banded colour lookup: 256 entries of r, g, b. */
  lut: Uint8ClampedArray;
}

function parseColor(c: string): [number, number, number] {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/\d+(\.\d+)?/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
}

export function colorField(grid: LayerGrid, layer: LayerDef): ColorField {
  const t = new Float32Array(CELLS);
  const span = layer.max - layer.min || 1;
  for (let c = 0; c < CELLS; c++) {
    const v = grid.values[c];
    t[c] = Number.isNaN(v) ? 0 : Math.max(0, Math.min(1, (v - layer.min) / span));
  }
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const banded = Math.min(BANDS - 1, Math.floor((i / 255) * BANDS)) / (BANDS - 1);
    const [r, g, b] = parseColor(cellColor(layer, layer.min + banded * span));
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return { t, lut };
}

/** Catmull-Rom weights for the 4 neighbours of a sample at fraction f. */
function cubicWeights(f: number, w: Float32Array): void {
  const f2 = f * f;
  const f3 = f2 * f;
  w[0] = -0.5 * f3 + f2 - 0.5 * f;
  w[1] = 1.5 * f3 - 2.5 * f2 + 1;
  w[2] = -1.5 * f3 + 2 * f2 + 0.5 * f;
  w[3] = 0.5 * f3 - 0.5 * f2;
}

const wr = new Float32Array(4);
const wc = new Float32Array(4);

/** Smoothed (bicubic) value at a fractional position in cell units; columns wrap, rows clamp. */
export function sampleValue(field: ColorField, row: number, col: number): number {
  const r = row - 0.5;
  const c = col - 0.5;
  const r0 = Math.floor(r);
  const c0 = Math.floor(c);
  cubicWeights(r - r0, wr);
  cubicWeights(c - c0, wc);
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const rr = Math.max(0, Math.min(ROWS - 1, r0 - 1 + i));
    let line = 0;
    for (let j = 0; j < 4; j++) {
      const cc = (((c0 - 1 + j) % ANGLE_SECTORS) + ANGLE_SECTORS) % ANGLE_SECTORS;
      line += field.t[rr * ANGLE_SECTORS + cc] * wc[j];
    }
    v += line * wr[i];
  }
  return Math.max(0, Math.min(1, v));
}

/** Writes the banded colour at a fractional position into an RGBA buffer. */
export function sample(field: ColorField, row: number, col: number, out: Uint8ClampedArray, at: number): void {
  const i = Math.round(sampleValue(field, row, col) * 255) * 3;
  out[at] = field.lut[i];
  out[at + 1] = field.lut[i + 1];
  out[at + 2] = field.lut[i + 2];
  out[at + 3] = 255;
}

let hatch: CanvasPattern | null = null;
export function hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (hatch) return hatch;
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const p = c.getContext('2d');
  if (!p) return null;
  p.strokeStyle = color.hatch;
  p.lineWidth = 1.2;
  p.beginPath();
  p.moveTo(0, 8);
  p.lineTo(8, 0);
  p.moveTo(-2, 2);
  p.lineTo(2, -2);
  p.moveTo(6, 10);
  p.lineTo(10, 6);
  p.stroke();
  hatch = ctx.createPattern(c, 'repeat');
  return hatch;
}

/** A fine diamond net pattern over the heat, so the surface reads as netting. */
export function drawMesh(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, step: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(19, 32, 45, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let o = -h; o < w + h; o += step) {
    ctx.moveTo(x + o, y);
    ctx.lineTo(x + o + h, y + h);
    ctx.moveTo(x + o, y + h);
    ctx.lineTo(x + o + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** A torn opening in the net: dark centre, ragged red rim. Drawn where a hole is open. */
export function drawHole(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.save();
  ctx.beginPath();
  const points = 11;
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2;
    const rr = r * (0.75 + 0.25 * Math.sin(i * 2.7) * Math.cos(i * 1.3));
    const px = x + Math.cos(a) * rr * 1.3;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(40, 12, 10, 0.85)';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  ctx.strokeStyle = color.riskCritical;
  ctx.stroke();
  ctx.restore();
}

/**
 * Paints the whole net (wall rows then cone rows) as one rectangle: angle across, depth down.
 * This is the 3D texture; the unrolled map draws the wall from it and the cone separately.
 */
export function paintNetTexture(canvas: HTMLCanvasElement, grid: LayerGrid, layer: LayerDef, holes: Finding[]): void {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const field = colorField(grid, layer);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const row = ((y + 0.5) / h) * ROWS;
    for (let x = 0; x < w; x++) sample(field, row, ((x + 0.5) / w) * ANGLE_SECTORS, img.data, (y * w + x) * 4);
  }
  ctx.putImageData(img, 0, 0);
  const cw = w / ANGLE_SECTORS;
  const ch = h / ROWS;
  const pattern = hatchPattern(ctx);
  if (layer.hatchStale && pattern) {
    ctx.fillStyle = pattern;
    for (let c = 0; c < CELLS; c++) if (grid.stale[c]) ctx.fillRect(cellCol(c) * cw, cellRow(c) * ch, cw, ch);
  }
  drawMesh(ctx, 0, 0, w, h, Math.max(6, cw / 4));
  for (const f of holes) drawHole(ctx, (cellCol(f.cell) + 0.5) * cw, (cellRow(f.cell) + 0.5) * ch, Math.min(cw, ch) * 0.32);
}
