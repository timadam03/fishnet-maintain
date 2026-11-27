/**
 * STAND-IN for the image pipeline, so the loop can be tested before the real detector is wired.
 * Reads an Isaac run (captures.jsonl + ground_truth.json) and writes vision.jsonl in the
 * VisionReport format, from the simulator's ground truth plus a simple camera model:
 *   - closer to the net = sharper image and higher confidence (that is what re-scans buy);
 *   - fouling lowers hole confidence (growth hides holes);
 *   - deterministic noise per image, so runs are repeatable.
 * Its output is labelled model "stand-in-ground-truth" and must never be shown as detections.
 *
 *   tsx scripts/stand-in-vision.ts <run_dir>   → <run_dir>/vision.jsonl
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimCapture, type VisionReport } from '../src/contracts.ts';

const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));
/** Repeatable noise in [-1, 1] from the image name and a salt. */
const noise = (key: string, salt: string): number => (createHash('sha256').update(key + salt).digest()[0] / 255) * 2 - 1;

/**
 * Tuned to Isaac's default 4 m sweep: from 4 m the images are usable (quality ≈ 0.65) but small
 * holes and thinning come out unsure (0.4–0.55), a large hole likely (≈ 0.76); from the plan's
 * 1–1.5 m close-ups a small hole reaches ≈ 0.8. That gap is what a guided re-scan buys.
 */
export function standInReport(c: SimCapture, cageRadiusM: number): VisionReport {
  const standoff = Math.max(0.3, cageRadiusM - Math.hypot(c.position[0], c.position[1]));
  const sharpness = clamp(1.1 - 0.1 * standoff + 0.05 * noise(c.image, 's'));
  const visibility = clamp(0.9 - 0.06 * standoff + 0.05 * noise(c.image, 'v'));
  const fouling = c.fouling_frac ?? 0;
  const detections: VisionReport['detections'] = [];
  for (const h of c.holes_in_view ?? []) {
    const conf = clamp(1.0 - 0.12 * standoff + 0.8 * (h.radius - 0.15) - 0.3 * fouling + 0.04 * noise(c.image, 'h'), 0.05, 0.98);
    detections.push({ class: h.radius < 0.2 ? 'mesh_opening' : 'hole', confidence: Number(conf.toFixed(2)), bbox: [256, 144, 128, 72], size_m: Number((2 * h.radius).toFixed(2)) });
  }
  if ((c.thinning_frac ?? 0) > 0.05) {
    const conf = clamp(0.4 + 1.0 * (c.thinning_frac ?? 0) - 0.06 * standoff + 0.04 * noise(c.image, 't'), 0.05, 0.95);
    detections.push({ class: 'thinning', confidence: Number(conf.toFixed(2)), bbox: [200, 120, 240, 120] });
  }
  if (fouling > 0.2) detections.push({ class: 'biofouling', confidence: Number(clamp(0.6 + 0.4 * fouling).toFixed(2)), bbox: [0, 0, 640, 360] });
  return {
    image: c.image,
    model: 'stand-in-ground-truth',
    quality: { visibility: Number(visibility.toFixed(2)), sharpness: Number(sharpness.toFixed(2)) },
    fouling_pct: Number(fouling.toFixed(2)),
    detections,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: tsx scripts/stand-in-vision.ts <run_dir>');
  const truth = JSON.parse(readFileSync(join(dir, 'ground_truth.json'), 'utf8')) as { grid?: { cage_radius_m?: number } };
  const radius = truth.grid?.cage_radius_m ?? 8;
  const captures = readFileSync(join(dir, 'captures.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => SimCapture.parse(JSON.parse(l)));
  writeFileSync(join(dir, 'vision.jsonl'), captures.map((c) => JSON.stringify(standInReport(c, radius))).join('\n') + '\n');
  console.log(`wrote ${captures.length} stand-in reports to ${join(dir, 'vision.jsonl')} (ground-truth based, not detections)`);
}
