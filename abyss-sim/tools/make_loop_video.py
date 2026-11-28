"""
make_loop_video.py -- one video of the whole closed loop: far survey, what the detector found, what
the decision layer chose, the robots flying in for the close-ups, and what they concluded.

    python abyss-sim/tools/make_loop_video.py <loop_dir> --grader rules [--view grid] [--db shoal.db]

Reads (all written by run_loop.ps1 -Record):
    <loop_dir>/rec_sweep/abyss_<view>.mp4              the far survey (make_video.py)
    <loop_dir>/rec_plan_<grader>/abyss_<view>.mp4      the plan run: the ROVs going in close
    <loop_dir>/run_sweep/vision.jsonl                  detector output on the survey photos
    <loop_dir>/run_sweep/plan_<grader>.json            the plan
    --db shoal.db                                      mission results (run right after the loop,
                                                       before the next loop resets the database)
    <loop_dir>/run_plan_<grader>/score.txt             the ground-truth score, if present
Writes  <loop_dir>/abyss_loop_<grader>.mp4

Needs numpy + Pillow (Isaac Sim's python has both) and ffmpeg, found the same way as make_video.py.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_video import VIEW_FILE, find_ffmpeg, font  # noqa: E402

BG, FG, DIM, ACCENT = (8, 22, 30), (235, 242, 245), (150, 175, 185), (80, 200, 255)
GOOD, BAD, WARN = (90, 220, 130), (255, 95, 80), (255, 200, 70)


def video_size(ffmpeg, path):
    """(width, height, fps) of a video, from ffmpeg's own description of it."""
    err = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    m = re.search(r"Video:.*?(\d{3,5})x(\d{3,5})", err)
    f = re.search(r"([\d.]+) fps", err)
    if not m:
        sys.exit(f"can't read the size of {path}")
    return int(m.group(1)), int(m.group(2)), float(f.group(1)) if f else 30.0


def mono(size):
    """A fixed-width font, so the plan and score tables line up (Consolas on Windows)."""
    for n in ("DejaVuSansMono.ttf", "consola.ttf", "cour.ttf"):
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            pass
    return font(size)


def card(path, size, title, lines, step=None, table=False):
    """A title card: step label, heading, then lines of (text, colour); `table` = fixed-width body."""
    W, H = size
    s = H / 1080
    img = Image.new("RGB", size, BG)
    d = ImageDraw.Draw(img)
    x, y = int(110 * s), int(110 * s)
    if step:
        d.text((x, y), step, font=font(int(34 * s), True), fill=ACCENT)
        y += int(60 * s)
    d.text((x, y), title, font=font(int(62 * s), True), fill=FG)
    y += int(110 * s)
    body = mono(int(27 * s)) if table else font(int(31 * s))
    for text, colour in lines:
        if y > H - 90 * s:
            d.text((x, y), "...", font=body, fill=DIM)
            break
        d.text((x, y), text, font=body, fill=colour)
        y += int(46 * s)
    d.text((x, H - int(70 * s)), "Abyss - closed-loop net inspection (Isaac Sim)", font=font(int(24 * s)), fill=DIM)
    img.save(path)


def short(text, n):
    return text if len(text) <= n else text[: n - 3] + "..."


def detector_lines(run_sweep):
    path = os.path.join(run_sweep, "vision.jsonl")
    if not os.path.isfile(path):
        return [("(no vision.jsonl)", DIM)]
    reports = [json.loads(l) for l in open(path) if l.strip()]
    counts, cells = {}, set()
    for r in reports:
        for d in r["detections"]:
            counts[d["class"]] = counts.get(d["class"], 0) + 1
        cells.update(r.get("cells_in_view") or [])
    q = [min(r["quality"]["visibility"], r["quality"]["sharpness"]) for r in reports if r.get("quality")]
    names = {"hole": "holes", "mesh_opening": "possible openings", "thinning": "thinning", "biofouling": "fouling"}
    found = ", ".join(f"{n} {names.get(c, c)}" for c, n in sorted(counts.items(), key=lambda kv: -kv[1]))
    return [
        (f"{len(reports)} far photos covering {len(cells) or '?'} of 192 net cells", FG),
        (f"Found: {found or 'nothing'}", FG),
        (f"Image quality: mean {sum(q) / len(q):.2f}" if q else "Image quality: not reported", DIM),
        ("", FG),
        ("Each detection is placed on its own net cell from its pixel position,", DIM),
        ("then handed to the decision layer, which grades every cell.", DIM),
    ]


def plan_lines(plan):
    out = []
    for t in plan["targets"]:
        rules = "+".join(r["rule"] for r in t["reasons"][1:])
        why = next((r["text"] for r in t["reasons"][1:] if r["rule"] not in ("D1",)), t["reasons"][-1]["text"])
        colour = WARN if t["priority_label"] == "high" else FG
        out.append((f"{t['target_id']:>4}  cell {t['cell']:3d}  {t['priority_label']:6s}  AUV {'+'.join(map(str, t['robots'])):5s}"
                    f"  {t['scan']['standoff_m']:4} m  {rules:8s} {short(why, 52)}", colour))
    return out or [("No targets: nothing worth a closer look.", DIM)]


def mission_lines(db, plan):
    ids = {t["mission_id"] for t in plan["targets"]}
    if not db or not os.path.isfile(db):
        return [("(mission results: pass --db shoal.db right after the loop)", DIM)]
    con = sqlite3.connect(db)
    rows = con.execute("SELECT id, cells_json, status, result FROM missions ORDER BY id").fetchall()
    out = []
    for mid, cells, status, result in rows:
        if mid not in ids:
            continue
        cell = json.loads(cells)[0]
        res = result or status
        colour = BAD if res.startswith(("confirmed: opening", "possible opening")) else WARN if res.startswith("confirmed: wear") \
            else GOOD if res.startswith("clear") else DIM
        out.append((f"  m{mid:<3d} cell {cell:3d}  {short(res, 88)}", colour))
    return out or [("(no results for this plan's missions in the database: was it reset by a later loop?)", DIM)]


def score_lines(path):
    if not os.path.isfile(path):
        return []
    lines = [l.rstrip() for l in open(path, encoding="utf-8", errors="replace")]
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith("plan ") and "targets" in l)
    except StopIteration:
        return []
    return [("Against the simulator's ground truth:", DIM)] + [(l, FG) for l in lines[start:start + 4] if l]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("loop_dir")
    ap.add_argument("--grader", default="rules")
    ap.add_argument("--view", default="grid", choices=sorted(VIEW_FILE))
    ap.add_argument("--db", default=None)
    ap.add_argument("--card-seconds", type=float, default=6.0)
    ap.add_argument("--plan-speed", type=float, default=1.0, help="speed up the plan run (2 = twice as fast)")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("ffmpeg not found (pip install imageio-ffmpeg)")
    loop = os.path.abspath(args.loop_dir)
    sweep_mp4 = os.path.join(loop, "rec_sweep", VIEW_FILE[args.view])
    plan_mp4 = os.path.join(loop, f"rec_plan_{args.grader}", VIEW_FILE[args.view])
    plan_json = os.path.join(loop, "run_sweep", f"plan_{args.grader}.json")
    for p in (sweep_mp4, plan_mp4, plan_json):
        if not os.path.isfile(p):
            sys.exit(f"missing {p} (run run_loop.ps1 with -Record, and make_video.py on both rec_ folders)")
    plan = json.load(open(plan_json))
    W, H, fps = video_size(ffmpeg, sweep_mp4)
    grader = "d1 decision model" if args.grader == "d1" else "plan rules"

    tmp = tempfile.mkdtemp(prefix="abyss_loop_")
    c = [os.path.join(tmp, f"card{i}.png") for i in range(5)]
    card(c[0], (W, H), "Far survey of the whole net", [
        ("Three ROVs hold station near the centre of the pen and turn,", FG),
        ("photographing the net wall from about 6.5 m away.", FG),
        ("Cheap and fast, but small defects are hard to judge from this far.", DIM),
    ], step="STEP 1 / 4")
    card(c[1], (W, H), "Detector on the survey photos", detector_lines(os.path.join(loop, "run_sweep")), step="STEP 2 / 4")
    card(c[2], (W, H), f"Decision layer ({grader}): {len(plan['targets'])} targets", plan_lines(plan), step="STEP 3 / 4", table=True)
    card(c[3], (W, H), "The ROVs go in close", [
        ("Each target: 1.2-1.6 m from the net, from the side(s) the plan asks for.", FG),
        ("Possible holes get two ROVs and two viewpoints; the HOCBF filter keeps", FG),
        ("each ROV off the net and the ropes with the target's own safety margin.", FG),
    ], step="STEP 4 / 4")
    results = os.path.join(loop, f"run_plan_{args.grader}")
    card(c[4], (W, H), "What the close-ups showed", mission_lines(args.db, plan) + [("", FG)] + score_lines(os.path.join(results, "score.txt")),
         step="RESULT", table=True)

    # card, video, card, card, card, video, card
    parts = [("img", c[0]), ("vid", sweep_mp4, 1.0), ("img", c[1]), ("img", c[2]), ("img", c[3]),
             ("vid", plan_mp4, args.plan_speed), ("img", c[4])]
    cmd, chains = [ffmpeg, "-y", "-loglevel", "error"], []
    for i, p in enumerate(parts):
        if p[0] == "img":
            secs = args.card_seconds * (1.6 if p[1] in (c[2], c[4]) else 1.0)   # longer for the lists
            cmd += ["-loop", "1", "-framerate", f"{fps}", "-t", f"{secs}", "-i", p[1]]
            speed = 1.0
        else:
            cmd += ["-i", p[1]]
            speed = p[2]
        chains.append(f"[{i}:v]setpts=PTS/{speed},scale={W}:{H}:force_original_aspect_ratio=decrease,"
                      f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p[v{i}]")
    graph = ";".join(chains) + ";" + "".join(f"[v{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=0[out]"
    out = os.path.join(loop, f"abyss_loop_{args.grader}.mp4")
    cmd += ["-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", out]
    print(f"[loop video] sweep + plan run ({args.grader}) with title cards -> {out}")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        sys.exit("ffmpeg failed")
    print(f"[loop video] wrote {out}")


if __name__ == "__main__":
    main()
