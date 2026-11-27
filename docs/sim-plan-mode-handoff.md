# Handoff: the sim acts on the decision layer (`--plan`)

Date: 2026-11-28. For: whoever runs the sim on the GPU cluster and builds the next step.

Read first: [`closed-loop.md`](closed-loop.md). It covers the loop, what exists, how plan mode flies, and the open decisions.

## 1. Where things are

| What | Branch | Path |
|---|---|---|
| Sim + plan mode | `feat/sim-plan-mode` (this branch, cut from `environment-and-safe-navigation`) | `abyss-sim/` |
| Decision layer (grades, ranks, writes `plan.json`, closes missions) | `feat/decision-layer` | `decision-layer/`, `contracts/`, `docs/contracts.md` |
| Operator UI | `feat/operator-ui` | `web/` |

What this branch adds on top of `environment-and-safe-navigation`:
- `abyss-sim/sim/plan_mode.py`: `plan.json` → waypoints. numpy only.
- `abyss-sim/tests/test_plan_mode.py`: 12 tests against the decision layer's example plan.
- `fishfarm_demo.py --plan`. Also: one HOCBF filter per ROV, labels sized to each photo's distance, turn-taking, multiple shots, `target_id` in captures and `plan_status.json`.
- `scripts/run_cluster.sh`: `RUNS=plan`.
- A fix: `holes_in_view[]` now carries `cell`, as the capture contract requires. Without it, the stand-in grader rejected every sweep photo with a hole in view.

**Status:**
- **Checked on a laptop:** the plan logic (tests), and the loop at the contract level. Fake plan-run photo records went through the stand-in grader and the importer. Missions closed, a confirmed opening left the plan, and a one-view opening came back as a two-robot target.
- **Never run inside Isaac Sim.** Section 4 is the checklist for the first GPU run.

## 2. Setup

**GPU machine** (Isaac Sim 5.1, RTX-class GPU; see `abyss-sim/README.md`):
```bash
git fetch origin && git checkout feat/sim-plan-mode
cd abyss-sim
```

**Decision layer** (Node 24 or later; a laptop, or the cluster if it has Node):
```bash
git worktree add ../shoal-decision feat/decision-layer     # or a second clone
cd ../shoal-decision/decision-layer && npm install && npm test
```
Model keys are optional. Without them the decision layer uses its stated fallback rules, and the plan doesn't depend on models.

**Laptop tests for plan mode** (no Isaac Sim needed):
```bash
cd abyss-sim && uv run --with numpy --with pytest pytest tests     # or: pip install numpy pytest && pytest tests
```

## 3. Running the loop

Run the decision-layer commands from `decision-layer/`. Run the sim commands from `abyss-sim/` on the GPU machine.

```bash
# 1. GPU: the sweep (HOCBF on). Writes ~/abyss_out/run_hero/{captures.jsonl, ground_truth.json, auv_*/img_*.png}
RUNS=hero ./scripts/run_cluster.sh

# 2. Decision layer: grade, rank, plan
scp -r "<cluster>:~/abyss_out/run_hero" .
npm run stand-in-vision -- run_hero          # until the real detector writes vision.jsonl
npm run cli -- import run_hero
npm run cli -- plan --out plan.json          # also prints the targets and why
scp plan.json "<cluster>:~/plan.json"

# 3. GPU: act on the plan. Keep OBST, BANDS and EXTRA the same as the sweep, so the scene matches
RUNS=plan PLAN=~/plan.json PLAN_FLAGS="--plan-revisits 1 --plan-coverage 24" ./scripts/run_cluster.sh

# 4. Decision layer: close the missions and plan again
scp -r "<cluster>:~/abyss_out/run_plan" .
npm run stand-in-vision -- run_plan && npm run cli -- import run_plan
npm run cli -- missions                      # confirmed / clear / needs another look
npm run cli -- plan                          # what is still unsure comes back, escalated
```

- **Scene:** ropes and net defects come from fixed seeds (`--defect-seed 7`, obstacle seed 3) and from `--standoff`, `--bands` and `--obstacles`. Change any of them between the sweep and the plan run, and the plan points at the wrong places.
- **Isaac pen = UI Pen 7.** Set `ISAAC_PEN` in the decision layer to change it.
- **`npm run cli -- reset`** clears the decision layer's missions and observations for a fresh loop.
- **Other flags:** `--plan-revisits N` and `--plan-coverage N` are optional. `--wp-timeout S` defaults to 40 s in plan mode (a guess, see section 4).
- **A plan without the HOCBF** works too (`--plan` without `--safe-nav`): the PD controller flies the waypoints, and margins are ignored.

## 4. Checklist for the first GPU run

1. **Do close-ups still see the defect?** This is the most likely failure. A 4 m sweep photo covers about 4.7 × 2.6 m and credits a hole anywhere in it to its centre cell. A 1.15 m close-up aimed at that cell's centre covers about 1.3 × 0.75 m. Check `run_plan/captures.jsonl`: do the target photos have `holes_in_view`? If they don't, the mission closes as "clear" by mistake. Ways to fix it:
   - the sweep credits each hole to the hole's own cell, not the photo's;
   - the decision layer asks for a wider first close-up;
   - the plan carries the detection's position (`bbox`) so the close-up can aim at it.
2. **Do the robots reach the spots?** Check `run_plan/nav_summary.json`: contacts should be 0. Then check `plan_status.json`: timeouts per target, and viewpoints blocked by a rope. A timeout still takes the photo, flagged `timeout: true`.
3. **Turn-taking:** the log shows `[plan] auv_1: waiting for auv_0 to finish target m1`, then `... is free, going in`. A waiting robot holds where it is. If that's next to the other robot's target, it may get in the way. If so, move the waiting robot back towards the centre.
4. **Margins:** the filter's margin ramps to each target's `margin_m` (`plan_mode.ramp_margin`). Look for long red-arrow stretches (filter active) near the net in `rec_plan/abyss_section.mp4`.
5. **Timeout:** tune `--wp-timeout` from the real transit times.
6. **The videos** in `rec_plan/` should show robots going to specific spots instead of sweeping. That's the demo moment.

## 5. Building on top

| Next | Where | Note |
|---|---|---|
| Real image pipeline | new, writes `vision.jsonl` | Contract: `contracts/vision-report.schema.json` on `feat/decision-layer`. Write one line per image, including images with no detections. Join on `image` |
| Show why a robot goes where it goes | `tools/make_video.py` | Draw each target's cell and its `reasons[].text` (rules P1–P6) from `plan.json` into the overlay |
| One robot confirms an opening | `decision-layer/src/inspection.ts`, `assessCell` | Today a view = one robot on one run, so P1 needs two robots. Captures now carry `viewpoint`. Counting it as a view would let one robot confirm |
| Fewer copies between machines | sim + `decision-layer/src/server.ts` | Run the decision layer on the cluster, or fetch `GET /api/plan?pen=7&robots=3` through an SSH tunnel to port 8787 |
| Fix the close-up footprint issue | see section 4, item 1 | |

**Rules for changes:**
- **Only grid cells cross between the sim and the decision layer, never metres.** The grid is 24 × 8, `cell = row * 24 + col`.
- **Keep `plan_mode.py` numpy-only and tested on a laptop.** Only the Isaac glue stays in `fishfarm_demo.py`.
- **Keep the scene identical** between a sweep and the plan run made from it.
