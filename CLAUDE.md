# CLAUDE.md: Abyss closed-loop net inspection

Context for Claude Code sessions on this repo. Written 2026-11-28 at the end of the session that
built the closed loop (sim → detector → decision layer → sim). Read this first, then
[`docs/closed-loop.md`](docs/closed-loop.md) and [`docs/contracts.md`](docs/contracts.md).

## What this is

Abyss (hackathon team; pitch: swarms of small underwater drones for fish-farm net inspection,
positioning without GPS as the moat) builds a closed loop in Isaac Sim:

1. **Sweep**: three ROVs photograph the whole net pen from near its centre (far, cheap).
2. **Detect**: the net classifier finds holes, thinning and biofouling in every photo.
3. **Decide**: the decision layer grades every net cell, ranks them and writes a plan
   (by the plan rules, or by the **d1** decision model).
4. **Act**: the ROVs fly the plan: closer (1.2–1.6 m), from two sides, two robots on a likely hole,
   with a per-target HOCBF safety margin.
5. **Learn**: the close-ups go back through 2 and 3, missions close with results, the next plan
   escalates what is still unsure.

The point to show: the intelligence layer changes what the robots do, and the d1 grader
should make them spend their time on the right (risky) places.

People: Einar (Abyss co-founder, sim/navigation, drives this work), Tim (repo owner, wrote the
decision layer), a friend who wrote the classifier.

## Working agreements

- **Einar commits and pushes himself.** Edit files; don't commit or push unless asked.
- For bigger changes (new pipeline steps, changes to the contracts or to Tim's decision-layer
  rules), explain the plan and **wait for approval** before editing.
- **Don't change `abyss-sim/perception/net_inspect.py`** (the friend's classifier). It was tuned on
  this sim's images; adapt around it in `abyss-sim/tools/run_vision.py`.
- Keep the decision layer's rules path working: d1 is an alternative grader, the rules are the fallback.
- Files in the repo are CRLF on Windows; keep line endings. `.ps1` files must stay ASCII
  (Windows PowerShell 5.1).
- Parked on purpose: GPS-free cooperative positioning (SwarmState), uncertainty-inflated CBF margins.

## Machines

| | Parsec GPU box (runs everything) | Einar's PC (edits, small tests) |
|---|---|---|
| GPU | RTX 4070 SUPER 12 GB, 32 GB RAM | RTX 4060 8 GB, 16 GB RAM |
| Isaac Sim 5.1 | `C:\isaacsim51` (`python.bat`) | not installed |
| Repo | `C:\fishnet` | `C:\Users\ebjen\OneDrive\Desktop\abyss_demo\abyss-sim\abyss-sim` |
| Outputs | `C:\abyss_out\<loop>` | |
| Node | 24+ needed (v26 installed via winget) | |

Branch: **`feat/closed-loop`** (sim plan mode and the decision layer merged, plus everything below).
Remote: `https://github.com/timadam03/fishnet-maintain`.

## How to run (Parsec, PowerShell, from `C:\fishnet`)

One-time: `C:\fishnet\.env` (gitignored). Write it as ASCII; PowerShell's `utf8` adds a BOM that breaks the first key:

```powershell
Set-Content -Path C:\fishnet\.env -Encoding ascii -Value @(
  "AI_GATEWAY_API_KEY=<key>",
  "DECISION_MODEL=liquid/d1.2-ultra"
)
cd decision-layer; npx tsx --env-file=../.env scripts/check-model.ts decision liquid/d1.2-ultra; cd ..   # prints ok (p=0.99)
```

The whole loop, one command (`abyss-sim/scripts/run_loop.ps1`):

```powershell
# rules grader, full loop, new sweep
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\loop2 -Record
# d1 grader on the SAME sweep (compare): plan_d1.json + run_plan_d1, score shows both plans
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\loop2 -SkipSweep -Grader d1 -Record
# watch it live in the Isaac Sim window (closes itself after each run so the loop continues)
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\loop3 -Gui -View orbit -Grader d1
```

Options: `-Grader rules|d1`, `-SkipSweep` (reuse `<Out>\run_sweep`), `-Record` (videos), `-Gui`,
`-View orbit|section|auv0|auv1|auv2`, `-Lite` (640x360: too coarse for the detector's close-ups, only
for checking the plumbing), `-Seed 7` (which defects), `-Obstacles 12` (ropes), `-KeepMemory`.
Keep `-Seed`/`-Obstacles` the same between the sweep and its plan runs.

Steps it runs and what lands in `<Out>`:

| Step | Output |
|---|---|
| 1 sweep (Isaac, centre survey, `--full-coverage`) | `run_sweep\` photos, `captures.jsonl`, `ground_truth.json` |
| 2 detect (`tools/run_vision.py`) | `run_sweep\vision.jsonl`, `overlays\` |
| 3 decide (`npm run cli -- reset / import / plan --grader G`) | `run_sweep\plan_<G>.json` |
| 4 act (Isaac `--plan`) | `run_plan_<G>\` photos, `plan_status.json` (photos/timeouts per target) |
| 5 learn (detect + `import --grader G` + `missions` + next plan) | missions closed in `C:\fishnet\shoal.db`, `run_plan_<G>\next_plan.json` |
| 6 score (`tools/score_loop.py`) | console + `run_plan_<G>\score.txt` |
| video (with `-Record`) | `rec_sweep\`, `rec_plan_<G>\` (`abyss_grid/orbit/section.mp4`), **`abyss_loop_<G>.mp4`** = whole loop with title cards |

Re-make pieces by hand:

```powershell
python abyss-sim\tools\run_vision.py C:\abyss_out\loop2\run_sweep --overlays
python abyss-sim\tools\score_loop.py C:\abyss_out\loop2 --db C:\fishnet\shoal.db --save C:\abyss_out\loop2\run_plan_rules\score.txt
C:\isaacsim51\python.bat abyss-sim\tools\make_video.py C:\abyss_out\loop2\rec_plan_d1
C:\isaacsim51\python.bat abyss-sim\tools\make_loop_video.py C:\abyss_out\loop2 --grader rules --db C:\fishnet\shoal.db [--plan-speed 2] [--view section]
cd decision-layer; npm run cli -- missions; npm run cli -- plan --grader d1; cd ..
```

The mission results live in `shoal.db`, and every loop starts with `reset`: make a loop's video /
score **before** running the next loop.

Tests (decision layer): `cd decision-layer; npm test; npm run typecheck`. Offline, d1 is faked.

## Architecture and contracts

- Grid: **24 sectors × 8 wall rows**, `cell = row*24 + col`, row 0 at the surface, col 0 at 0°.
  Only cells cross the seams, never metres. Isaac pen: radius 8 m, wall depth 8 m (the web UI draws a
  25 m pen; same grid).
- `captures.jsonl` (sim) + `vision.jsonl` (detector) → decision layer → `plan.json` → sim.
  JSON Schemas in `contracts/`; zod source of truth in `decision-layer/src/contracts.ts`.
- Camera: hfov 60.4°, looks along the vehicle heading, image right = clockwise (smaller θ),
  image up = +z, mounted 0.24 m forward / 0.02 m up.

### Sim: `abyss-sim/sim/fishfarm_demo.py` (+ `plan_mode.py`, `safe_nav.py`)
- Centre survey (default `--survey centre`, `--centre-radius 1.5`): ROVs hold a station near the
  axis per depth band and yaw across their sector, ~6.5 m from the net. `pm.waypoint` aims the
  camera at the net point and records `look_dist`.
- Defects from `--defect-seed` (own RNG): 4 holes (radii 0.10/0.16/0.28/0.45 m, two inside thinning
  patches), 3 thinning patches, 4 fouling patches, ≤10% of the net. `ground_truth.json` has them all.
- Scenery off by default (`--scenery` for seabed/rocks/kelp/surface), fog off: high-contrast net.
- Ropes (`--obstacles`): placed on inspection paths, transits and at random; never on a centre-survey station.
- Each capture records `cell`, `theta_deg`, `depth`, `position`, `yaw_deg`, `look_dist`, ground-truth
  labels (`holes_in_view`, `fouling_frac`, `thinning_frac`), and `target_id` in plan runs.
- `--plan plan.json`: per-target waypoints (standoff, viewpoints, shots, robots, margin), robots take
  turns on shared targets, then coverage. `--close-when-done` closes the GUI after the run.

### Detector step: `abyss-sim/tools/run_vision.py`
Runs `net_inspect.inspect_frame` (survey/investigation mode) per photo and writes the contract:
class mapping (`unknown` → `thinning` if apparent-width evidence, else `mesh_opening`), severity,
`size_m`, quality (from mesh pitch in px and valid area), `fouling_pct`. **Each detection gets its
own `cell`** (ray from the camera through its pixel to the net cylinder) and each report lists
`cells_in_view`. It prints a position check against ground truth (loop2: median miss 0.00 m by
pixel vs 1.30 m at the photo centre).

### Decision layer: `decision-layer/` (TypeScript, Node 24, `node:sqlite`)
- `inspection.ts`: import (joins captures and reports), `creditByCell` (each photo counts for
  every cell it shows, each detection for its own cell), `assessCell` (rules: confirmed_opening needs
  2 views ≥0.7; possible_opening ≥0.7; wear ≥0.7; uncertain ≥0.3; unclear quality <0.5; fouled ≥0.4;
  clear; close-ups ≤1.8 m replace far photos), plan rules P1–P6 + G1 (strong current) + S1
  (reachable standoff), `buildPlan(store, {grades?})`, missions close on import.
- `grade-d1.ts`: **the d1 grader.** Per cell worth asking (anything found on or next to it, poor
  photo, fouling), a text state (≤6000 chars: photos, distances, quality, detections, neighbours,
  risk-model factors, earlier missions) and six yes/no questions (`opening, wear, fouling, hidden,
  settled, urgent`) to d1 via the Vercel AI Gateway (`d1.ts`, `experimental_decide`). Code maps the
  probabilities to a status (opening ≥0.75 + 2 views → confirmed; ≥0.55 → possible; wear ≥0.6; ...)
  and a priority `0.2 + 0.55·need + 0.25·urgent`. Scan, robots and safety margin still come from
  the plan rules for that status. Per-cell fallback to the rules ("D1-fallback" reason), cached
  answers in `d1_cache`. `import --grader d1` also adds d1's verdict to each closed mission.
- CLI (`npm run cli -- ...`): `reset`, `import <run_dir> [--grader d1]`, `plan [--grader rules|d1] [--out f]`, `missions`, `trace`, `demo`.
- The web dashboard (`web/`) runs on its own simulated data; it is not connected to the loop.

## Results so far

Seed 7 ground truth: holes centred on cells 94 (0.45 m, also covers 69, 70, 93), 108 (also 84),
31 (also 55) and 69; thinning around 69/31/67; fouling around 127, 82, 71, 143.

- **loop1** (`-Lite`, before per-detection cells): two false alarms, the big hole missed (close-up
  on cell 70 while the hole was centred on 94), poor close-up quality (mesh too coarse at 640x360).
- **loop2 rules plan** (full res, per-detection cells): all four holes targeted (three in the top
  three), 8 of 10 targets on real defects; m7/m8 (cells 86, 110) likely clean.
  Plan-run results and the d1 comparison: pending (check `C:\abyss_out\loop2`).

## Next steps

1. Compare `plan_rules` and `plan_d1` (score table, mission results, videos) on loop2.
2. **Merge neighbouring opening cells into one target**: the 0.45 m hole spans 4 cells and gets 4
   two-robot targets (16 close-ups); one target at their shared centre frees ~3 slots. Planner
   change, helps both graders.
3. Tune d1 thresholds/questions in `grade-d1.ts` from the comparison (watch for d1 marking everything clear).
4. P6 targets come from the dashboard's simulated Pen 7 history, not the Isaac net: they score as
   "wasted". Consider turning P6 off for Isaac runs.
5. Waypoint timeouts on close-ups (seen in loop1): check `plan_status.json`.

## Gotchas

- Windows PowerShell 5.1: no `$ErrorActionPreference = "Stop"` around native tools (stderr = error);
  `Tee-Object`/`Out-File` write UTF-16; `Set-Content -Encoding utf8` writes a BOM.
- Isaac Sim may crash on shutdown after a good run: judge a run by its `captures.jsonl`, not the exit code.
- Build file paths with `os.path.join` (mixed `\` and `/` fails on Windows); `captures.jsonl` keeps `/`.
- Running `run_loop.ps1` reads the whole script at start, so `git pull` mid-run is safe.
- ROV cameras normally render only while a photo is taken (`set_cam_rendering`). With `--record`, the
  recorded ROV cameras (`REC_AUVS`, from `--record-cams`) render every frame, because the recorder
  shares their render product; otherwise the ROV tiles in the videos freeze. Recording is slower for it.
- `npm run setup` is bash; on Windows use the commands above.
