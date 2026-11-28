"""
make_demo.py -- the two-minute demo of one loop, in the operator UI's look.

    python make_demo.py <loop_dir> [--grader rules] [--font IBMPlexSans.ttf] [--out demo.mp4]

<loop_dir> holds run_sweep/ (with vision.jsonl and plan_<grader>.json), run_plan_<grader>/ (with
vision.jsonl, align.jsonl and shoal.db after the import and `escalate`), rec_sweep/ and
rec_plan_<grader>/ (fishfarm_demo.py --record; demo and ROV cameras, the sweep also section).

Five stages: Survey, Detect, Rank, Inspect, Escalate. Everything shown is the loop's own output;
the sim's ground truth is never used. Needs numpy, Pillow and ffmpeg.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "sim"))
import make_runthrough as mr  # noqa: E402  inputs, photo choice, the video writer
import make_video as mv  # noqa: E402  the demo camera's projection
from align import CENTRE_U, CENTRE_V  # noqa: E402
from make_align_video import (CRITICAL, ELEVATED, HIGH, INK, INK2, INK3, LINE, LIVE, PAGE, PAPER,  # noqa: E402
                              CLASS_NAMES, Fonts, pill, wrap)

W, H, TOP = 1920, 1080, 132
STAGES = ["Survey", "Detect", "Rank", "Inspect", "Escalate"]
CLASS_COLOUR = {"hole": CRITICAL, "mesh_opening": HIGH, "thinning": ELEVATED, "biofouling": "#89957f"}
SEEN, UNSEEN = "#dde3e4", "#f4f4f2"


class Video:
    """The writer, with a short cross-fade whenever a new scene starts."""

    def __init__(self, writer, fps):
        self.out, self.fps, self.last, self.fade_from, self.fade_i = writer, fps, None, None, 0
        self.fade_n = int(0.35 * fps)

    def cut(self):
        self.fade_from, self.fade_i = self.last, 0

    def frame(self, img):
        if self.fade_from is not None and self.fade_i < self.fade_n:
            self.fade_i += 1
            img = Image.blend(self.fade_from, img, self.fade_i / self.fade_n)
        self.out.add(img)
        self.last = img

    def hold(self, img, seconds):
        for _ in range(max(1, int(round(seconds * self.fps)))):
            self.frame(img)

    def n(self, seconds):
        return max(1, int(round(seconds * self.fps)))


# ------------------------------------------------------------------------------------- pieces
def screen(f, stage, caption, note=""):
    """A page with the header: where we are in the loop, and what is happening in one sentence."""
    img = Image.new("RGB", (W, H), PAGE)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, TOP - 12], fill=PAPER)
    d.line([0, TOP - 12, W, TOP - 12], fill=LINE, width=2)
    d.text((32, 16), "Site A  ›  Pen 7", font=f(19), fill=INK3)
    d.text((32, 58), caption, font=f(32, "SemiBold"), fill=INK)
    x = W - 32
    for i in range(len(STAGES) - 1, -1, -1):
        name = STAGES[i]
        width = d.textlength(name, font=f(19, "Medium")) + 36
        x -= width
        d.rounded_rectangle([x, 12, x + width, 50], radius=19, fill=INK if i == stage else PAPER,
                            outline=INK if i <= stage else LINE, width=2)
        d.text((x + width / 2, 31), name, font=f(19, "Medium"),
               fill=PAPER if i == stage else INK if i < stage else INK3, anchor="mm")
        x -= 12
    if note:
        d.text((W - 32, 80), note, font=f(19), fill=INK3, anchor="ra")
    return img


def card(img, box):
    ImageDraw.Draw(img).rounded_rectangle(box, radius=18, fill=PAPER, outline=LINE, width=2)


def place(img, picture, box, radius=16):
    """`picture` scaled into box (x, y, w, h) with rounded corners."""
    x, y, w, h = box
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    img.paste(picture.convert("RGB").resize((w, h), Image.BILINEAR), (x, y), mask)


def boxes(img, f, detections, box, source, label=True):
    """Detections (pixel boxes in a `source`-sized photo) drawn on the photo shown at box."""
    x, y, w, h = box
    d = ImageDraw.Draw(img)
    sx, sy = w / source[0], h / source[1]
    placed = []
    strongest = {d_["class"]: d_ for d_ in sorted(detections, key=lambda v: v["confidence"])}
    for det in sorted(detections, key=lambda v: v["confidence"]):
        bx, by, bw, bh = det["bbox"]
        r = [x + bx * sx, y + by * sy, x + (bx + bw) * sx, y + (by + bh) * sy]
        colour = CLASS_COLOUR.get(det["class"], HIGH)
        d.rounded_rectangle(r, radius=8, outline=colour, width=4 if w > 600 else 2)
        if label and det is strongest[det["class"]]:
            text = f"{CLASS_NAMES.get(det['class'], det['class'])}, p={det['confidence']:.2f}"
            ly = max(y + 8, r[1] - 46)
            while any(abs(ly - py) < 44 and abs(r[0] - px) < 260 for px, py in placed):
                ly += 44
            lx = min(r[0], x + w - 290)
            pill(d, lx, ly, text, f(18, "Medium"), colour)
            placed.append((r[0], ly))


def net_map(img, f, box, seen, found, targets=(), highlight=()):
    """The net wall unrolled, 24 sectors by 8 rows, as the decision layer sees it."""
    x, y, w, h = box
    d = ImageDraw.Draw(img)
    cw, ch = w / 24, h / 8

    def rect(cell, grow=0.0):
        row, col = divmod(cell, 24)
        return [x + col * cw + 2 - grow, y + row * ch + 2 - grow, x + (col + 1) * cw - 2 + grow, y + (row + 1) * ch - 2 + grow]

    for cell in range(192):
        classes = found.get(cell)
        fill = CLASS_COLOUR.get(mr.worst_class(classes), HIGH) if classes else SEEN if cell in seen else UNSEEN
        d.rounded_rectangle(rect(cell), radius=4, fill=fill, outline=None if cell in seen or classes else LINE)
    for cell in highlight:
        d.rounded_rectangle(rect(cell, 3), radius=6, outline=INK, width=3)
    for number, cell in targets:
        d.rounded_rectangle(rect(cell, 3), radius=6, outline=INK, width=3)
        r = rect(cell)
        d.ellipse([r[2] - 13, r[1] - 15, r[2] + 15, r[1] + 13], fill=INK)
        d.text((r[2] + 1, r[1] - 1), str(number), font=f(16, "SemiBold"), fill=PAPER, anchor="mm")
    for deg in (0, 90, 180, 270, 360):
        d.text((x + w * deg / 360, y + h + 10), f"{deg}°", font=f(16), fill=INK3, anchor="ma")
    d.text((x, y - 28), "Surface", font=f(16), fill=INK3)
    d.text((x, y + h + 34), "Bottom of the net wall, unrolled", font=f(16), fill=INK3)


def legend(img, f, x, y):
    d = ImageDraw.Draw(img)
    for name, colour in (("Hole", CRITICAL), ("Possible opening", HIGH), ("Thinning", ELEVATED),
                         ("Fouling", CLASS_COLOUR["biofouling"]), ("Nothing found", SEEN)):
        d.rounded_rectangle([x, y + 3, x + 18, y + 21], radius=4, fill=colour)
        d.text((x + 28, y), name, font=f(18), fill=INK2)
        x += 56 + d.textlength(name, font=f(18))


def rec_frame(rec, cam, i):
    """A recorded frame. The renderer sometimes drops the scene from one (a flat picture): hold the
    last good one over it."""
    for j in range(i, max(0, i - 30), -1):
        path = os.path.join(rec.path, cam, f"{j:05d}.png")
        if os.path.isfile(path):
            img = Image.open(path).convert("RGB")
            if np.asarray(img.resize((64, 36)).convert("L")).std() >= 4:
                return img
    return Image.open(os.path.join(rec.path, cam, f"{i:05d}.png")).convert("RGB")


# ------------------------------------------------------------------------------------- stages
def intro(v, f, rec, run, seconds):
    """The title card over the moving orbit view. It plays the end of the survey recording, after the
    last photo, which the Survey stage doesn't show."""
    n = v.n(seconds)
    after = max(c["sim_time"] for c in run.captures) + 1.0
    first = next((i for i, r in enumerate(rec.recs) if r["t"] >= after), len(rec.recs))
    first = max(0, min(first, len(rec.recs) - n))                  # enough frames to fill the intro
    for k in range(n):
        r = rec.recs[min(len(rec.recs) - 1, first + int(k * rec.meta["fps"] / v.fps))]     # at 1x
        img = rec_frame(rec, "demo", r["i"]).resize((W, H))
        d = ImageDraw.Draw(img)
        card(img, [90, 640, 1130, 980])
        d.text((140, 690), "Autonomous net inspection", font=f(60, "SemiBold"), fill=INK)
        d.text((140, 790), "Three small underwater robots check a fish-farm pen,", font=f(28), fill=INK2)
        d.text((140, 832), "decide where to look closer, and call an engineer when it matters.", font=f(28), fill=INK2)
        d.text((140, 908), "Survey  →  Detect  →  Rank  →  Inspect  →  Escalate", font=f(24, "Medium"), fill=HIGH)
        v.frame(img)


def survey(v, f, rec, run, speed):
    v.cut()
    # The recording runs on after the last photo: stop there, and play at `speed` x.
    last = max(c["sim_time"] for c in run.captures) + 1.0
    flown = [r for r in rec.recs if r["t"] <= last]
    n = v.n((flown[-1]["t"] - flown[0]["t"]) / speed)
    for k in range(n):
        r = flown[min(len(flown) - 1, int(k * len(flown) / n))]
        img = screen(f, 0, "The robots survey the whole net from a distance", f"{r['t']:.0f} s of flight, shown at {speed:g}x")
        place(img, rec_frame(rec, "demo", r["i"]), (24, 144, 1232, 693))
        place(img, rec_frame(rec, "section", r["i"]), (1280, 144, 616, 346))
        d = ImageDraw.Draw(img)
        pill(d, 40, 160, "Pen overview", f(18), None)
        pill(d, 1296, 160, "Cutaway", f(18), None)
        for a in range(3):
            x = 24 + a * 416
            place(img, rec_frame(rec, f"auv{a}", r["i"]), (x, 853, 400, 213))
            pill(d, x + 10, 863, f"ROV {a + 1}", f(17, "Medium"), LIVE)
        card(img, [1280, 506, 1896, 1066])
        d.text((1316, 540), "Survey", font=f(28, "SemiBold"), fill=INK)
        taken = sum(rov["shots"] for rov in r["rov"])
        clearance = min(rov["min_clr"] for rov in r["rov"])
        for j, (name, value) in enumerate((("Robots", "3"), ("Photos taken", f"{taken} of {len(run.captures)}"),
                                           ("Closest any robot has come", f"{clearance:.2f} m"),
                                           ("Collisions", str(sum(rov["contacts"] for rov in r["rov"]))))):
            y = 610 + j * 62
            d.text((1316, y), name, font=f(22), fill=INK3)
            d.text((1860, y), value, font=f(22, "Medium"), fill=INK, anchor="ra")
            d.line([1316, y + 42, 1860, y + 42], fill=LINE)
        d.text((1316, 880), "Ropes hang through the pen; a safety filter", font=f(20), fill=INK3)
        d.text((1316, 910), "keeps every robot clear of them and each other.", font=f(20), fill=INK3)
        v.frame(img)


def detect(v, f, run, plan, seconds):
    """Photos go through the detector while the net map fills in. Returns (seen, found)."""
    v.cut()
    reports = [run.vision.get(c["image"]) for c in run.captures]
    shown = mr.pick_photos(reports, plan, 9)
    each = (seconds - 2.0) / max(1, len(shown))
    seen, found, done = set(), {}, 0

    def add(report):
        seen.update(report.get("cells_in_view") or [])
        for det in report.get("detections", []):
            if "cell" in det:
                seen.add(det["cell"])
                found.setdefault(det["cell"], set()).add(det["class"])

    def page(photo, report, wipe, graded):
        img = screen(f, 1, "Every photo is checked for holes, thin twine and fouling",
                     f"{graded} of {len(reports)} photos checked")
        box = (24, 144, 1180, 664)
        place(img, photo, box)
        d = ImageDraw.Draw(img)
        if wipe >= 1 and report:
            boxes(img, f, report.get("detections", []), box, photo.size)
        elif wipe < 1:
            x = box[0] + int(box[2] * wipe)
            d.line([x, box[1], x, box[1] + box[3]], fill=PAPER, width=6)
        card(img, [24, 828, 1204, 1066])
        dets = (report or {}).get("detections", [])
        names = []
        for cls in dict.fromkeys(x["class"] for x in sorted(dets, key=lambda v: -v["confidence"])):
            same = [x["confidence"] for x in dets if x["class"] == cls]
            many = f" in {len(same)} places" if len(same) > 1 else ""
            names.append(f"{CLASS_NAMES.get(cls, cls)}{many} (p={max(same):.2f})")
        d.text((60, 862), "This photo", font=f(24, "SemiBold"), fill=INK)
        text = "Checking..." if wipe < 1 else ", ".join(names) if names else "Nothing found. That counts too: these areas are cleared."
        for j, line in enumerate(wrap(d, text, f(22), 1100)[:3]):
            d.text((60, 912 + j * 36), line, font=f(22), fill=INK2)
        card(img, [1228, 144, 1896, 1066])
        d.text((1264, 176), "What was found, by area of the net", font=f(24, "SemiBold"), fill=INK)
        net_map(img, f, (1264, 262, 596, 400), seen, found,
                highlight=[x["cell"] for x in report.get("detections", []) if "cell" in x] if report and wipe >= 1 else ())
        d.rectangle([1264, 760, 1860, 761], fill=LINE)
        y = 790
        for cls in ("hole", "mesh_opening", "thinning", "biofouling"):
            cells = sum(cls in c for c in found.values())
            d.rounded_rectangle([1264, y + 4, 1284, y + 24], radius=4, fill=CLASS_COLOUR[cls])
            d.text((1300, y), CLASS_NAMES[cls], font=f(22), fill=INK2)
            d.text((1860, y), f"{cells} area{'s' if cells != 1 else ''}", font=f(22, "Medium"), fill=INK, anchor="ra")
            y += 52
        return img

    for i, (cap, report) in enumerate(zip(run.captures, reports)):
        if report is None:
            continue
        if i not in shown:
            add(report)
            done += 1
            continue
        photo = Image.open(run.image(cap["image"])).convert("RGB")
        wipe_n = v.n(each * 0.3)
        for k in range(wipe_n):
            v.frame(page(photo, report, (k + 1) / (wipe_n + 1), done))
        add(report)
        done += 1
        last = page(photo, report, 1, done)
        v.hold(last, each * 0.7)
    v.hold(page(photo, report, 1, done), 2.0)
    return seen, found


REASON = {"P1": "Possible opening: confirm from two sides", "P2": "Unsure: look closer", "P3": "Photo too poor: look closer",
          "P4": "Fouling may hide a hole", "P5": "Wear sign: look closer", "P6": "High risk from history", "D1": "Graded by d1"}


def area_of(t):
    text = next((r["text"] for r in t["reasons"] if r["rule"] == "area"), f"cell {t['cell']}")
    return re.sub(r"\s*\(cell \d+\)", "", text)


def rank(v, f, plan, seen, found, seconds):
    v.cut()
    targets = plan["targets"]
    each = (seconds - 3.5) / max(1, len(targets))

    def page(k):
        img = screen(f, 2, "The decision layer ranks what needs a closer look, and plans each visit",
                     f"{len(targets)} targets, best first")
        d = ImageDraw.Draw(img)
        card(img, [24, 144, 880, 1066])
        d.text((60, 176), "Where to send the robots", font=f(24, "SemiBold"), fill=INK)
        net_map(img, f, (60, 262, 784, 520), seen, found, targets=[(n, t["cell"]) for n, t in enumerate(targets[:k], 1)])
        legend_y = 880
        d.text((60, legend_y), "Each visit says how close, from how many sides,", font=f(22), fill=INK3)
        d.text((60, legend_y + 34), "which robots go, and how much room to keep.", font=f(22), fill=INK3)
        card(img, [904, 144, 1896, 1066])
        for n, t in enumerate(targets[:k], 1):
            y = 160 + (n - 1) * 89
            rule = next((r["rule"] for r in t["reasons"] if r["rule"] != "area"), "")
            d.ellipse([932, y + 20, 976, y + 64], fill=INK)
            d.text((954, y + 42), str(n), font=f(20, "SemiBold"), fill=PAPER, anchor="mm")
            d.text((1000, y + 12), REASON.get(rule, rule), font=f(23, "Medium"), fill=INK)
            robots = " and ".join(f"ROV {a + 1}" for a in t["robots"])
            d.text((1000, y + 48), f"{area_of(t)}   ·   {robots}", font=f(19), fill=INK3)
            label = {"high": "High", "normal": "Normal", "low": "Low"}[t["priority_label"]]
            colour = {"high": CRITICAL, "normal": HIGH, "low": ELEVATED}[t["priority_label"]]
            pill(d, 1730, y + 20, label, f(18, "Medium"), colour)
            if n < len(targets):
                d.line([932, y + 86, 1868, y + 86], fill=LINE)
        return img

    for k in range(1, len(targets) + 1):
        v.hold(page(k), each)
    v.hold(page(len(targets)), 3.5)


def flight(v, f, rec, run, plan, grid, seconds):
    """The ROVs leaving for their targets, marked in the overview."""
    v.cut()
    overlay = mr.PlanOverlay(plan, run, grid, rec.meta)
    first = min(c["sim_time"] for c in run.captures)
    usable = [r for r in rec.recs if r["t"] <= first + 4.0]
    n = v.n(seconds)
    box = (160, 144, 1600, 900)
    for k in range(n):
        r = usable[min(len(usable) - 1, int(k * len(usable) / n))]
        img = screen(f, 3, "The robots fly to the ranked targets", "sped up")
        place(img, rec_frame(rec, "demo", r["i"]), box)
        d = ImageDraw.Draw(img)
        cam = mv.view_cam(rec.meta, r, "demo", box[2], box[3])

        def at(p):
            q = cam.project(np.asarray(p, float))
            if q is None or not (20 < q[0] < box[2] - 20 and 20 < q[1] < box[3] - 20):
                return None
            return box[0] + q[0], box[1] + q[1]

        for tid, target in overlay.targets.items():
            p = at(overlay.point(target.get("aim") or target))
            if p:
                d.ellipse([p[0] - 18, p[1] - 18, p[0] + 18, p[1] + 18], fill=INK, outline=PAPER, width=3)
                d.text(p, str(overlay.order[tid]), font=f(17, "SemiBold"), fill=PAPER, anchor="mm")
        for a, rov in enumerate(r["rov"]):
            tid = overlay.heading(a, r["t"])
            p = at(rov["pos"])
            if p:
                where = f"to target {overlay.order[tid]}" if tid in overlay.targets else "done"
                pill(d, p[0] + 16, p[1] - 56 - a * 6, f"ROV {a + 1}, {where}", f(18, "Medium"), LIVE)
        v.frame(img)


def segments_of(looks):
    """(auv, target_id) -> that robot's looks at its first viewpoint of the target."""
    out, done = {}, set()
    for look in looks:
        key = (look["auv"], look["target_id"])
        if key in done:
            continue
        out.setdefault(key, []).append(look)
        if look["action"] == "shoot":
            done.add(key)
    return {k: s for k, s in out.items() if k in done}


def close_up(v, f, rec, run, target, number, auv, looks, caption):
    """One robot lining up on one target: approach, each look it took, the photo."""
    v.cut()
    tid = target["target_id"]
    photo_cap = next(c for c in run.captures
                     if c["auv"] == auv and c.get("target_id") == tid and c["sim_time"] >= looks[-1]["t"] - 0.05)
    start = looks[0]["t"] - 4.0
    speed, pause, end = 1.2, 1.3, 2.4          # flying shown at 1.2x; each look and the photo held

    def page(picture, source, shown, boxed, final):
        img = screen(f, 3, caption, f"Target {number} of the ranking")
        box = (24, 144, 1380, 776)
        place(img, picture, box)
        d = ImageDraw.Draw(img)
        last = shown[-1] if shown else None
        state, colour = ("Flying to where the survey saw it", INK) if last is None else \
            (("Off centre: correcting" if last["seen"] else "Nothing seen yet: moving to check"), HIGH) if last["action"] == "move" else \
            (("Nothing there on a closer look", INK3) if last["status"] != "aligned" else
             (f"Centred, but the detector is unsure (p={last['confidence']:.2f})", HIGH) if last["confidence"] < 0.7 else
             ("Centred at 2.2 m: photo taken", LIVE))
        mx, my = box[0] + box[2] / 2, box[1] + box[3] / 2
        zone = [mx - CENTRE_U * box[2] / 2, my - CENTRE_V * box[3] / 2, mx + CENTRE_U * box[2] / 2, my + CENTRE_V * box[3] / 2]
        d.rounded_rectangle(zone, radius=14, outline=PAPER, width=7)
        d.rounded_rectangle([zone[0] + 2, zone[1] + 2, zone[2] - 2, zone[3] - 2], radius=12, outline=colour, width=3)
        if boxed and last and last["bbox"]:
            boxes(img, f, [{"bbox": last["bbox"], "class": last["class"], "confidence": last["confidence"]}], box, source)
        pill(d, 40, 160, f"ROV {auv + 1}", f(20, "Medium"), LIVE)

        card(img, [24, 940, 1404, 1066])
        d.ellipse([64, 989, 92, 1017], fill=colour)
        d.text((116, 1003), state, font=f(34, "SemiBold"), fill=INK, anchor="lm")

        card(img, [1428, 144, 1896, 1066])
        d.text((1464, 176), "Lining up", font=f(28, "SemiBold"), fill=INK)
        rows = (("Distance from net", f"{last['range_m']:.2f} m" if last else "-"),
                ("Off centre", f"{max(abs(o) for o in last['offset']) * 100:.0f}%" if last and last["offset"] else "-"),
                ("Corrections", str(last["moves"]) if last else "-"),
                ("Detector", f"p={last['confidence']:.2f}" if last and last["confidence"] else "nothing" if last else "-"))
        y = 240
        for name, value in rows:
            d.text((1464, y), name, font=f(21), fill=INK3)
            d.text((1860, y), value, font=f(21, "Medium"), fill=INK, anchor="ra")
            d.line([1464, y + 40, 1860, y + 40], fill=LINE)
            y += 60
        y += 30
        d.text((1464, y), "The rule", font=f(24, "SemiBold"), fill=INK)
        for j, line in enumerate(("No photo is accepted until the", "defect is inside the box, seen", "from the right distance.")):
            d.text((1464, y + 46 + j * 32), line, font=f(21), fill=INK2)
        if final:
            y += 200
            d.text((1464, y), "Photo", font=f(24, "SemiBold"), fill=INK)
            names = [f"{CLASS_NAMES.get(x['class'], x['class'])}, p={x['confidence']:.2f}"
                     for x in (run.vision.get(photo_cap["image"]) or {}).get("detections", [])]
            for j, line in enumerate(names[:3] or ["Nothing detected"]):
                d.text((1464, y + 46 + j * 32), line, font=f(21), fill=INK2)
        return img

    def play(t0, t1, shown):
        length = min(3.5, (t1 - t0) / speed)              # a long way round is hurried a little
        span = [r for r in rec.recs if t0 <= r["t"] <= t1] or [min(rec.recs, key=lambda r: abs(r["t"] - t1))]
        n = v.n(length)
        for k in range(n):
            r = span[min(len(span) - 1, int(k * len(span) / n))]
            pic = rec_frame(rec, f"auv{auv}", r["i"])
            v.frame(page(pic, pic.size, shown, False, False))

    play(start, looks[0]["t"], [])
    for i, look in enumerate(looks):
        if i:
            play(looks[i - 1]["t"], look["t"], looks[:i])
        r = next((r for r in rec.recs if r["t"] >= look["t"]), rec.recs[-1])
        pic = rec_frame(rec, f"auv{auv}", r["i"])
        v.hold(page(pic, pic.size, looks[:i + 1], True, False), pause)
    pic = Image.open(run.image(photo_cap["image"])).convert("RGB")
    v.hold(page(pic, pic.size, looks, True, True), end)


def mission_rows(plan, db):
    """Per target: what the mission concluded and where escalation sent it."""
    con = sqlite3.connect(f"file:{os.path.abspath(db)}?mode=ro".replace("\\", "/"), uri=True)
    try:
        rows = []
        for n, t in enumerate(plan["targets"], 1):
            m = con.execute("SELECT result FROM missions WHERE id = ?", (t["mission_id"],)).fetchone()
            e = con.execute("SELECT decision, decided_by, evidence_json, report_md, report_by FROM escalations "
                            "WHERE mission_id = ? AND source = 'local' ORDER BY id DESC LIMIT 1", (t["mission_id"],)).fetchone()
            if not (m and e):
                sys.exit(f"mission {t['mission_id']} has no result or no escalation: import the plan run and run `escalate`")
            rows.append({"n": n, "target": t, "result": m[0] or "", "decision": e[0], "by": e[1],
                         "evidence": json.loads(e[2]), "report": e[3] or "", "report_by": e[4] or ""})
        return rows
    finally:
        con.close()


def short_result(result):
    r = result.split(" | ")[0]
    if r.startswith("confirmed: opening"):
        return "Opening, seen from two sides"
    if r.startswith("possible opening"):
        return "Possible opening, one view"
    if r.startswith("confirmed: wear"):
        return "Wear on the twine"
    if r.startswith("not found again"):
        return "Not found again"
    if r.startswith("not conclusive"):
        return "Detector is unsure"
    if r.startswith("not inspected"):
        return "Could not frame it"
    return r[:34]


# name, fill, text colour
VERDICT = {"critical": ("Critical", CRITICAL, PAPER), "human_review": ("Engineer review", HIGH, PAPER),
           "reinspect": ("Look again", ELEVATED, INK), "monitor": ("Monitor", ELEVATED, INK),
           "auto_close": ("Dismissed", LINE, INK2)}


def verdicts(v, f, run, rows, seconds):
    v.cut()
    tiles = []
    for row in rows:
        best = row["evidence"][0] if row["evidence"] else None
        tile = None
        if best:
            tile = Image.open(run.image(best["image"])).convert("RGB")
            report = run.vision.get(best["image"]) or {}
            canvas = tile.resize((344, 194))
            boxes(canvas, f, [x for x in report.get("detections", []) if x["class"] != "biofouling"],
                  (0, 0, 344, 194), tile.size, label=False)
            tile = canvas
        tiles.append(tile)

    def page(k):
        by = "the rules" if all(r["by"] == "rules" for r in rows) else "d1"
        img = screen(f, 4, "After each visit, only what needs a person goes to one", f"decided by {by}")
        d = ImageDraw.Draw(img)
        for i, row in enumerate(rows):
            x, y = 24 + (i % 5) * 376, 144 + (i // 5) * 392
            card(img, [x, y, x + 368, y + 376])
            if tiles[i]:
                place(img, tiles[i], (x + 12, y + 12, 344, 194), 10)
            d.text((x + 20, y + 224), f"{row['n']}.  {short_result(row['result'])}", font=f(20, "Medium"), fill=INK)
            d.text((x + 20, y + 260), area_of(row["target"]), font=f(17), fill=INK3)
            if i < k:
                name, colour, ink = VERDICT[row["decision"]]
                d.rounded_rectangle([x + 20, y + 306, x + 348, y + 354], radius=24, fill=colour)
                d.text((x + 184, y + 330), name, font=f(21, "SemiBold"), fill=ink, anchor="mm")
        card(img, [24, 940, 1896, 1066])
        for j, (key, text, colour) in enumerate((("critical", "critical", CRITICAL), ("human_review", "to review", HIGH),
                                                 ("monitor", "monitored", INK), ("auto_close", "dismissed", INK3))):
            x = 120 + j * 460
            d.text((x, 1003), str(sum(r["decision"] == key for r in rows[:k])), font=f(56, "SemiBold"), fill=colour, anchor="lm")
            d.text((x + 70, 1003), text, font=f(28), fill=INK2, anchor="lm")
        return img

    each = (seconds - 5.5) / len(rows)
    v.hold(page(0), 1.0)
    for k in range(1, len(rows) + 1):
        v.hold(page(k), each)
    v.hold(page(len(rows)), 4.5)


def report_screen(v, f, run, rows, seconds):
    row = next((r for r in rows if r["decision"] == "critical"), next((r for r in rows if r["decision"] == "human_review"), None))
    if row is None:
        return
    v.cut()
    img = screen(f, 4, "A critical finding arrives as a report with photos, ready for the engineer",
                 "template report" if row["report_by"] == "template" else f"drafted by {row['report_by']}")
    d = ImageDraw.Draw(img)
    card(img, [160, 156, 1760, 1056])
    name, colour, ink = VERDICT[row["decision"]]
    d.rounded_rectangle([210, 196, 410, 240], radius=22, fill=colour)
    d.text((310, 218), name, font=f(21, "SemiBold"), fill=ink, anchor="mm")
    d.text((210, 270), "Net defect: engineer action needed", font=f(40, "SemiBold"), fill=INK)
    size = re.search(r"about ([\d.]+) m across", row["report"])
    facts = [("Where", f"Pen 7, {area_of(row['target'])}"), ("What", short_result(row["result"])),
             ("Estimated size", f"about {size.group(1)} m across" if size else "not measured"),
             ("Seen by", " and ".join(f"ROV {a + 1}" for a in sorted({e['auv'] for e in row['evidence'] if e['auv'] is not None})))]
    for j, (key, value) in enumerate(facts):
        y = 350 + j * 52
        d.text((210, y), key, font=f(23), fill=INK3)
        d.text((460, y), value, font=f(23, "Medium"), fill=INK)
        d.line([210, y + 38, 1710, y + 38], fill=LINE)
    chosen, robots = [], set()
    for e in row["evidence"]:                       # one photo from each robot
        if e["auv"] not in robots:
            robots.add(e["auv"])
            chosen.append(e)
    for j, e in enumerate(chosen[:2]):
        x = 210 + j * 560
        photo = Image.open(run.image(e["image"])).convert("RGB")
        place(img, photo, (x, 572, 540, 304), 12)
        boxes(img, f, [x_ for x_ in (run.vision.get(e["image"]) or {}).get("detections", []) if x_["class"] in ("hole", "mesh_opening")],
              (x, 572, 540, 304), photo.size, label=False)
        d.text((x, 890), f"ROV {e['auv'] + 1}, {e['standoffM'] or 2.2:.1f} m from the net", font=f(19), fill=INK3)
    for j, (label, dark) in enumerate((("Approve", True), ("Edit", False), ("Reject", False))):
        x = 210 + j * 210
        d.rounded_rectangle([x, 950, x + 190, 1010], radius=14, fill=INK if dark else PAPER, outline=INK, width=2)
        d.text((x + 95, 980), label, font=f(24, "Medium"), fill=PAPER if dark else INK, anchor="mm")
    d.text((870, 980), "The engineer's verdict is recorded with the case.", font=f(22), fill=INK3, anchor="lm")
    v.hold(img, seconds)


def outro(v, f, run, plan, rows, seconds):
    v.cut()
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    critical = sum(r["decision"] == "critical" for r in rows)
    review = sum(r["decision"] == "human_review" for r in rows)
    person = critical + review
    d.text((W / 2, 230), "One loop, no one in the water", font=f(54, "SemiBold"), fill=INK, anchor="mm")
    d.text((W / 2, 320), f"An engineer looks at {person} of {len(rows)} suspected spots. The robots handled the other {len(rows) - person}.",
           font=f(30), fill=INK2, anchor="mm")
    steps = [(str(len(run.captures)), "survey photos"), (str(len(rows)), "ranked targets"),
             (str(person), "need an engineer"), (str(len(rows) - person), "monitored or dismissed")]
    for j, (value, label) in enumerate(steps):
        x = 300 + j * 440
        d.text((x, 540), value, font=f(110, "SemiBold"), fill=CRITICAL if j == 2 else INK, anchor="mm")
        d.text((x, 650), label, font=f(26), fill=INK3, anchor="mm")
    d.text((W / 2, 900), "Simulated in Isaac Sim", font=f(22), fill=INK3, anchor="mm")
    v.hold(img, seconds)


# ------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("loop_dir")
    ap.add_argument("--grader", default="rules")
    ap.add_argument("--font", default=None, help="IBM Plex Sans variable .ttf, as the operator UI uses")
    ap.add_argument("--featured", default="m1,m2,m4",
                    help="targets whose close-up is shown in full: a correction, a clean one, one not found again")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    loop = os.path.abspath(args.loop_dir)
    sweep = mr.Run(os.path.join(loop, "run_sweep"))
    run = mr.Run(os.path.join(loop, f"run_plan_{args.grader}"))
    plan = mr.read_json(os.path.join(sweep.path, f"plan_{args.grader}.json"))
    rec_sweep = mr.Recording.open(os.path.join(loop, "rec_sweep"))
    rec_plan = mr.Recording.open(os.path.join(loop, f"rec_plan_{args.grader}"))
    looks = mr.read_jsonl(os.path.join(run.path, "align.jsonl"))
    if not (plan and rec_sweep and rec_plan and looks):
        sys.exit("need the plan, both recordings and align.jsonl (see the top of this file)")
    rows = mission_rows(plan, os.path.join(run.path, "shoal.db"))

    f = Fonts(args.font)
    out = args.out or os.path.join(loop, "demo.mp4")
    writer = mr.Writer(out, W, H, args.fps, 19)
    v = Video(writer, args.fps)

    intro(v, f, rec_sweep, sweep, 5.0)
    survey(v, f, rec_sweep, sweep, 1.4)
    seen, found = detect(v, f, sweep, plan, 18.0)
    rank(v, f, plan, seen, found, 13.0)
    flight(v, f, rec_plan, run, plan, sweep.grid, 10.0)

    segments = segments_of(looks)
    numbers = {t["target_id"]: (n, t) for n, t in enumerate(plan["targets"], 1)}
    captions = ["The detector reads the live camera, and the robot corrects its aim",
                "When the defect is centred at the right distance, it takes the photo",
                "If the defect can't be found again, the robot looks wider, then lets it go"]
    for i, tid in enumerate(args.featured.split(",")):
        mine = {k: s for k, s in segments.items() if k[1] == tid}
        if not mine:
            print(f"[demo] no close-up of {tid}: skipped")
            continue
        (auv, _), seg = max(mine.items(), key=lambda kv: len(kv[1]))       # the one with the most to show
        number, target = numbers[tid]
        close_up(v, f, rec_plan, run, target, number, auv, seg, captions[min(i, 2)])

    verdicts(v, f, run, rows, 13.0)
    report_screen(v, f, run, rows, 7.0)
    outro(v, f, sweep, plan, rows, 5.5)
    writer.close()


if __name__ == "__main__":
    main()
