"""
make_align_video.py -- footage of the close-ups, one at a time, in the operator UI's look.

    python make_align_video.py <rec_dir> <run_dir> --plan plan.json [--db shoal.db] [--font IBMPlexSans.ttf]

<rec_dir> is the --record folder of a plan run (demo,auv0,auv1,auv2), <run_dir> its --out folder,
after the detector (run_vision.py) and, for the result lines, the decision-layer import. Each
segment is one robot on one target: it flies in, the picture holds on every look the sim took with
what the detector saw, and ends on the photo and what the mission concluded. "Simulator truth" is
the sim's ground truth, shown so the result can be judged; the robots never see it.
Needs numpy, Pillow and ffmpeg (or imageio-ffmpeg).
"""
import argparse
import json
import math
import os
import sqlite3
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "sim"))
from align import CENTRE_U, CENTRE_V  # noqa: E402
from make_video import find_ffmpeg, font as system_font  # noqa: E402

# The operator UI's "paper and ink" tokens (web/src/lib/tokens.ts on feat/operator-ui).
PAGE, PAPER, INK, INK2, INK3 = "#f4f4f2", "#ffffff", "#1d1d1b", "#3e3e3b", "#62615d"
LINE, LIVE, ELEVATED, HIGH, CRITICAL = "#e4e4e2", "#3c7a3c", "#d9a3c3", "#b95a93", "#6f2068"
SEA = "#93a7ad"                                          # the 3D view's water

W, H, PANEL_X = 1920, 1080, 1396
CAM = (24, 24, 1348, 758)                                # x, y, width, height of the robot camera
OVERVIEW = (24, 806, 444, 250)
CARD = (492, 806, 880, 250)
HOLD_S, END_S, LEAD_S = 1.6, 4.0, 5.0
CLASS_NAMES = {"hole": "Hole", "mesh_opening": "Possible opening", "thinning": "Thinning", "biofouling": "Fouling"}


class Fonts:
    def __init__(self, path):
        self.path, self.cache = path, {}

    def __call__(self, size, weight="Regular"):
        if (size, weight) not in self.cache:
            if self.path:
                f = ImageFont.truetype(self.path, size)
                f.set_variation_by_name(weight)
            else:
                f = system_font(size, weight != "Regular")
            self.cache[(size, weight)] = f
        return self.cache[(size, weight)]


def wrap(d, text, f, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and d.textlength(trial, font=f) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + [line]


def pill(d, x, y, text, f, dot=None):
    width = d.textlength(text, font=f) + 32 + (22 if dot else 0)
    d.rounded_rectangle([x, y, x + width, y + 40], radius=20, fill=PAPER, outline=LINE)
    if dot:
        d.ellipse([x + 16, y + 14, x + 28, y + 26], fill=dot)
    d.text((x + 16 + (22 if dot else 0), y + 20), text, font=f, fill=INK, anchor="lm")


def look_text(look):
    """(colour, short text) for one look at a frame."""
    if look["action"] == "move":
        why = "Off centre" if look["seen"] else "Nothing seen"
        return HIGH, f"{why}, move {look['moves']}"
    return {"aligned": (LIVE, "Centred, photo taken"),
            "not_seen": (CRITICAL, "Centred, nothing detected"),
            "off_centre": (CRITICAL, "Could not centre")}[look["status"]]


def offset_text(offset):
    return "-" if offset is None else f"{abs(offset[0]) * 100:.0f}% across, {abs(offset[1]) * 100:.0f}% up/down"


def truth_text(target, gt):
    """What the sim really put where the robot aimed."""
    aim, grid = target.get("aim"), gt["grid"]
    if not aim:
        return "-"
    r = grid["cage_radius_m"]
    theta, z = math.radians(aim["theta_deg"]), -aim["depth_frac"] * grid["cage_depth_m"]
    found = []
    for key, name in (("holes", "hole"), ("thin_patches", "thinned twine"), ("foul_patches", "fouling")):
        for p in gt[key]:
            if math.hypot(r * math.remainder(theta - p["theta"], 2 * math.pi), z - p["z"]) <= p["radius"] + 0.2:
                found.append(f"{name} {p['radius'] * 2:.2f} m across" if name == "hole" else name)
    return ", ".join(dict.fromkeys(found)) or "intact net"


def panel(d, fonts, seg, shown, result):
    x, right = PANEL_X + 32, W - 32
    d.rectangle([PANEL_X, 0, W, H], fill=PAPER)
    d.line([PANEL_X, 0, PANEL_X, H], fill=LINE, width=2)
    d.text((x, 28), f"Site A  ›  Pen {seg['pen']}  ›  Close-up {seg['n']} of {seg['of']}", font=fonts(18), fill=INK3)
    d.line([PANEL_X, 68, W, 68], fill=LINE)
    d.text((x, 90), f"Mission {seg['target']['target_id'][1:]}, AUV-{seg['auv']}", font=fonts(32, "SemiBold"), fill=INK)
    y = 138
    for line in wrap(d, seg["target"]["reasons"][0]["text"], fonts(19), right - x):
        d.text((x, y), line, font=fonts(19), fill=INK2)
        y += 28
    for line in wrap(d, seg["target"]["reasons"][1]["text"], fonts(19), right - x)[:3]:
        d.text((x, y), line, font=fonts(19), fill=INK2)
        y += 28

    last = shown[-1] if shown else None
    y += 16
    d.line([PANEL_X, y, W, y], fill=LINE)
    y += 18
    rows = [("Distance from net", f"{last['range_m']:.2f} m" if last else "-"),
            ("Off centre by", offset_text(last["offset"]) if last else "-"),
            ("Corrections", str(last["moves"]) if last else "-"),
            ("Detector", f"{CLASS_NAMES.get(last['class'], last['class'])}, p={last['confidence']:.2f}"
             if last and last["class"] else ("nothing" if last else "-"))]
    for name, value in rows:
        d.text((x, y), name, font=fonts(19), fill=INK3)
        d.text((right, y), value, font=fonts(19), fill=INK, anchor="ra")
        y += 34

    y += 12
    d.line([PANEL_X, y, W, y], fill=LINE)
    d.text((x, y + 18), "Looks", font=fonts(20, "SemiBold"), fill=INK)
    y += 56
    for i, look in enumerate(shown):
        colour, text = look_text(look)
        d.ellipse([x, y + 5, x + 12, y + 17], fill=colour)
        d.text((x + 24, y), f"{i + 1}.  {text}", font=fonts(19), fill=INK2)
        y += 31

    y = 700
    d.line([PANEL_X, y, W, y], fill=LINE)
    d.text((x, y + 18), "Mission result", font=fonts(20, "SemiBold"), fill=INK)
    y += 56
    for line in wrap(d, result or "after the photos are in", fonts(19), right - x):
        d.text((x, y), line, font=fonts(19), fill=INK if result else INK3)
        y += 28

    d.line([PANEL_X, 944, W, 944], fill=LINE)
    d.text((x, 962), "Simulator truth (the robots don't see this)", font=fonts(17), fill=INK3)
    for i, line in enumerate(wrap(d, seg["truth"], fonts(19), right - x)[:2]):
        d.text((x, 996 + i * 28), line, font=fonts(19), fill=INK2)


def compose(fonts, seg, camera, overview, t, shown, held, final=False, result=None):
    canvas = Image.new("RGB", (W, H), SEA)
    d = ImageDraw.Draw(canvas)
    cx, cy, cw, ch = CAM
    canvas.paste(camera.convert("RGB").resize((cw, ch)), (cx, cy))
    last = shown[-1] if shown else None
    colour = INK if last is None else look_text(last)[0]
    mx, my = cx + cw / 2, cy + ch / 2
    zone = [mx - CENTRE_U * cw / 2, my - CENTRE_V * ch / 2, mx + CENTRE_U * cw / 2, my + CENTRE_V * ch / 2]
    d.rounded_rectangle(zone, radius=14, outline=PAPER, width=6)
    d.rounded_rectangle([zone[0] + 2, zone[1] + 2, zone[2] - 2, zone[3] - 2], radius=12, outline=colour, width=3)
    d.line([mx - 12, my, mx + 12, my], fill=colour, width=3)
    d.line([mx, my - 12, mx, my + 12], fill=colour, width=3)
    if held and last and last["bbox"]:                       # only on the frame the detector looked at
        sx, sy = cw / camera.width, ch / camera.height
        bx, by, bw, bh = last["bbox"]
        box = [cx + bx * sx, cy + by * sy, cx + (bx + bw) * sx, cy + (by + bh) * sy]
        d.rounded_rectangle(box, radius=8, outline=CRITICAL, width=4)
        pill(d, min(box[0], cx + cw - 300), max(cy + 66, box[1] - 48),
             f"{CLASS_NAMES.get(last['class'], last['class'])}, p={last['confidence']:.2f}", fonts(19, "Medium"), CRITICAL)
    state = "photo" if final else ("flying in" if last is None else "lining up" if last["action"] == "move" else "photographing")
    pill(d, cx + 16, cy + 16, f"AUV-{seg['auv']}, {state}", fonts(19, "Medium"), LIVE)

    ox, oy, ow, oh = OVERVIEW
    canvas.paste(overview.convert("RGB").resize((ow, oh)), (ox, oy))
    pill(d, ox + 10, oy + 10, "Pen overview", fonts(17), None)

    kx, ky, kw, kh = CARD
    d.rounded_rectangle([kx, ky, kx + kw, ky + kh], radius=18, fill=PAPER, outline=LINE)
    d.text((kx + 28, ky + 24), "Close-up", font=fonts(24, "SemiBold"), fill=INK)
    d.text((kx + kw - 28, ky + 28), f"t = {t:.1f} s", font=fonts(18), fill=INK3, anchor="ra")
    step = 0 if last is None else 3 if final or last["action"] == "shoot" else 2
    names = ["Fly to the sighting", "Find it on camera", "Centre it at 2.2 m", "Take the photo"]
    x0, x1, line_y = kx + 90, kx + kw - 90, ky + 128
    d.line([x0, line_y, x1, line_y], fill=LINE, width=4)
    d.line([x0, line_y, x0 + (x1 - x0) * step / 3, line_y], fill=INK, width=4)
    for i, name in enumerate(names):
        px = x0 + (x1 - x0) * i / 3
        d.ellipse([px - 13, line_y - 13, px + 13, line_y + 13], fill=INK if i <= step else PAPER, outline=INK, width=3)
        d.text((px, line_y + 40), name, font=fonts(18, "Medium" if i == step else "Regular"),
               fill=INK if i <= step else INK3, anchor="ma")

    panel(d, fonts, seg, shown, result)
    return canvas


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("rec_dir")
    ap.add_argument("run_dir")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--db", default=None, help="decision-layer database, for the mission results")
    ap.add_argument("--font", default=None, help="IBM Plex Sans variable .ttf, as the operator UI uses")
    ap.add_argument("--all-views", action="store_true", help="every viewpoint, not only each robot's first per target")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    out = args.out or os.path.join(args.rec_dir, "closeups.mp4")

    def load(path):
        with open(path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def load_one(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    fps = load_one(os.path.join(args.rec_dir, "meta.json"))["fps"]
    frames = load(os.path.join(args.rec_dir, "telemetry.jsonl"))
    looks = load(os.path.join(args.run_dir, "align.jsonl"))
    gt = load_one(os.path.join(args.run_dir, "ground_truth.json"))
    plan = load_one(args.plan)
    targets = {t["target_id"]: t for t in plan["targets"]}
    captures = load(os.path.join(args.run_dir, "captures.jsonl"))
    results = {}
    if args.db:
        con = sqlite3.connect(args.db)
        results = {f"m{i}": r for i, r in con.execute("SELECT id, result FROM missions WHERE status = 'done'")}
        con.close()

    # One segment per run of looks that ends in a photo: one robot at one viewpoint.
    segments, open_looks, seen = [], {}, set()
    for look in looks:
        key = (look["auv"], look["target_id"])
        open_looks.setdefault(key, []).append(look)
        if look["action"] == "shoot":
            if args.all_views or key not in seen:
                segments.append(open_looks[key])
            seen.add(key)
            open_looks[key] = []
    segments.sort(key=lambda s: (int(s[0]["target_id"][1:]), s[0]["t"]))

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        sys.exit("ffmpeg not found (pip install imageio-ffmpeg)")
    fonts = Fonts(args.font)
    proc = subprocess.Popen([ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                             "-s", f"{W}x{H}", "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "22",
                             "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    written, stills = 0, []

    def emit(image, seconds):
        nonlocal written
        data = np.asarray(image, np.uint8).tobytes()
        for _ in range(max(1, int(round(seconds * fps)))):
            proc.stdin.write(data)
            written += 1

    def frame(cam, i):
        return Image.open(os.path.join(args.rec_dir, cam, f"{i:05d}.png"))

    previous_end = {}
    for n, group in enumerate(segments, 1):
        auv, tid = group[0]["auv"], group[0]["target_id"]
        seg = {"auv": auv, "target": targets[tid], "n": n, "of": len(segments), "pen": plan.get("pen_id", 7),
               "truth": truth_text(targets[tid], gt)}
        # Start a few seconds before the first look, but never inside this robot's previous segment.
        start = max(group[0]["t"] - LEAD_S, previous_end.get(auv, 0.0))
        previous_end[auv] = group[-1]["t"]
        pending, shown, rec = list(group), [], None
        for rec in frames:
            if rec["t"] < start:
                continue
            held = bool(pending) and pending[0]["t"] <= rec["t"]
            if held:
                shown.append(pending.pop(0))
            image = compose(fonts, seg, frame(f"auv{auv}", rec["i"]), frame("demo", rec["i"]), rec["t"], shown, held)
            emit(image, HOLD_S if held else 1 / fps)
            if not pending:
                break
        photo = next((c for c in captures if c["auv"] == auv and c.get("target_id") == tid
                      and c["sim_time"] >= group[-1]["t"] - 0.05), None)
        if photo:
            end = compose(fonts, seg, Image.open(os.path.join(args.run_dir, *photo["image"].split("/"))),
                          frame("demo", rec["i"]), photo["sim_time"], shown, True, True, results.get(tid))
            emit(end, END_S)
            stills.append(end.resize((640, 360)))

    proc.stdin.close()
    if proc.wait():
        sys.exit("ffmpeg failed")
    if stills:                                              # the last frame of every segment, to look over
        sheet = Image.new("RGB", (1920, 360 * math.ceil(len(stills) / 3)), PAGE)
        for i, still in enumerate(stills):
            sheet.paste(still, ((i % 3) * 640, (i // 3) * 360))
        sheet.save(os.path.splitext(out)[0] + "_sheet.png")
    print(f"[video] {out}  ({written / fps:.0f} s, {len(segments)} close-ups)")


if __name__ == "__main__":
    main()
