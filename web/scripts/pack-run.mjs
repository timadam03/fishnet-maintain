#!/usr/bin/env node
/**
 * Packs an Isaac Sim run into a dashboard run bundle (see INTEGRATION.md and src/data/runs.ts).
 *
 *   npm run pack-run -- --run <run_dir> [--rec <rec_dir>] [--vision <vision.jsonl>] [--plan <plan.json>]
 *                       [--pen 7] [--id <run_id>] [--out <bundles_dir>] [--hz 10] [--no-photos]
 *
 * <run_dir>  the sim's --out folder: captures.jsonl, ground_truth.json, nav_summary.json,
 *            plan_status.json, auv_k/img_*.png (and vision.jsonl, if run_vision.py wrote it there)
 * <rec_dir>  the sim's --record folder: telemetry.jsonl, meta.json, and per camera either an MP4
 *            (auv0.mp4, demo.mp4, ...) or the raw frame folder (auv0/00001.png, ...), which is
 *            encoded with ffmpeg. The annotated abyss_*.mp4 videos are copied when present.
 *
 * Without --rec, the telemetry is rebuilt from the photo positions (coarse) and marked as such.
 * Writes <bundles_dir>/<run_id>/ (default public/runs/) and updates <bundles_dir>/index.json.
 * Plain Node, no dependencies; ffmpeg only for raw frames.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 1;
const ROBOT_NAMES = ['ROV 1', 'ROV 2', 'ROV 3', 'ROV 4', 'ROV 5', 'ROV 6'];

function parseArgs(argv) {
  const args = { pen: 7, hz: 10, photos: true, out: resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'runs') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--run') args.run = resolve(next());
    else if (a === '--rec') args.rec = resolve(next());
    else if (a === '--vision') args.vision = resolve(next());
    else if (a === '--plan') args.plan = resolve(next());
    else if (a === '--pen') args.pen = Number(next());
    else if (a === '--id') args.id = next();
    else if (a === '--out') args.out = resolve(next());
    else if (a === '--hz') args.hz = Number(next());
    else if (a === '--no-photos') args.photos = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .map((line, i) => [line.trim(), i + 1])
    .filter(([line]) => line)
    .map(([line, n]) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${n}: ${error.message}`);
      }
    });
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data));
const optional = (path) => (path && existsSync(path) ? path : null);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** The sim's telemetry.jsonl, resampled to `hz`. */
function telemetryFromRecording(path, hz) {
  const frames = readJsonl(path).filter((f) => Array.isArray(f.rov) && typeof f.t === 'number');
  if (frames.length === 0) throw new Error(`${path} has no frames`);
  const n = frames[0].rov.length;
  const tel = { hz, t: [], rov: Array.from({ length: n }, () => ({ pos: [], yaw: [], filter: [], clr: [], contacts: [], shots: [] })), shots: [] };
  let next = frames[0].t;
  for (const f of frames) {
    for (const k of f.shot ?? []) tel.shots.push({ t: round(f.t), rov: k });
    if (f.t + 1e-9 < next) continue;
    next = f.t + 1 / hz;
    tel.t.push(round(f.t));
    f.rov.forEach((r, k) => {
      const out = tel.rov[k];
      out.pos.push(r.pos.map((v) => round(v)));
      out.yaw.push(round(r.yaw ?? 0));
      out.filter.push(r.filter ? 1 : 0);
      out.clr.push(round(r.clr ?? 0));
      out.contacts.push(r.contacts ?? 0);
      out.shots.push(r.shots ?? 0);
    });
  }
  return tel;
}

/** Coarse telemetry from the photo positions alone, for runs recorded without --record. */
function telemetryFromCaptures(captures, robots, hz) {
  const end = Math.max(0, ...captures.map((c) => c.sim_time));
  const tel = { hz, t: [], rov: Array.from({ length: robots }, () => ({ pos: [], yaw: [], filter: [], clr: [], contacts: [], shots: [] })), shots: [] };
  const byRobot = Array.from({ length: robots }, (_, k) => captures.filter((c) => c.auv === k).sort((a, b) => a.sim_time - b.sim_time));
  for (const c of captures) tel.shots.push({ t: c.sim_time, rov: c.auv });
  for (let i = 0; i <= Math.ceil(end * hz); i++) {
    const t = round(i / hz);
    tel.t.push(t);
    byRobot.forEach((list, k) => {
      const out = tel.rov[k];
      let pos = list.length ? list[0].position : [0, 0, -1];
      let taken = 0;
      for (let j = 0; j < list.length; j++) {
        if (list[j].sim_time <= t) {
          taken = j + 1;
          const b = list[j + 1];
          const a = list[j];
          const f = b ? Math.min(1, (t - a.sim_time) / Math.max(1e-6, b.sim_time - a.sim_time)) : 0;
          pos = b ? a.position.map((v, d) => v + (b.position[d] - v) * f) : a.position;
        }
      }
      out.pos.push(pos.map((v) => round(v)));
      // Facing the net from inside: the heading points outward from the pen axis.
      out.yaw.push(round(Math.atan2(pos[1], pos[0])));
      out.filter.push(0);
      out.clr.push(0);
      out.contacts.push(0);
      out.shots.push(taken);
    });
  }
  return tel;
}

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

/** A camera from the record folder as an MP4 in the bundle: copied, or encoded from its frames. */
function packVideo(rec, name, outDir, fps, warnings) {
  if (!rec) return null;
  const mp4 = join(rec, `${name}.mp4`);
  const frames = join(rec, name);
  const target = join(outDir, `${name}.mp4`);
  if (existsSync(mp4)) {
    copyFileSync(mp4, target);
    return target;
  }
  if (!existsSync(frames) || !statSync(frames).isDirectory()) return null;
  const pngs = readdirSync(frames).filter((f) => f.endsWith('.png')).sort();
  if (pngs.length === 0) return null;
  if (!hasFfmpeg()) {
    warnings.push(`ffmpeg not found: skipped the ${name} feed (${pngs.length} frames)`);
    return null;
  }
  const first = Number(basename(pngs[0], '.png'));
  const res = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-y', '-framerate', String(fps), '-start_number', String(first), '-i', join(frames, '%05d.png'),
      '-vf', 'scale=960:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed on ${frames}`);
  return target;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.run) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 18).join('\n').replace(/^ \* ?/gm, ''));
    process.exit(args.help ? 0 : 1);
  }
  const capturesPath = join(args.run, 'captures.jsonl');
  if (!existsSync(capturesPath)) throw new Error(`${capturesPath} not found: --run must be the sim's --out folder`);
  const captures = readJsonl(capturesPath);
  if (captures.length === 0) throw new Error(`${capturesPath} is empty`);
  const groundTruthPath = optional(join(args.run, 'ground_truth.json'));
  const groundTruth = groundTruthPath ? readJson(groundTruthPath) : null;
  const meta = args.rec && existsSync(join(args.rec, 'meta.json')) ? readJson(join(args.rec, 'meta.json')) : null;

  // The grid must be the dashboard's (24 sectors × 8 wall rows), or cells would land in the wrong place.
  const grid = groundTruth?.grid;
  if (grid && (grid.ui_sectors !== 24 || grid.ui_wall_rows !== 8)) {
    throw new Error(`grid mismatch: the run uses ${grid.ui_sectors} × ${grid.ui_wall_rows}, the dashboard 24 × 8`);
  }
  const cage = {
    radius_m: meta?.cage_r ?? grid?.cage_radius_m ?? 8,
    depth_m: meta?.cage_depth ?? grid?.cage_depth_m ?? 8,
  };
  const runId = args.id ?? captures[0].run_id ?? basename(args.run);
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`run id "${runId}" may only use letters, digits, . _ -`);
  const robots = Math.max(meta?.cams?.filter((c) => /^auv\d+$/.test(c)).length ?? 0, ...captures.map((c) => c.auv + 1));
  const planned = captures.some((c) => c.plan_id || c.target_id);

  const outDir = join(args.out, runId);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'feeds'), { recursive: true });
  mkdirSync(join(outDir, 'views'), { recursive: true });
  const warnings = [];

  const telemetryPath = args.rec ? optional(join(args.rec, 'telemetry.jsonl')) : null;
  const telemetry = telemetryPath ? telemetryFromRecording(telemetryPath, args.hz) : telemetryFromCaptures(captures, robots, args.hz);
  if (!telemetryPath) warnings.push('no telemetry.jsonl: robot paths rebuilt from photo positions (coarse)');
  writeJson(join(outDir, 'telemetry.json'), telemetry);
  writeJson(join(outDir, 'captures.json'), captures);

  const visionPath = args.vision ?? optional(join(args.run, 'vision.jsonl'));
  if (visionPath) writeJson(join(outDir, 'vision.json'), readJsonl(visionPath));
  else warnings.push('no vision.jsonl: no detections in this bundle');
  const copyJson = (src, name) => (src ? (copyFileSync(src, join(outDir, name)), name) : null);
  const plan = copyJson(optional(args.plan), 'plan.json');
  const planStatus = copyJson(optional(join(args.run, 'plan_status.json')), 'plan_status.json');
  const navSummary = copyJson(optional(join(args.run, 'nav_summary.json')), 'nav_summary.json');
  const groundTruthOut = copyJson(groundTruthPath, 'ground_truth.json');

  let photos = null;
  if (args.photos) {
    let copied = 0;
    for (const c of captures) {
      const src = join(args.run, c.image);
      if (!existsSync(src)) continue;
      const dst = join(outDir, 'photos', c.image);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      copied++;
    }
    if (copied) photos = 'photos';
    if (copied < captures.length) warnings.push(`${captures.length - copied} of ${captures.length} photos not found in ${args.run}`);
  }

  const fps = meta?.fps ?? 30;
  const rel = (path) => (path ? path.slice(outDir.length + 1) : null);
  const robotList = Array.from({ length: robots }, (_, k) => ({
    index: k,
    name: ROBOT_NAMES[k] ?? `ROV ${k + 1}`,
    feed: rel(packVideo(args.rec, `auv${k}`, join(outDir, 'feeds'), fps, warnings)),
  }));
  const view = (name, frames) => {
    const copied = args.rec && existsSync(join(args.rec, `abyss_${name}.mp4`)) ? join(outDir, 'views', `${name}.mp4`) : null;
    if (copied) copyFileSync(join(args.rec, `abyss_${name}.mp4`), copied);
    return rel(copied ?? (frames ? packVideo(args.rec, frames, join(outDir, 'views'), fps, warnings) : null));
  };

  const duration = Math.max(telemetry.t.at(-1) ?? 0, ...captures.map((c) => c.sim_time));
  const manifest = {
    version: VERSION,
    run_id: runId,
    kind: planned ? 'plan' : 'sweep',
    pen_id: args.pen,
    plan_id: captures.find((c) => c.plan_id)?.plan_id ?? null,
    cage,
    duration_s: round(duration, 2),
    robots: robotList,
    obstacles: (meta?.obstacles ?? []).map((o) => [round(o[0]), round(o[1]), round(o[2] ?? 0.12)]),
    views: { orbit: view('orbit', 'demo'), section: view('section', 'section'), grid: view('grid', null) },
    photos,
    files: {
      telemetry: 'telemetry.json',
      captures: 'captures.json',
      vision: visionPath ? 'vision.json' : null,
      plan,
      plan_status: planStatus,
      nav_summary: navSummary,
      ground_truth: groundTruthOut,
    },
    telemetry_source: telemetryPath ? 'recorded' : 'captures',
  };
  writeJson(join(outDir, 'manifest.json'), manifest);

  const indexPath = join(args.out, 'index.json');
  const index = existsSync(indexPath) ? readJson(indexPath).filter((e) => e.run_id !== runId) : [];
  index.push({ run_id: runId, kind: manifest.kind, pen_id: manifest.pen_id, packed_at: new Date().toISOString() });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

  console.log(`Packed ${runId} (${manifest.kind}, ${captures.length} photos, ${robots} ROVs, ${manifest.duration_s} s) into ${outDir}`);
  for (const w of warnings) console.log(`  note: ${w}`);
}

try {
  main();
} catch (error) {
  console.error(`pack-run: ${error.message}`);
  process.exit(1);
}
