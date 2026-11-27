# Plan: the end-to-end pipeline in the dashboard

Status: proposal, 2026-11-28. Nothing here is built yet. The loop itself (sweep → detect → decide →
guided run → learn) is described in [`docs/closed-loop.md`](../docs/closed-loop.md) and its seams in
[`docs/contracts.md`](../docs/contracts.md); this file only says how the operator dashboard shows it.

## What the demo should let someone follow

One pen (the Isaac pen, UI **Pen 7**), from top to bottom, with real data from a run:

1. **Site:** Pen 7 carries a pin because the last run found something.
2. **Pen:** the net shows which areas the run filmed (fresh), what the image pipeline found there, and
   which areas are still unobserved (hatched as stale, as today).
3. **Plan:** the drones in Pen 7 work the decision layer's plan: each one shows its target, rule
   (P1–P6), distance off the net and partner, exactly as the simulated swarm does now.
4. **Robot window:** clicking a drone shows the real photo it took for that target, the detection
   boxes from `vision.jsonl`, and the net-life prediction from the teammate's module.
5. **Missions:** each target closes with its result (confirmed, clear, needs another look), and the
   next plan escalates what is still unsure.

The other seven pens stay simulated. The dashboard says which is which (a "Live data" or
"Simulated" tag on the pen), so no number pretends to be real.

## What already lines up

- **Same grid.** The dashboard's cells are the contract's cells: 24 sectors × 8 wall rows,
  `cell = row * 24 + col`. The sim's 24 × 3 rows land on rows 0–2 (0–7.5 m in 2.5 m bands).
  The dashboard also has 3 cone rows (20–30 m) the sim doesn't model; they stay unobserved.
- **Same rules.** The simulated swarm in `src/data/swarm.ts` now uses the plan rules (P1 two drones on
  a possible opening, P2 closer, P4 two angles through fouling, P5 wear, P6 high risk; a confirmed
  hole leaves the plan). So swapping in the real plan changes the data, not the UI.
- **Decision layer API** (`decision-layer/src/server.ts`, port 8787): `GET /api/plan?pen=7`,
  `GET /api/missions?pen=7`, `GET /api/alerts`, `POST /api/observations`, `GET /api/health`.

## Steps

Each step is usable on its own and falls back to the simulation when the server is off.

1. **Plan in the pen view (small).** A Vite dev proxy from `/api` to `localhost:8787`. A hook fetches
   `GET /api/plan?pen=7` and turns its targets into the dashboard's `Drone` objects (cell, rule,
   `standoff_m`, viewpoints, robots, `target_id`, reasons). Pen 7 then shows the real plan; the
   robot window shows the plan's reasons. If `/api/health` fails, Pen 7 keeps the simulated swarm.
2. **Missions in the side panel (small).** `GET /api/missions?pen=7` as a list under the pen:
   target, rule, status, result. Clicking one selects its cell.
3. **Run results on the net (medium).** The decision layer already joins `captures.jsonl` with
   `vision.jsonl`. It needs one read endpoint that returns, per cell of a pen: last seen (run and
   time), best detection (class, confidence, size) and image paths. The dashboard overlays that on
   Pen 7: last seen drives the coverage layer, and detections become findings ("possible opening",
   "thinning", "biofouling") in the same review flow as today.
4. **Real photos in the robot window (medium).** Serve the run's image folder (static files next to
   the API, or the dashboard's `public/` during a demo). `RobotView` shows the photo for the drone's
   target with the boxes from `vision.jsonl`, in place of the drawn feed. The component's props stay
   as they are, so the teammate's module can replace it later.
5. **Net-life prediction (depends on the teammate).** The placeholder slot in `RobotView` takes the
   module's output for the cell in view: remaining strength and expected time to failure.
6. **Replay a run (nice to have).** Step through a run's captures in time order on the 3D pen, so the
   judges see the drones fly the plan.

## Open decisions

From `docs/closed-loop.md`, still open:

1. Can one robot confirm an opening from two viewpoints, or does it take two robots (today: two)?
2. Who writes `vision.jsonl` for real, and from which model?
3. How run files get from the GPU machine to the laptop running the dashboard (copy with `scp`, or
   the sim calling the API through an SSH tunnel)?

For the dashboard:

4. Should the dashboard only show the loop, or also start it (an "Approve plan" button that posts
   to the decision layer)? Showing only is less work and keeps people in charge of approvals.
5. Where are run images served from during the demo?
