# Contracts: robots ⇄ image pipeline ⇄ decision layer

Status: 2026-11-27. Schemas: [`contracts/`](../contracts/). Code: [`decision-layer/src/contracts.ts`](../decision-layer/src/contracts.ts).
A runnable example run, with its plan, is in [`contracts/example-run/`](../contracts/example-run/).
What the loop is for, and what the sim still needs to act on a plan: [`closed-loop.md`](closed-loop.md).

```
Isaac sweep ──captures.jsonl──┐
                              ├──▶ decision layer ──plan.json──▶ Isaac guided run ──captures.jsonl──┐
image pipeline ──vision.jsonl─┘        ▲                                                            │
                                       └───────────── image pipeline ──vision.jsonl ◀───────────────┘
```

**Only grid positions cross the seams, never metres.** A cell is the operator UI's grid: 24 sectors of 15° × 8 wall rows, `cell = row * 24 + col`, row 0 at the surface, col 0 at 0°. Einar's `ui_cell()` already does this, and each side converts to its own pen size.

## 1. Isaac → decision layer: `captures.jsonl` (already written by `fishfarm_demo.py`)

One line per photo. Required fields:
- `image`, `run_id`, `auv`, `sim_time`, `theta_deg`, `depth`
- `position` `[x, y, z]`, used to work out the standoff
- `cell`

**One addition is needed:** `target_id` on every photo taken for a plan target (copy it from the plan). Without it, the photos can't close their mission.

Ground-truth fields (`holes_in_view`, `fouling_frac`, `thinning_frac`) are allowed. They are only for scoring models and for the stand-in grader, never for decisions. Schema: `contracts/capture.schema.json`.

## 2. Image pipeline → decision layer: `vision.jsonl`

One line per image, **including images with no detections**: "looked closely, nothing there" is the evidence that clears an area.

```json
{"image": "auv_1/img_0003.png", "model": "net-detector-v2",
 "quality": {"visibility": 0.62, "sharpness": 0.81},
 "fouling_pct": 0.35,
 "detections": [{"class": "mesh_opening", "confidence": 0.58, "bbox": [256, 144, 128, 72],
                 "severity": "low", "size_m": 0.2, "crop": "crops/img_0003_0.png"}],
 "heatmap": "heatmaps/img_0003.png"}
```

- **`image`** must match `captures.jsonl` so the two can be joined. For footage without a capture record (for example real camera frames), add `"where": {"pen_id": 7, "cell": 188}`.
- **`class`** is one of: `hole`, `mesh_opening`, `fraying`, `thinning`, `distortion`, `rope_contact`, `biofouling`, `other`.
- **`confidence`** is 0–1. The layer treats 0.3–0.7 as "unsure, look again" and ≥ 0.7 as "likely".
- **`quality`** is optional but valuable. Low visibility or sharpness makes the layer send a robot closer instead of trusting the image.
- **`offset`** is `[dx, dy]`: where the detection sits in the image, -1..1 from the centre, x right, y down. With it, the layer credits the detection to the area it is really in (a far photo spans about two areas) and aims the close-up at it.
- **`severity`** is a number 0–1, or `low` / `medium` / `high`.

### From the net classifier (`inspect_frame`)

`decision-layer/scripts/classifier_to_vision.py` runs the classifier on a whole run and writes `vision.jsonl`:

```bash
python decision-layer/scripts/classifier_to_vision.py <run_dir> --classifier <path/to/classifier.py>
```

It needs numpy and opencv, like the classifier. Sweep photos run in `survey` mode, and plan photos (those with a `target_id`) in `investigation` mode.

| Classifier output | In `vision.jsonl` |
|---|---|
| `type` `hole`, `thinning`, `biofouling` | Same class |
| `type` `unknown` from the width check (`evidence: apparent_width`) | `thinning`; its confidence is ≤ 0.82, so usually "unsure" |
| Any other `unknown` (opening-like, confidence ≤ 0.66) | `mesh_opening`, so "unsure, look closer" |
| `confidence`, `severity`, `bbox` | Copied |
| `dx`, `dy` | `offset` |
| Diagnostics: mesh openings found, area with a resolved mesh | `quality.sharpness` (40+ openings = 1), `quality.visibility` (60%+ of the image = 1) |
| Diagnostics: fouling mask | `fouling_pct` |
| Image name, model | From `captures.jsonl`; model `net-classifier-cv:survey` or `:investigation` |

**One trap it handles:** when the classifier can't find the mesh (murky or blurred), it returns no detections. That would read as "looked, nothing there" and clear the area. The adapter reports quality 0 for such images instead, so the layer sends a robot closer.

The classifier's own `recommended_action` and tracker are not used: the decision layer decides across photos, robots and history.

Schema: `contracts/vision-report.schema.json`.

## 3. Decision layer → Isaac: `plan.json`

Targets come best first. Each target says **where**, **how to look**, **how safely** and **who**:

| Field | Meaning | What Isaac does with it |
|---|---|---|
| `cell`, `theta_deg`, `depth_frac` | The area, and where the camera should look: the detection's position when a photo placed it (rule A1), otherwise the cell centre. Depth is a fraction of the wall depth | Aim at `theta_deg`; robot at `theta_deg + d_theta_deg`, `z = -(depth_frac + d_depth_frac) * CAGE_DEPTH` (plan mode already does this) |
| `scan.standoff_m` | Distance from the net for the photos | Waypoint radius `CAGE_R - standoff_m` |
| `scan.viewpoints` | One or more offsets; several means several angles | One waypoint per viewpoint, camera aimed at the cell centre |
| `scan.shots` | Photos per viewpoint | Repeat the capture |
| `safety.margin_m` | HOCBF margin while on this target | Use `margin_m` as this AUV's own HOCBF inflation while flying to and holding this target (one filter per AUV, raised only as far as the AUV already clears) |
| `robots` | Which AUVs do it; two means two perspectives | The viewpoints are shared out among the listed AUVs, which take turns on the target (side by side they'd block each other) |
| `target_id` | Ties photos to the mission | Copy into each capture record |
| `reasons` | Why the target is there (rules P1–P6, G1) | Show in the video overlay if useful |
| `coverage` | Remaining cells, stalest first | Sweep these after the targets if time allows |

The standoff is never smaller than `margin_m + 0.55` (rule S1), so every photo spot is reachable under the HOCBF margin.

**The plan rules** (all values are demo starting values):

| Rule | When | What the robots do |
|---|---|---|
| P1 | A possible opening (≥ 0.7) seen by one robot | Two robots, two sides (±6°), 2 shots, margin 1.0 m |
| P2 | Unsure (0.3–0.7) | Closer (1.0 m), 3 shots |
| P3 | Image too poor to judge | Closer (0.9 m) |
| P4 | Fouling ≥ 40% (can hide holes) | Two angles (±8°) |
| P5 | Wear sign ≥ 0.7 | Closer look, margin 0.9 m (weakened twine) |
| P6 | Risk model says high or critical | Close inspection, margin 0.8 m |
| G1 | Current ≥ 30 cm/s that day | +0.4 m margin on every target |
| A1 | The target comes from a detection with an `offset` | Aim at the detection's position instead of the area centre |
| M1 | Two targets aimed within about 0.4 m of each other (3°, 5% of depth), e.g. a hole and its thinning on an area boundary | One target: the higher-ranked one, with the larger margin |

**When the photos come back, the mission closes with a result:**
- confirmed opening: two views at ≥ 0.7
- possible opening: one view only, which the next plan escalates to P1
- wear sign
- clear: good images, nothing found
- needs another look

A confirmed opening leaves the plan, because it now needs a repair, not more robot time.

**Close-ups replace far photos as evidence.** Once an area has a close-up (≤ 1.8 m, quality ≥ 0.5), only the close-ups count. A far sweep photo that was unsure therefore stops pulling the area back into every plan after a careful close look finds nothing.

**Aiming.** A far photo covers about two areas. With `offset`, a detection near the photo's edge is credited to the area it is really in, and the close-up aims at it (A1), using Isaac's camera: 60.4° × 36.3° field of view, looking horizontally. Without `offset`, the close-up aims at the area centre and can miss a defect near the edge. Check the aiming on the first GPU run.

Schema: `contracts/inspection-plan.schema.json`.

## Running the loop

```bash
cd decision-layer
npm run stand-in-vision -- <run_dir>          # only until the real pipeline writes vision.jsonl
npm run cli -- import <run_dir>               # captures + vision → observations (Isaac pen = UI Pen 7)
npm run cli -- plan --out <run_dir>/plan.json # what the robots should do next
# Isaac: run again with --plan <run_dir>/plan.json, writing target_id into captures
#        (built on branch feat/sim-plan-mode, not yet run on a GPU; see closed-loop.md)
npm run cli -- import <run2_dir>              # closes the missions with results
npm run cli -- missions                       # see what was confirmed or cleared
npm run cli -- plan                           # the next plan escalates what's still unsure
```

**Over HTTP**, with `npm run serve`:
- `POST /api/observations` with `{pen_id, captures, reports, grid?}`, where `grid` is the object from `ground_truth.json`
- `GET /api/plan?pen=7&robots=3`

**Notes:**
- **One importer.** `decision-layer/src/inspection.ts` is the only importer. Einar's earlier `ingest.ts` is not used; its grid check now lives here. Before anything is stored, an import is refused if the run's grid (`ground_truth.json` → `grid.ui_sectors`, `grid.ui_wall_rows`) isn't 24 × 8.
- **Isaac pen = UI Pen 7** (the sag case). Set `ISAAC_PEN` to change it.
- **The stand-in grader** (`scripts/stand-in-vision.ts`) turns Isaac's ground truth into reports using a simple camera model, tuned to Isaac's default 4 m sweep. From 4 m, images are usable but small holes and thinning come out unsure; the plan's 1–1.5 m close-ups make them likely. Fouling hides holes. Use it to test the loop; its output is labelled `stand-in-ground-truth` and is not a detection.

## Validating from Python

```python
import json, jsonschema
schema = json.load(open("contracts/vision-report.schema.json"))
for line in open("vision.jsonl"):
    jsonschema.validate(json.loads(line), schema)
```
