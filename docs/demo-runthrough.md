# Demo runthrough: the whole closed loop as one video

`abyss-sim/tools/make_runthrough.py` turns one loop folder (`run_loop.ps1 -Out`) into a single MP4
for the final demo. It shows nothing new; it packages the loop's own outputs, in order.

**Status (2026-11-28):** tested only on a synthetic loop folder with the same layout as a real
one, plus 6 unit tests (`abyss-sim/tests/test_runthrough.py`). It has not yet been rendered from a
real loop. The `-Runthrough` and `-RecordEvery` options of `run_loop.ps1` have not been run either.
Use the checklist in section 6 on the first real render.

## 1. What the video shows

Five chapters, each opening with a title card. A strip at the top (SWEEP > DETECT > DECIDE > ACT > RESULT) lights the current step.

| # | Chapter | What you see | Read from (inside the loop folder) |
|---|---|---|---|
| 1 | Sweep | The ROVs survey the whole net from a distance: overview, cutaway and the three ROV cameras | `rec_sweep\` |
| 2 | Classifier | Each photo is "processed": a scan line wipes from the raw photo to the detector's overlay plus a heat glow per detection, and lists each finding with its confidence and net cell. Beside it, a map of the net fills in: not looked at, looked and nothing found, or coloured by what was found | `run_sweep\` photos, `overlays\`, `vision.jsonl` |
| 3 | Decision layer | The ranked targets appear one by one on that map. Each card gives the priority, the area, the rule (P1-P6) with its reason, and the orders: which ROVs, how close, how many angles and shots, the safety margin | `run_sweep\plan_<grader>.json` |
| 4 | The robots act | The plan run, with the targets marked in the overview. A line and a caption show which target each ROV is heading to | `rec_plan_<grader>\`, `run_plan_<grader>\captures.jsonl` |
| 5 | Results | The best close-up per target, the photos per ROV, timeouts and blocked views, and what each mission concluded; then a summary with the next plan | `run_plan_<grader>\` overlays, `vision.jsonl`, `plan_status.json`, `next_plan.json`, `shoal.db` |

**Where the content comes from:**
- **Classifier chapter:** it draws what `vision.jsonl` reported, which is what the decision layer received. It never shows the sim's ground truth.
- **Photos shown there:** first, for each plan target, the sweep photo with the strongest detection on that target's cell. Then other photos with detections, spread over the run, and two where nothing was found. All photos still fill the net map, shown or not.
- **Which target a ROV is heading to:** the `target_id` of that ROV's next photo. The photo records and the telemetry share the sim clock (`fishfarm_demo.py`, `t = sim_t[0]`).

### Two loop videos

A loop run with `-Record` can produce two whole-loop videos in the loop folder. They come from the same outputs:

| File | Made by | When | What it is |
|---|---|---|---|
| `abyss_loop_<grader>.mp4` | `tools/make_loop_video.py` | Always with `-Record` | The two rendered run videos joined with text cards: detector counts, plan table, mission results, score |
| `runthrough_<grader>.mp4` | `tools/make_runthrough.py` (this guide) | With `-Runthrough`, or run by hand | The animated version: the classifier processing each photo, the net map filling in, targets appearing with their reasons, ROVs linked to their targets, close-ups per target |

## 2. Requirements

- **Software:** Python with numpy and Pillow (Isaac Sim's own `python.bat` has both), and ffmpeg. The script uses `ffmpeg` on `PATH`, or `imageio-ffmpeg` (`python.bat -m pip install imageio-ffmpeg`), the same as `make_video.py`. OpenCV is not needed.
- **A finished loop folder from `run_loop.ps1`.** Run it with `-Record` for the robot chapters. Without recordings, chapters 1 and 4 show the photos in the order they were taken.

## 3. Making the demo

**In one go,** as part of the loop:
```powershell
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\demo -Record -Runthrough
```
This writes `C:\abyss_out\demo\runthrough_rules.mp4`. With `-Grader d1` it shows the d1 plan run instead and writes `runthrough_d1.mp4`.

**Afterwards, or again with other settings,** on any finished loop folder:
```powershell
C:\isaacsim51\python.bat abyss-sim\tools\make_runthrough.py C:\abyss_out\demo --grader rules
```

**Quick checks** while tuning: render a couple of chapters at a lower resolution.
```powershell
C:\isaacsim51\python.bat abyss-sim\tools\make_runthrough.py C:\abyss_out\demo --chapters 2,3 --res 1280x720 --out C:\abyss_out\demo\check.mp4
```

**Loops made before this branch** have no database snapshot in `run_plan_<grader>\`. Point at the decision layer's database with `--db <repo>\shoal.db`. Results only show if that database still holds this loop's missions. Every loop starts with `reset`, which restarts the mission ids, so the script only uses a mission on the target's cell that was created before the plan. Anything else shows as "result not available".

## 4. Smoother robot video

The robot chapters play the recording at `--speed` (default 4x). The script reads the recording's frame rate from `meta.json` and picks frames to keep that speed. So:

| You want | Do |
|---|---|
| More recorded frames | `run_loop.ps1 ... -Record -RecordEvery 1` (60 fps instead of the default 30) |
| Smoother motion in the video | Lower `--speed` (slower, more frames per second of sim) and/or `--fps 60` |
| Every recorded frame used | `--speed` x recorded fps = `--fps`. For example, a 60 fps recording at `--speed 2 --fps 60`, or a 30 fps recording at `--speed 1 --fps 30` |
| A shorter video | Raise `--speed`. The robot chapters last as long as the run divided by `--speed` |

## 5. Options

| Option | Default | What it does |
|---|---|---|
| `--grader` | `rules` | Which plan run to show (`rules` or `d1`) |
| `--out` | `<loop>\runthrough_<grader>.mp4` | Output file |
| `--db` | none | Decision-layer database, if there is no `run_plan_<grader>\shoal.db` |
| `--res` | `1920x1080` | Video size |
| `--fps` | `30` | Video frame rate |
| `--crf` | `20` | x264 quality (lower = better, bigger) |
| `--speed` | `4` | Playback speed of the robot recordings |
| `--max-photos` | `16` | Photos processed on screen in the classifier chapter |
| `--wipe`, `--hold` | `0.6`, `0.9` s | How long the scan line takes, and how long each graded photo stays up |
| `--per-target`, `--decision-hold` | `1.2`, `6` s | Decision chapter: time per target appearing, then hold |
| `--max-targets` | `8` | Target cards listed (all targets still show on the map) |
| `--per-result-page` | `6` s | Results: 6 targets per page |
| `--chapters` | `1,2,3,4,5` | Which chapters to render |

## 6. Checklist for the first real render

1. **Inputs:** the first log line lists what was found: photos, graded photos, targets, plan-run photos, recordings yes/no, and the number of mission results with the database used. Check it before watching.
2. **Classifier chapter:**
   - The overlays should be the detector's own (`run_vision.py --overlays`). Without them, the script draws plain boxes.
   - Check how the heat glow looks on top of the overlays.
   - Check whether the net map gets crowded. Each cell shows its most serious class, so a low-confidence hole outranks a strong thinning.
3. **Decision chapter:** the area labels show dashes and degrees. If a font lacks a glyph, it shows as a box. Report it.
4. **Act chapter:**
   - The target circles should sit on the net in the overview.
   - Each ROV's line should point at the target it then photographs.
5. **Results:** every target should have a close-up and a result. "Result not available" means the database was missing, or was reset after this loop.

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ffmpeg not found -> frames in ...` | No ffmpeg. The frames are saved as PNGs, and the encode command is printed. Or install `imageio-ffmpeg` and render again |
| Slideshows instead of robot video | The loop ran without `-Record`, or `rec_*\meta.json` / `telemetry.jsonl` are missing |
| "No vision.jsonl in the sweep folder" | Run `python abyss-sim\tools\run_vision.py <loop>\run_sweep --overlays` |
| No plan-run chapter | The plan had no targets, so there was no plan run |
| "result not available" under every target | No snapshot and no `--db`, or the database belongs to a later loop |
| `no plan in ...plan_<grader>.json` | Wrong `--grader`, or the loop stopped before the decide step |

## 8. Changing it

- **Layout and colours** live at the top of `make_runthrough.py`: `CLASS_COLORS`, `PRIORITY_COLORS` and the chapter functions.
- **Robot chapter rendering:** they go through `make_video.compose`, so the overlays (HOCBF arrows, panel, ROV tiles) match the per-run videos.
- **Tests:** `uv run --with numpy --with pillow --with pytest pytest abyss-sim/tests`. Or, with pip: `pip install numpy pillow pytest` and `pytest abyss-sim/tests`.
