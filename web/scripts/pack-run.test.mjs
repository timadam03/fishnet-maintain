import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseManifest } from '../src/data/runs';

/** End-to-end tests of the packing script: real files in a temp folder, the dashboard's own manifest check. */
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const example = resolve(web, '..', 'contracts', 'example-run');
const tmp = mkdtempSync(join(tmpdir(), 'runs-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const pack = (...args) => execFileSync('node', [join(web, 'scripts', 'pack-run.mjs'), '--out', tmp, ...args], { encoding: 'utf8', stdio: 'pipe' });
const readBundle = (id, file) => JSON.parse(readFileSync(join(tmp, id, file), 'utf8'));

describe('pack-run and the bundle format', () => {
  it('packs the example run into a bundle the dashboard accepts', () => {
    pack('--run', example, '--vision', join(example, 'vision.jsonl'), '--plan', join(example, 'plan.json'));
    const manifest = parseManifest(readBundle('example', 'manifest.json'));
    expect(manifest).toMatchObject({ run_id: 'example', kind: 'sweep', pen_id: 7, cage: { radius_m: 8, depth_m: 8 }, telemetry_source: 'captures' });
    expect(manifest.files.vision).toBe('vision.json');
    expect((readBundle('example', 'captures.json')).length).toBe(5);
    expect(JSON.parse(readFileSync(join(tmp, 'index.json'), 'utf8'))).toEqual([expect.objectContaining({ run_id: 'example', pen_id: 7 })]);
  });

  it('resamples a recorded telemetry file and keeps every photo event', () => {
    const run = join(tmp, 'src-run');
    const rec = join(tmp, 'src-rec');
    mkdirSync(run, { recursive: true });
    mkdirSync(rec, { recursive: true });
    writeFileSync(join(run, 'captures.jsonl'), JSON.stringify({ image: 'auv_0/img_0000.png', run_id: 'rec1', auv: 0, sim_time: 1, theta_deg: 45, depth: -2, position: [4, 4, -2], cell: 51 }) + '\n');
    writeFileSync(join(rec, 'meta.json'), JSON.stringify({ cage_r: 8, cage_depth: 8, fps: 30, cams: ['demo', 'auv0', 'auv1'], obstacles: [[1, 2, 0.12]] }));
    // Two seconds at 30 fps in the sim's format; a photo by ROV 2 at frame 15.
    const frames = Array.from({ length: 60 }, (_, i) => ({
      i,
      t: i / 30,
      rov: [0, 1].map((k) => ({ pos: [k, i / 30, -1], yaw: 0, filter: i === 20 && k === 0, clr: 1.5, contacts: 0, shots: i >= 15 && k === 1 ? 1 : 0 })),
      shot: i === 15 ? [1] : [],
    }));
    writeFileSync(join(rec, 'telemetry.jsonl'), frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
    pack('--run', run, '--rec', rec, '--no-photos');
    const manifest = parseManifest(readBundle('rec1', 'manifest.json'));
    expect(manifest.telemetry_source).toBe('recorded');
    expect(manifest.robots.map((r) => r.name)).toEqual(['ROV 1', 'ROV 2']);
    expect(manifest.obstacles).toEqual([[1, 2, 0.12]]);
    const tel = readBundle('rec1', 'telemetry.json');
    expect(tel.t.length).toBe(20); // 10 Hz over two seconds
    expect(tel.shots).toEqual([{ t: 0.5, rov: 1 }]);
    expect(tel.rov[1].shots.at(-1)).toBe(1);
  });

  it('refuses a run on a different grid', () => {
    const run = join(tmp, 'bad-grid');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'captures.jsonl'), readFileSync(join(example, 'captures.jsonl')));
    writeFileSync(join(run, 'ground_truth.json'), JSON.stringify({ grid: { ui_sectors: 12, ui_wall_rows: 3 } }));
    expect(() => pack('--run', run, '--id', 'bad', '--no-photos')).toThrow(/grid mismatch/);
  });

  it('rejects a malformed manifest', () => {
    expect(() => parseManifest({ version: 2 })).toThrow(/version/);
    expect(() => parseManifest({ version: 1, run_id: 'x', kind: 'tour' })).toThrow(/kind/);
  });
});
