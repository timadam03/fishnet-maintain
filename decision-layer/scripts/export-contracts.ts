/**
 * Writes the contracts for teammates who don't use TypeScript:
 *   ../contracts/*.schema.json     JSON Schema of each seam (validate from Python with jsonschema)
 *   ../contracts/example-run/      a tiny Isaac-style run (captures.jsonl, ground_truth.json),
 *                                  the stand-in vision.jsonl, and the plan the layer makes from it
 * Run after changing src/contracts.ts:  npm run contracts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { InspectionPlan, SimCapture, VisionReport } from '../src/contracts.ts';
import { buildPlan, importObservations } from '../src/inspection.ts';
import { Store } from '../src/store.ts';
import { TODAY } from '../src/world.ts';
import { standInReport } from './stand-in-vision.ts';

const out = new URL('../../contracts/', import.meta.url);
const run = new URL('example-run/', out);
mkdirSync(run, { recursive: true });

for (const [name, schema] of Object.entries({ capture: SimCapture, 'vision-report': VisionReport, 'inspection-plan': InspectionPlan })) {
  writeFileSync(new URL(`${name}.schema.json`, out), JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2) + '\n');
}

// Same shapes Isaac writes: a 2 m sweep past a big hole, a small hole, thinning, fouling and a clean cell.
const R = 8;
const at = (i: number, cell: number, truth: Partial<SimCapture>): SimCapture => {
  const theta = (((cell % 24) + 0.5) * 15 * Math.PI) / 180;
  return SimCapture.parse({
    image: `auv_0/img_${String(i).padStart(4, '0')}.png`, run_id: 'example', auv: 0, sim_time: i * 12.5,
    theta_deg: Number(((theta * 180) / Math.PI).toFixed(2)), depth: -1.5, position: [6 * Math.cos(theta), 6 * Math.sin(theta), -1.5].map((v) => Number(v.toFixed(3))),
    cell, panel: 'r0_c00', fouled: (truth.fouling_frac ?? 0) > 0.05, fouling_frac: 0, thinning_frac: 0, holes_in_view: [], ...truth,
  });
};
const captures = [
  at(0, 30, { holes_in_view: [{ cell: 30, radius: 0.45 }] }),
  at(1, 100, { holes_in_view: [{ cell: 100, radius: 0.1 }] }),
  at(2, 150, { thinning_frac: 0.25 }),
  at(3, 60, { fouling_frac: 0.6 }),
  at(4, 5, {}),
];
const reports = captures.map((c) => standInReport(c, R));
const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(new URL('captures.jsonl', run), jsonl(captures));
writeFileSync(new URL('vision.jsonl', run), jsonl(reports));
writeFileSync(new URL('ground_truth.json', run), JSON.stringify({ run_id: 'example', grid: { ui_sectors: 24, ui_wall_rows: 8, cage_radius_m: R, cage_depth_m: 8 } }, null, 2) + '\n');

const store = new Store(':memory:');
importObservations(store, { penId: 7, captures, reports, cageRadiusM: R });
const plan = buildPlan(store, { penId: 7, day: TODAY, robots: 3 });
writeFileSync(new URL('plan.json', run), JSON.stringify({ ...plan, created_at: '2026-11-27T23:00:00.000Z' }, null, 2) + '\n');
console.log(`wrote 3 schemas and an example run with a ${plan.targets.length}-target plan to ${out.pathname}`);
