# Plan: the whole pipeline inside the dashboard

Status: 2026-11-28. Step 1 is built; the rest is a proposal. The loop itself (sweep → detect → decide →
guided run → learn) is in [`docs/closed-loop.md`](../docs/closed-loop.md), its file formats in
[`docs/contracts.md`](../docs/contracts.md).

**The idea:** a sim run is not a video. It is data: where every robot was, what its safety filter did,
which net cell every photo shows, what the image pipeline found, and what the decision layer planned
next. The dashboard should replay that data in its own 3D pen, on its own timeline, so the robots,
the net, the findings, the camera feed and the plan all move together. The demo video becomes one
view of the run, not the run itself.

## What a run already produces

Read from the code on `feat/sim-plan-mode` (`abyss-sim/sim/fishfarm_demo.py`, `tools/make_video.py`,
`scripts/run_cluster.sh`) and in `decision-layer/`. None of it has been run here: there is no recorded
run in this repo yet (`contracts/example-run/` has records, but no telemetry or images).

| File | What is in it | Used for in the dashboard |
|---|---|---|
| `rec_<run>/telemetry.jsonl` | Every recorded frame: time `t`, and per ROV `pos`, `yaw`, nominal and safe command, `filter` (HOCBF acting), clearance, minimum clearance, contacts, photos taken, done; `shot` events | Drives the drones in the 3D pen, their safety state and photo flashes |
| `rec_<run>/meta.json` | Cage radius and depth, obstacle positions and radii, HOCBF inflation, fps, cameras | Places the hanging ropes where the sim had them; scales the run to the pen |
| `rec_<run>/auv0..2/*.png`, `demo/`, `section/` | Each ROV's camera, the orbit and the cutaway camera, frame by frame | Each robot's own feed in its window; orbit and cutaway as extra views |
| `rec_<run>/abyss_*.mp4` | The annotated videos made from those frames | Optional full-size views (what is embedded today) |
| `run_<run>/captures.jsonl` | One record per inspection photo: image, ROV, time, angle, depth, position, net `cell`; for plan runs also `target_id`, `viewpoint`, `visit` | Coverage on the net; the photo strip in the robot window |
| `run_<run>/auv_k/img_*.png` | The inspection photos | Shown with their detections |
| `vision.jsonl` (image pipeline) | Per photo: detections (class, confidence, box, size), fouling, image quality | Findings on the net, boxes on the photos |
| `run_<run>/ground_truth.json` | Planted holes, thinning and fouling, and the grid mapping | Optional "check against truth" in the demo |
| `run_<run>/nav_summary.json` | Per ROV: minimum clearance, contacts, how often the filter acted | Real safety numbers in the robot window |
| `plan.json`, `plan_status.json` | The decision layer's targets (rule, standoff, viewpoints, robots) and how the run flew them | Plan panel; which target each drone flies |
| Decision layer missions | Each target's result: confirmed opening, clear, needs another look | Missions closing in the side panel |

## The demo, end to end

1. **Site.** The other pens stay simulated. Pen 7 (the Isaac pen) is tagged "Run data" and carries
   the run's pin, for example a possible opening. No simulated number is shown as real.
2. **Fly into Pen 7.** The drones in it are now the run's three ROVs, replaying their recorded paths:
   a thin trail, a clearance ring that turns red while the safety filter steps in, and a flash for
   each photo. The ropes hang where the sim had them.
3. **Run timeline.** In Pen 7 the time bar switches from days to the run's seconds, with play and
   scrub. As photos come in, the cells they cover turn fresh, and detections appear as findings
   ("possible opening 0.58", "biofouling") in the same review flow as today.
4. **Click a ROV.** Its window plays its own camera feed on the same clock as the 3D replay, so
   scrubbing moves both. Below it: the photos it took with the detection boxes, the target and rule it
   is flying (for example "P1, confirm opening from the left, 1.6 m off the net"), and its safety
   numbers. The net-life slot stays for the teammate's module.
5. **Expand.** The same zoom as today, with a switch between the ROV feed, the orbit view and the
   cutaway, all on the run clock.
6. **The loop.** A plan panel shows what the decision layer wants next, and why. Loading the guided
   run (a second bundle) replays the robots flying those targets; missions close as confirmed or
   clear, and the next plan escalates what is still unsure.

## How it fits together

- **Run bundle.** A folder per run in `web/public/runs/<run_id>/` with a `manifest.json` that lists
  everything above, each ROV's feed encoded as a small MP4, and the telemetry downsampled to about
  10 Hz. Static files, so the demo needs no GPU machine, server or network.
- **Packing script.** `npm run pack-run -- <rec_dir> <run_dir> [--vision vision.jsonl] [--plan plan.json]`
  in `web/scripts/` builds the bundle (ffmpeg encodes the feeds from the frame PNGs). Bundles are
  git-ignored, like the demo video.
- **Dashboard.** A loader and types in `src/data/runs.ts`, checked on load. A run clock in the app
  state next to `day`. Pen 7's drones, coverage and findings come from the bundle when one is loaded,
  and from the simulation otherwise. While a ROV feed plays it is the master clock
  (`requestVideoFrameCallback`), so video and 3D never drift.
- **Decision layer, optional live** (`decision-layer/src/server.ts`, port 8787): `GET /api/plan?pen=7`
  and `GET /api/missions?pen=7` through a Vite proxy, to show a fresh plan. The bundle keeps its own
  `plan.json`, so the demo never depends on the server.

**Mapping the sim pen onto Pen 7.** Radius scales 8 m → 25 m. Depth scales 8 m → 20 m, which is how
the sim addresses cells today (depth as a fraction of the wall; `ground_truth.json`: `cage_radius_m: 8`,
`cage_depth_m: 8`). Angles keep their number: the sim counts counter-clockwise from +x and the
dashboard clockwise from north, but both put 15° sectors on the same `col`, so a photo lands on the
same cell and the pen is only mirrored. The dashboard's 3 cone rows (20–30 m) aren't in the sim and
stay unobserved. If depths should stay true instead (open decision 6), only this mapping changes.

**What already lines up.**
- The simulated swarm (`src/data/swarm.ts`) already follows the plan rules (P1 two drones on a likely
  opening, P2 closer, P4 two angles through fouling, P5 wear, P6 high risk; a confirmed hole leaves
  the plan), so real plans change the data, not the UI.
- The decision layer on `feat/decision-layer` carries its own, older copy of `web/src/data`, so the
  problem areas and plan-rule swarm added on this branch only reach it once the branches are merged.
  Its tests pass against this branch's simulation (22/22, checked 2026-11-28).

## Steps

1. **Bundle format, packing script and loader. Done.** Format and loader: `src/data/runs.ts`
   (`parseManifest`, `loadRunIndex`, `loadRun`, `simToPen`, `simCell`, `sampleTelemetry`). Packer:
   `scripts/pack-run.mjs` (`npm run pack-run`; `npm run pack-run:example` packs
   `contracts/example-run/`). Tests: `src/data/runs.test.ts`, `scripts/pack-run.test.mjs`. Not yet
   tried on a real run: the recorded-telemetry path is tested with files in the sim's format.
2. **Replay in Pen 7** (medium). Drones from telemetry, run clock and scrubber, ropes from `meta.json`,
   clearance rings and photo flashes.
3. **Coverage and findings from the run** (medium). `captures.jsonl` and `vision.jsonl` on Pen 7's net.
4. **Robot window on the run** (medium). The ROV's own feed on the run clock, the photo strip with
   boxes, target and rule, safety numbers. Replaces today's single demo video (kept as a fallback).
5. **Plan and missions** (medium). The plan panel, a second bundle for the guided run, missions closing.
6. **More views when expanded** (small). Orbit and cutaway next to the ROV feed.

## What is needed from the team

- One recorded run copied to this laptop: `rec_<run>/` (telemetry, meta, frames) and `run_<run>/`
  (captures, photos, nav summary). Ideally a sweep and the guided run that followed it.
- `vision.jsonl` for those photos (the stand-in grader is fine to start).

## Open decisions

From `docs/closed-loop.md`:

1. Can one robot confirm an opening from two viewpoints, or does it take two robots (today: two)?
2. Who writes `vision.jsonl` for real, and from which model?
3. How run files get from the GPU machine to the laptop (copy with `scp`, or the sim calling the API
   through an SSH tunnel)?

For the dashboard:

4. Should the dashboard only show the loop, or also start it (an "Approve plan" button that posts to
   the decision layer)? Showing only is less work and keeps people in charge of approvals.
5. Where are run bundles kept for the demo (copied by hand like the demo video, or a shared drive)?
6. Sim depth: keep mapping the 8 m cage onto the full 20 m wall (as built), or treat it as the top
   8 m of a real pen so depths stay true (rows 0–2)?
