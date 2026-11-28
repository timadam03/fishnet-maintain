# Closed loop: the robots act on the decision layer

**Update 2026-11-28 (late): every step below now runs end to end on the GPU box (real detector, d1 grader, one-command loop with video). Current state, how to run and next steps: [`CLAUDE.md`](../CLAUDE.md). The status table below is from before that.**

Status: direction set 2026-11-28. This is the story the demo tells now. It replaces the oxygen-led
beats in `docs/demo-spec.md` §1 (branch `feat/decision-layer`). The seams between the parts are specified in
`docs/contracts.md` (branch `feat/decision-layer`, which predates plan mode: where the two differ, this doc wins); this doc says what the loop is, what exists and what is still missing.

## The loop

```
 1. PERCEIVE          2. DETECT              3. DECIDE                    4. ACT
 Isaac Sim sweep  ──▶ image pipeline     ──▶ decision layer           ──▶ Isaac Sim guided run
 quick pass over      thin twine, fouling,   grade each area, rank it,    robots fly to the ranked areas:
 the whole net        holes, per image       turn the top ones into a     closer, from more angles, more
 captures.jsonl       vision.jsonl           plan with missions           shots, two robots on a likely hole
                                             plan.json                    captures.jsonl with target_id
        ▲                                                                         │
        └──── 5. LEARN: the new photos go through 2 and 3 again; missions close ◀─┘
              (confirmed, clear, needs another look), and the next plan escalates what is still unsure
```

1. **Perceive.** The robots do one quick coverage sweep of the net at a normal distance (`--standoff`, 4 m by default).
2. **Detect.** The image pipeline grades every photo: class (`hole`, `mesh_opening`, `thinning`, `biofouling`, ...), confidence and image quality. Photos where it found nothing count too: they are the evidence that clears an area.
3. **Decide.** The decision layer joins the photos with where each was taken and grades each net area. It ranks the areas (rules P1–P6, G1 and S1 in `contracts.md`) and writes an inspection plan. Each target says where to go, how close, from which angles, how many shots, with which robots and with what safety margin.
4. **Act.** The robots fly the plan. This is how the intelligence layer changes how the robots behave: they stop sweeping evenly and spend their time on the areas the decision layer ranked.
5. **Learn.** The new photos go back through steps 2 and 3. Each mission closes with a result. A "possible opening" seen once comes back in the next plan as a two-robot confirmation. A confirmed hole leaves the plan, because it needs a repair, not more robot time.

**What "act" means in this demo:** the robots re-task their inspection. They go somewhere else, closer, from another angle, for more shots or with a second robot. Repairs, cleaning and farm actions stay recommendations that a person approves, as in the decision layer README.

## After the close-ups: does a person need to look? (`decision-layer/src/escalate.ts`)

Commands, demo run and troubleshooting: [`escalation.md`](escalation.md).

```
 close-ups back ─▶ d1 #2 per closed mission ─▶ critical ──▶ report agent drafts a report ─▶ engineer: approve / edit / reject
 (mission closed)   critical? engineer?       human review ─▶ review card with the photos ─┘
                    photos enough?            re-inspect (max 2 missions per cell), monitor, closed
                                                         │
     every reviewed case ─▶ export-cases (tagged FARM_ID) ─▶ other farms: import-cases
       photos + detector output + d1 #1/#2 answers + engineer verdict + draft and final report
```

1. **d1 #2** (`npm run cli -- escalate <run_dir> --grader d1`). One d1 call per closed mission, on that mission's own close-ups, with four yes/no questions: `critical` (fish could escape, or repair within 24 h), `needs_human`, `sufficient` (enough to plan a repair) and `recurring`. Code sets the thresholds (`decideFromAnswers`). d1 can raise a case to an engineer, but it can't close an opening the rules confirmed from two viewpoints: that always reaches a person. Without a key, or if d1 fails, the rules decide (`decideByRules`) and the reason says so.
2. **Report agent** (`report.ts`, `AGENT_MODEL`). Only for critical cases. Code writes the facts (decision, location, d1 answers, size, photos and detector overlays); the agent writes the summary, what the robots saw, open questions and the recommended action, and anything else it sends is dropped. Without an agent model the report is a template and says so. Reports go to `<run_dir>/reports/case_<n>_m<id>.md`.
3. **Engineer** (`review`, or `POST /api/escalations/:case/review` for the dashboard). `approve` = real defect, `edit <file>` = real, with the engineer's own report, `reject` = false alarm. Engineers can also review a case that closed without them: that is a missed defect, the most useful label.
4. **Multi-farm data** (`export-cases`, `import-cases`). One JSONL line per case. Imported cases do two things here: d1 #2 sees how engineers judged earlier cases the rules called the same thing ("5 reviewed, 4 real"), and the report agent gets the engineers' latest corrections of drafts as examples. The same files are the training set for a better detector (photos with engineer labels) and for the report writer (draft vs final). `review` prints how often engineers agreed with the escalation.

The case library survives `reset` (each case is keyed on farm, sim run and mission, so new runs never collide with old cases); `forget-cases` clears it.

## What exists and what is missing

| Step | Where | Status |
|---|---|---|
| 1. Sweep | `abyss-sim/sim/fishfarm_demo.py` on branch `environment-and-safe-navigation` | **Works.** Three ROVs fly a coverage plan of waypoints (PD control + HOCBF safety filter), photograph each one, and write `captures.jsonl` and `ground_truth.json` |
| 2. Detect | real pipeline: not in the repo | **Stand-in only.** `decision-layer/scripts/stand-in-vision.ts` fakes reports from Isaac's ground truth. The real detector has to write `vision.jsonl` (contract §2) |
| 3. Decide | `decision-layer/src/inspection.ts` | **Works.** `import` reads captures and reports, and `plan` writes `plan.json`. Missions close when photos with their `target_id` come back |
| 4. Act | `fishfarm_demo.py --plan`, `sim/plan_mode.py` on branch `feat/sim-plan-mode` | **Built, not yet run on a GPU.** The sim reads `plan.json` and flies the targets. Each photo carries `target_id` |
| 5. Learn | decision layer | **Works.** Checked with fake plan-run photo records (no Isaac): missions closed, a confirmed opening left the plan, and a one-view opening came back as a two-robot P1 target |

**The robots didn't need to learn to move.** They already flew to arbitrary waypoints: `plans[k]` is a list of `{pos, yaw, theta, z, band}`, and `target(k)` hands the current one to the controller. What was missing was a **plan mode**: turning `plan.json` into those waypoints, with per-target distance, angles, shots and safety margin, and tagging the photos.

## Plan mode in the sim (branch `feat/sim-plan-mode`)

Decided 2026-11-28: the robots inspect from **inside** the pen. The "other perspective" can come from one robot, ideally from different viewpoints.

How a plan run flies (details in `abyss-sim/README.md` on that branch):

- **Where:** one waypoint per viewpoint, `standoff_m` from the net, depth clamped inside the wall. The ropes are placed exactly as in the sweep, so the scene matches the plan.
- **Other perspectives:** the camera aims at the cell centre, so an offset viewpoint sees the same spot from another angle. A one-robot target (P4's ±8°) is flown from every viewpoint by that robot.
- **Two robots:** each takes one viewpoint, and they take turns on the target. Side by side at P1's 1.55 m standoff they'd be 1.348 m apart, inside the 1.35 m each keeps from the other, so they'd block each other. Two robots are kept for P1 because the decision layer counts a view as one robot on one run (`inspection.ts`, `assessCell`). Photos from one robot alone can't confirm an opening.
- **Closer and safer:** `shots` photos per waypoint. `margin_m` is that robot's HOCBF inflation (one filter per ROV now), raised only as far as the robot already clears.
- **Observe more often:** besides going closer with more shots, `--plan-revisits N` flies the targets N more times, spread through `--plan-coverage N` cells of ordinary sweep. Each new plan also keeps a target until it's cleared.
- **Photo records** carry `target_id`, the plan's `cell` (an offset viewpoint can sit over the next cell), `viewpoint`, `visit` and `plan_id`. Ground-truth labels use each photo's own distance from the net.
- **`plan_status.json`** lists the photos per target and robot, timeouts, and viewpoints blocked by a rope.
- **`WP_TIMEOUT`** is 40 s in plan mode, a starting value to tune on the GPU.

Laptop tests: `abyss-sim/tests/test_plan_mode.py` (12, against `contracts/example-run/plan.json`). To run it on the GPU: `RUNS=plan PLAN=~/plan.json ./scripts/run_cluster.sh`.

**First thing to check on the GPU:** whether a close-up still sees the defect. A 4 m sweep photo covers about 4.7 × 2.6 m of net, but a cell is about 2.1 × 1.0 m, and a hole anywhere in the photo is credited to the photo's centre cell. A 1.15 m close-up aimed at that cell's centre sees only about 1.3 × 0.75 m, so the hole can be outside it, and the mission would then close as "clear". The fake-record check couldn't show this, because it put the hole in view by construction.

**Not checked yet:** anything inside Isaac Sim. That covers the robots reaching close-up spots under the filter, the margin ramp, the turn-taking, multiple shots and timeouts. Also open: a waiting robot holds where it is, and if that spot is near the other robot's target, it may get in the way.

**Nice to have:** draw the target and its reason in the video overlay (`tools/make_video.py`), so the judges see why a robot goes where it goes.

## Open decisions

1. **Can one robot confirm an opening?** Today it takes two robots. If one robot's two viewpoints should be enough, the decision layer must count `viewpoint` from the photo records as a separate view.
2. **The real image pipeline:** who writes `vision.jsonl`, and from which model.
3. **How files travel between the GPU machine and this laptop:** copy the files with `scp` and run the `import` and `plan` commands, or let the sim call `GET /api/plan` through an SSH tunnel to port 8787.
