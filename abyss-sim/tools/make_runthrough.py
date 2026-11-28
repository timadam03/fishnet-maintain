"""
make_runthrough.py -- the whole closed loop as one demo video.

    python abyss-sim/tools/make_runthrough.py <loop_dir> [--grader rules] [--out runthrough.mp4]

<loop_dir> is the folder run_loop.ps1 writes (-Out). Five chapters, each with a title card:

  1. SWEEP    the ROVs survey the whole net from a distance      rec_sweep/ (or the sweep photos)
  2. DETECT   the classifier on each photo, and a map of the net  run_sweep/ photos, overlays/, vision.jsonl
              filling in with what it found
  3. DECIDE   the decision layer's ranked targets, with the rule  run_sweep/plan_<grader>.json
              behind each one and the robots' orders
  4. ACT      the ROVs fly the plan: targets marked, each ROV     rec_plan_<grader>/ (or the plan-run photos),
              labelled with the target it is heading to          run_plan_<grader>/captures.jsonl
  5. RESULT   the close-ups per target and what each mission      run_plan_<grader>/ overlays/, plan_status.json,
              concluded                                           mission results from shoal.db

The rec_* folders exist only when the loop ran with -Record; without them chapters 1 and 4 show the
photos in the order they were taken. Everything shown comes from the loop's own outputs: the
classifier chapter draws what vision.jsonl reported (what the decision layer received), never the
sim's ground truth.

Needs numpy, Pillow and ffmpeg, like make_video.py (Isaac Sim's python has numpy and Pillow).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_video as mv  # noqa: E402  (compose, Cam, fonts, ffmpeg: the same look as the loop videos)

BG, PANEL, INK, DIM = (5, 20, 30), (12, 34, 48), (230, 242, 250), (130, 160, 178)
SEEN = (22, 64, 80)
CLASS_COLORS = {"hole": (255, 70, 60), "mesh_opening": (255, 150, 50), "fraying": (255, 150, 50),
                "thinning": (250, 215, 60), "distortion": (200, 160, 255), "rope_contact": (200, 160, 255),
                "biofouling": (90, 210, 110), "other": (170, 180, 190)}
SEVERITY_ORDER = ["hole", "mesh_opening", "fraying", "thinning", "distortion", "rope_contact", "biofouling", "other"]
PRIORITY_COLORS = {"high": (255, 80, 70), "normal": (255, 185, 60), "low": (110, 180, 255)}
STEPS = ["SWEEP", "DETECT", "DECIDE", "ACT", "RESULT"]
HEADER_H = 96


# ------------------------------------------------------------------------------------------ inputs
def read_jsonl(path):
    if not os.path.isfile(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def read_json(path):
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return json.load(f)


class Run:
    """One sim run folder: photos, their capture records and the classifier's reports."""

    def __init__(self, path):
        self.path = path
        self.captures = sorted(read_jsonl(os.path.join(path, "captures.jsonl")), key=lambda c: c["sim_time"])
        self.vision = {v["image"]: v for v in read_jsonl(os.path.join(path, "vision.jsonl"))}
        self.grid = (read_json(os.path.join(path, "ground_truth.json")) or {}).get("grid", {})

    def image(self, rel):
        return os.path.join(self.path, *rel.split("/"))

    def overlay(self, rel):
        p = os.path.join(self.path, "overlays", *rel.split("/"))
        return p if os.path.isfile(p) else None


class Recording:
    """A `fishfarm_demo.py --record` folder, or None when the loop ran without -Record."""

    def __init__(self, path):
        self.path = path
        self.meta = read_json(os.path.join(path, "meta.json"))
        self.recs = read_jsonl(os.path.join(path, "telemetry.jsonl"))
        cams = self.meta["cams"]
        self.layout = "grid" if "demo" in cams and "section" in cams else ("demo" if "demo" in cams else "section")
        self.rov_cams = [c for c in cams if c.startswith("auv")]
        need = (["demo", "section"] if self.layout == "grid" else [self.layout]) + self.rov_cams
        self.recs = [r for r in self.recs
                     if all(os.path.exists(os.path.join(path, c, f"{r['i']:05d}.png")) for c in need)]

    @staticmethod
    def open(path):
        if not (os.path.isfile(os.path.join(path, "meta.json")) and os.path.isfile(os.path.join(path, "telemetry.jsonl"))):
            return None
        rec = Recording(path)
        return rec if rec.recs else None


def mission_results(plan, db_paths):
    """target_id -> mission result, read from the decision layer's database.

    Each loop starts with `reset`, so a database from a later loop holds other missions under the
    same ids. A result is only used when the row's cells contain the target's cell.
    """
    for db in db_paths:
        if not db or not os.path.isfile(db):
            continue
        out = {}
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            for t in plan["targets"]:
                row = con.execute("SELECT cells_json, status, result FROM missions WHERE id = ?",
                                  (t["mission_id"],)).fetchone()
                if row and t["cell"] in json.loads(row[0]) and row[1] == "done":
                    out[t["target_id"]] = row[2] or ""
        finally:
            con.close()
        if out:
            return out, db
    return {}, None


# ------------------------------------------------------------------------------------------ drawing
class Theme:
    def __init__(self, W):
        sc = W / 1920.0
        self.sc = sc
        self.f = {k: mv.font(max(9, int(v * sc)), bold=b) for k, (v, b) in
                  {"xs": (18, False), "s": (22, False), "m": (28, False), "b": (28, True),
                   "l": (44, True), "xl": (72, True)}.items()}

    def px(self, v):
        return int(v * self.sc)


def canvas(W, H):
    return Image.new("RGB", (W, H), BG)


def header(img, th, step, title, subtitle=""):
    """Chapter header: the five loop steps with this one lit, then the chapter title."""
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle([0, 0, img.width, th.px(HEADER_H)], fill=PANEL)
    x = th.px(28)
    for i, name in enumerate(STEPS):
        on = i == step
        w = d.textlength(name, font=th.f["s"]) + th.px(28)
        d.rounded_rectangle([x, th.px(14), x + w, th.px(46)], th.px(16),
                            fill=(60, 200, 230, 255) if on else (30, 60, 76, 255))
        d.text((x + th.px(14), th.px(17)), name, font=th.f["s"], fill=BG if on else DIM)
        x += w + th.px(10)
        if i < len(STEPS) - 1:
            d.text((x - th.px(4), th.px(15)), ">", font=th.f["s"], fill=DIM)
            x += th.px(16)
    d.text((th.px(28), th.px(54)), title, font=th.f["b"], fill=INK)
    if subtitle:
        d.text((th.px(28) + d.textlength(title, font=th.f["b"]) + th.px(18), th.px(58)), subtitle,
               font=th.f["s"], fill=DIM)


def fit(img, box):
    """Scale `img` to fit the box (x0, y0, x1, y1), centred. Returns (image, (x, y))."""
    x0, y0, x1, y1 = box
    s = min((x1 - x0) / img.width, (y1 - y0) / img.height)
    im = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)
    return im, (x0 + (x1 - x0 - im.width) // 2, y0 + (y1 - y0 - im.height) // 2)


def paste_fit(dst, img, box):
    im, at = fit(img, box)
    dst.paste(im, at)
    return im, at


def wrap(draw, text, font, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        nxt = f"{cur} {w}".strip()
        if draw.textlength(nxt, font=font) <= width or not cur:
            cur = nxt
        else:
            lines.append(cur)
            cur = w
    return lines + ([cur] if cur else [])


def plain(text):
    """Dashes as hyphens: not every font the sim machines have (or Pillow's fallback) has them."""
    return text.replace("\u2013", "-").replace("\u2014", "-")


def worst_class(classes):
    return min(classes, key=lambda c: SEVERITY_ORDER.index(c) if c in SEVERITY_ORDER else len(SEVERITY_ORDER))


class NetMap:
    """The net wall unrolled: 24 sectors around x 8 rows down, as the decision layer sees it."""

    def __init__(self, sectors=24, rows=8):
        self.sectors, self.rows = sectors, rows
        self.seen = set()
        self.found = {}          # cell -> {class: best confidence}

    def add_report(self, report):
        self.seen.update(report.get("cells_in_view") or [])
        for d in report.get("detections", []):
            if "cell" in d:
                self.seen.add(d["cell"])
                best = self.found.setdefault(d["cell"], {})
                best[d["class"]] = max(best.get(d["class"], 0.0), float(d["confidence"]))

    def cell_box(self, box, cell):
        x0, y0, x1, y1 = box
        row, col = divmod(cell, self.sectors)
        cw, ch = (x1 - x0) / self.sectors, (y1 - y0) / self.rows
        return x0 + col * cw, y0 + row * ch, x0 + (col + 1) * cw, y0 + (row + 1) * ch

    def draw(self, img, box, th, targets=(), fade=1.0, highlight=()):
        d = ImageDraw.Draw(img, "RGBA")
        x0, y0, x1, y1 = box
        d.rectangle([x0 - 2, y0 - 2, x1 + 2, y1 + 2], fill=(3, 12, 18))
        for cell in range(self.sectors * self.rows):
            cx0, cy0, cx1, cy1 = self.cell_box(box, cell)
            fill = (14, 30, 40)
            if cell in self.seen:
                fill = SEEN
            if cell in self.found:
                cls = worst_class(self.found[cell])
                conf = self.found[cell][cls]
                a = (0.35 + 0.65 * conf) * fade
                fill = tuple(int(c * a + s * (1 - a)) for c, s in zip(CLASS_COLORS.get(cls, CLASS_COLORS["other"]), SEEN))
            d.rectangle([cx0 + 1, cy0 + 1, cx1 - 1, cy1 - 1], fill=fill)
        for cell in highlight:
            cx0, cy0, cx1, cy1 = self.cell_box(box, cell)
            d.rectangle([cx0 - 1, cy0 - 1, cx1 + 1, cy1 + 1], outline=(255, 255, 255), width=th.px(3))
        for n, t in enumerate(targets, 1):
            cx0, cy0, cx1, cy1 = self.cell_box(box, t["cell"])
            col = PRIORITY_COLORS.get(t.get("priority_label"), PRIORITY_COLORS["normal"])
            d.rectangle([cx0 - 2, cy0 - 2, cx1 + 2, cy1 + 2], outline=col, width=th.px(4))
            r = th.px(15)
            bx, by = cx1, cy0
            d.ellipse([bx - r, by - r, bx + r, by + r], fill=col)
            label = str(n)
            d.text((bx - d.textlength(label, font=th.f["xs"]) / 2, by - th.px(11)), label, font=th.f["xs"], fill=BG)
        for deg in (0, 90, 180, 270, 360):
            x = x0 + (x1 - x0) * deg / 360
            d.text((x - th.px(14), y1 + th.px(6)), f"{deg}°", font=th.f["xs"], fill=DIM)
        d.text((x0 - th.px(8) - d.textlength("surface", font=th.f["xs"]), y0), "surface", font=th.f["xs"], fill=DIM)
        d.text((x0 - th.px(8) - d.textlength("bottom", font=th.f["xs"]), y1 - th.px(20)), "bottom", font=th.f["xs"], fill=DIM)

    def legend(self, img, at, th, max_x):
        d = ImageDraw.Draw(img, "RGBA")
        x, y = at
        items = [("not looked at yet", (14, 30, 40)), ("looked, nothing found", SEEN)] + \
                [(c.replace("_", " "), CLASS_COLORS[c]) for c in ("hole", "mesh_opening", "thinning", "biofouling")]
        for name, col in items:
            if x + th.px(30) + d.textlength(name, font=th.f["xs"]) > max_x:
                x, y = at[0], y + th.px(30)
            d.rectangle([x, y + th.px(4), x + th.px(22), y + th.px(22)], fill=col)
            d.text((x + th.px(30), y), name, font=th.f["xs"], fill=INK)
            x += th.px(30) + d.textlength(name, font=th.f["xs"]) + th.px(24)


def heat_layer(report, size):
    """Detection heat for one photo: a soft blob per detection, coloured by class, as strong as its
    confidence. Drawn from vision.jsonl, i.e. exactly what the decision layer received."""
    W, H = size
    s = 4
    w, h = max(1, W // s), max(1, H // s)
    rgb, alpha = np.zeros((h, w, 3)), np.zeros((h, w))
    yy, xx = np.mgrid[0:h, 0:w]
    for d in report.get("detections", []):
        bx, by, bw, bh = d["bbox"]
        cx, cy = (bx + bw / 2) / s, (by + bh / 2) / s
        sx, sy = max(2.0, bw / s / 2), max(2.0, bh / s / 2)
        g = np.exp(-(((xx - cx) / sx) ** 2 + ((yy - cy) / sy) ** 2) / 2) * float(d["confidence"])
        rgb += g[..., None] * np.array(CLASS_COLORS.get(d["class"], CLASS_COLORS["other"]), float)
        alpha += g
    out = np.zeros((h, w, 4), np.uint8)
    nz = alpha > 1e-6
    out[..., :3][nz] = np.clip(rgb[nz] / alpha[nz][:, None], 0, 255)
    out[..., 3] = np.clip(alpha * 170, 0, 170).astype(np.uint8)
    return Image.fromarray(out, "RGBA").resize((W, H), Image.BILINEAR)


def processed_photo(run, cap, report):
    """The classifier's view of a photo: its own overlay (or the boxes) plus the detection heat."""
    raw = Image.open(run.image(cap["image"])).convert("RGB")
    ov_path = run.overlay(cap["image"])
    proc = Image.open(ov_path).convert("RGB").resize(raw.size) if ov_path else raw.copy()
    if report:
        heat = heat_layer(report, raw.size)
        proc.paste(heat, (0, 0), heat)
        if not ov_path:
            d = ImageDraw.Draw(proc)
            for det in report.get("detections", []):
                bx, by, bw, bh = det["bbox"]
                d.rectangle([bx, by, bx + bw, by + bh], outline=CLASS_COLORS.get(det["class"]), width=3)
    return raw, proc


# ------------------------------------------------------------------------------------------ writer
class Writer:
    """Fixed-size frames into one ffmpeg pipe (or numbered PNGs when there is no ffmpeg)."""

    def __init__(self, path, W, H, fps, crf):
        self.W, self.H, self.fps, self.n = W, H, fps, 0
        self.ffmpeg = mv.find_ffmpeg()
        self.proc, self.png_dir, self.path = None, None, path
        if self.ffmpeg:
            self.proc = subprocess.Popen([self.ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                                          "-s", f"{W}x{H}", "-r", f"{fps}", "-i", "-", "-c:v", "libx264",
                                          "-pix_fmt", "yuv420p", "-crf", str(crf), "-preset", "medium", path],
                                         stdin=subprocess.PIPE)
        else:
            self.png_dir = os.path.splitext(path)[0] + "_frames"
            os.makedirs(self.png_dir, exist_ok=True)

    def add(self, img, seconds=None):
        if img.size != (self.W, self.H):
            raise ValueError(f"frame is {img.size}, the video is {(self.W, self.H)}")
        for _ in range(1 if seconds is None else max(1, int(round(seconds * self.fps)))):
            if self.proc:
                self.proc.stdin.write(img.tobytes())
            else:
                img.save(os.path.join(self.png_dir, f"{self.n:06d}.png"))
            self.n += 1

    def close(self):
        if self.proc:
            self.proc.stdin.close()
            if self.proc.wait() != 0:
                sys.exit("ffmpeg failed while writing the video")
            print(f"[runthrough] wrote {os.path.abspath(self.path)} ({self.n / self.fps:.0f} s)")
        else:
            print(f"[runthrough] ffmpeg not found -> frames in {self.png_dir}\n"
                  f"  encode: ffmpeg -r {self.fps} -i {self.png_dir}/%06d.png -c:v libx264 -pix_fmt yuv420p {self.path}")


# ------------------------------------------------------------------------------------------ chapters
def title_card(out, th, step, title, lines, seconds):
    img = canvas(out.W, out.H)
    header(img, th, step, title)
    d = ImageDraw.Draw(img)
    y = out.H // 2 - th.px(90)
    d.text((th.px(120), y), f"{step + 1}  {STEPS[step]}", font=th.f["xl"], fill=(60, 200, 230))
    y += th.px(110)
    for line in lines:
        d.text((th.px(124), y), line, font=th.f["m"], fill=INK)
        y += th.px(44)
    out.add(img, seconds)


def recording_chapter(out, th, rec, step, title, subtitle, speed, decorate=None):
    """Play a recording at `speed` x, through make_video.compose, fitted below the header."""
    meta = rec.meta
    W, H = meta["demo_res"]
    sc = W / 1920.0
    fonts = {"xs": mv.font(max(10, int(18 * sc))), "s": mv.font(max(12, int(22 * sc))),
             "b": mv.font(max(14, int(26 * sc)), bold=True)}
    s2 = 0.72 * sc
    fonts["small_set"] = {"xs": mv.font(max(9, int(18 * s2))), "s": mv.font(max(10, int(22 * s2))),
                          "b": mv.font(max(11, int(26 * s2)), bold=True)}
    src_fps = meta.get("fps", 30.0)
    step_n = max(1, int(round(speed * src_fps / out.fps)))
    caption_h = th.px(70) if decorate else 0
    box = (0, th.px(HEADER_H), out.W, out.H - caption_h)
    flash_until, pending = {}, set()
    for n, r in enumerate(rec.recs):
        pending.update(r.get("shot", []))
        if n % step_n:
            continue
        r = dict(r)
        for k in pending:
            flash_until[k] = n + step_n * max(1, int(0.3 * out.fps))
        pending = set()
        r["shot"] = [k for k, until in flash_until.items() if n < until]
        frame = mv.compose(rec.path, r, meta, rec.layout, rec.rov_cams, fonts, W, H)
        if decorate:
            decorate(frame, r, W, H)
        img = canvas(out.W, out.H)
        header(img, th, step, title, subtitle)
        paste_fit(img, frame, box)
        if decorate:
            decorate.caption(img, r, (0, out.H - caption_h, out.W, out.H), th)
        out.add(img)


def photo_chapter(out, th, run, step, title, subtitle, per_photo):
    """Without a recording: the photos in the order they were taken, one column per ROV."""
    n_auv = max([c["auv"] for c in run.captures] + [0]) + 1
    latest = {}
    top = th.px(HEADER_H) + th.px(20)
    col_w = out.W // n_auv
    for cap in run.captures:
        latest[cap["auv"]] = cap
        img = canvas(out.W, out.H)
        header(img, th, step, title, subtitle)
        d = ImageDraw.Draw(img)
        for k, c in latest.items():
            photo = Image.open(run.image(c["image"])).convert("RGB")
            paste_fit(img, photo, (k * col_w + th.px(10), top + th.px(40), (k + 1) * col_w - th.px(10), out.H - th.px(80)))
            label = f"ROV {k + 1}   {c['image']}   cell {c['cell']}" + (f"   target {c['target_id']}" if c.get("target_id") else "")
            d.text((k * col_w + th.px(14), top), label, font=th.f["s"], fill=mv.ROV_COLORS[k % 3])
        out.add(img, per_photo)


def classifier_chapter(out, th, run, args):
    reports = [run.vision.get(c["image"]) for c in run.captures]
    if not any(reports):
        title_card(out, th, 1, "Classifier", ["No vision.jsonl in the sweep folder: run run_vision.py first."], 3)
        return NetMap()
    model = next(r["model"] for r in reports if r)
    with_hits = [i for i, r in enumerate(reports) if r and r.get("detections")]
    clean = [i for i, r in enumerate(reports) if r and not r.get("detections")]
    shown = sorted(with_hits[: args.max_photos - 2] + clean[:2])
    netmap = NetMap(int(run.grid.get("ui_sectors", 24)), int(run.grid.get("ui_wall_rows", 8)))
    photo_box = (th.px(28), th.px(HEADER_H) + th.px(70), th.px(1060), out.H - th.px(190))
    map_box = (th.px(1200), th.px(HEADER_H) + th.px(110), out.W - th.px(40), th.px(HEADER_H) + th.px(110) + th.px(330))
    counts, done = {}, 0
    wipe_n = max(2, int(args.wipe * out.fps))
    hold_n = max(1, int(args.hold * out.fps))

    def frame(cap, report, raw, proc, progress, after):
        img = canvas(out.W, out.H)
        header(img, th, 1, "Classifier", f"{model}  -  every photo graded, nothing found counts too")
        d = ImageDraw.Draw(img, "RGBA")
        raw_f, at = fit(raw, photo_box)
        proc_f = proc.resize(raw_f.size, Image.LANCZOS)
        img.paste(raw_f, at)
        xw = int(raw_f.width * progress)
        if xw > 0:
            img.paste(proc_f.crop((0, 0, xw, raw_f.height)), at)
        if 0 < progress < 1:
            d.line([at[0] + xw, at[1], at[0] + xw, at[1] + raw_f.height], fill=(120, 240, 255), width=th.px(4))
        d.text((photo_box[0], photo_box[1] - th.px(44)),
               f"ROV {cap['auv'] + 1}  -  {cap['image']}  -  {done}/{len(reports)} photos graded",
               font=th.f["s"], fill=INK)
        y = at[1] + raw_f.height + th.px(14)
        dets = (report or {}).get("detections", [])
        if after:
            if not dets:
                d.text((photo_box[0], y), "nothing found  -  this clears the cells in view", font=th.f["m"], fill=(150, 230, 170))
            for det in sorted(dets, key=lambda x: -x["confidence"])[:3]:
                col = CLASS_COLORS.get(det["class"], CLASS_COLORS["other"])
                d.text((photo_box[0], y), f"{det['class'].replace('_', ' ')}  confidence {det['confidence']:.2f}"
                       f"  {det.get('severity', '')}  ->  cell {det.get('cell', '?')}", font=th.f["m"], fill=col)
                y += th.px(38)
        d.text((map_box[0], map_box[1] - th.px(64)), "What the classifier found, per area of the net",
               font=th.f["b"], fill=INK)
        netmap.draw(img, map_box, th, highlight=[x["cell"] for x in dets if "cell" in x] if after else ())
        netmap.legend(img, (map_box[0], map_box[3] + th.px(44)), th, out.W - th.px(20))
        y = map_box[3] + th.px(130)
        for cls in SEVERITY_ORDER:
            if counts.get(cls):
                d.text((map_box[0], y), f"{counts[cls]:4d}  {cls.replace('_', ' ')}", font=th.f["m"],
                       fill=CLASS_COLORS[cls])
                y += th.px(38)
        q = (report or {}).get("quality")
        if q and after:
            d.text((map_box[0], out.H - th.px(80)),
                   f"image quality {min(q['sharpness'], q['visibility']):.2f}  (low: a robot is sent closer)",
                   font=th.f["xs"], fill=DIM)
        return img

    for i, (cap, report) in enumerate(zip(run.captures, reports)):
        if i not in shown:
            if report:                                # photos not shown still fill the map
                netmap.add_report(report)
                done += 1
                for det in report.get("detections", []):
                    counts[det["class"]] = counts.get(det["class"], 0) + 1
            continue
        raw, proc = processed_photo(run, cap, report)
        for f in range(wipe_n):
            out.add(frame(cap, report, raw, proc, (f + 1) / wipe_n, after=False))
        if report:
            netmap.add_report(report)
            done += 1
            for det in report.get("detections", []):
                counts[det["class"]] = counts.get(det["class"], 0) + 1
        img = frame(cap, report, raw, proc, 1.0, after=True)
        out.add(img, hold_n / out.fps)
    return netmap


def target_lines(t):
    area = plain(next((r["text"] for r in t["reasons"] if r["rule"] == "area"), f"cell {t['cell']}"))
    why = [plain(f"{r['rule']}: {r['text']}") for r in t["reasons"] if r["rule"] != "area"]
    s = t["scan"]
    robots = " + ".join(f"ROV {k + 1}" for k in t["robots"])
    views = len(s["viewpoints"])
    orders = (f"{robots}  -  {s['standoff_m']:.2f} m from the net  -  {views} angle{'s' if views > 1 else ''}"
              f" x {s['shots']} shot{'s' if s['shots'] > 1 else ''}  -  margin {t['safety']['margin_m']:.1f} m")
    return area, why, orders


def decision_chapter(out, th, plan, netmap, grader, args):
    targets = plan["targets"]
    map_box = (th.px(130), th.px(HEADER_H) + th.px(120), th.px(900), th.px(HEADER_H) + th.px(120) + th.px(330))
    list_x, list_w = th.px(960), out.W - th.px(960) - th.px(40)
    shown_max = args.max_targets

    def frame(k):
        img = canvas(out.W, out.H)
        header(img, th, 2, "Decision layer", f"grader: {grader}  -  rules {plan.get('rules_version', '?')}  -  plan {plan['plan_id']}")
        d = ImageDraw.Draw(img, "RGBA")
        d.text((map_box[0], map_box[1] - th.px(64)), "Where the robots should look closer", font=th.f["b"], fill=INK)
        netmap.draw(img, map_box, th, targets=targets[:k], fade=0.55)
        y = map_box[3] + th.px(60)
        lines = [f"{len(targets)} targets ranked, best first",
                 f"{len(plan.get('coverage', []))} other areas stay on the normal sweep, stalest first",
                 "a confirmed hole leaves the plan: it needs a repair, not more robot time"]
        for line in lines:
            d.text((map_box[0], y), line, font=th.f["s"], fill=DIM)
            y += th.px(34)
        y = th.px(HEADER_H) + th.px(30)
        for n, t in enumerate(targets[:min(k, shown_max)], 1):
            area, why, orders = target_lines(t)
            col = PRIORITY_COLORS.get(t["priority_label"], PRIORITY_COLORS["normal"])
            body = []
            for w in why:
                body += wrap(d, w, th.f["xs"], list_w - th.px(60))
            h = th.px(80) + th.px(24) * len(body) + th.px(30)
            if y + h > out.H - th.px(20):
                d.text((list_x, y), f"+ {len(targets) - n + 1} more targets", font=th.f["s"], fill=DIM)
                break
            d.rounded_rectangle([list_x, y, list_x + list_w, y + h], th.px(12), fill=PANEL)
            d.rectangle([list_x, y, list_x + th.px(8), y + h], fill=col)
            d.text((list_x + th.px(24), y + th.px(10)), f"{n}  {t['target_id']}   {t['priority_label'].upper()}"
                   f" {t['priority']:.2f}", font=th.f["b"], fill=col)
            d.text((list_x + th.px(24) + th.px(330), y + th.px(14)), area, font=th.f["s"], fill=INK)
            yy = y + th.px(52)
            for line in body:
                d.text((list_x + th.px(24), yy), line, font=th.f["xs"], fill=INK)
                yy += th.px(24)
            d.text((list_x + th.px(24), yy + th.px(4)), orders, font=th.f["xs"], fill=(120, 230, 255))
            y += h + th.px(12)
        if not targets:
            d.text((list_x, y), "Nothing worth a closer look: no plan run.", font=th.f["m"], fill=INK)
        return img

    for k in range(1, len(targets) + 1):
        out.add(frame(k), args.per_target)
    out.add(frame(len(targets)), args.decision_hold)


class PlanOverlay:
    """Marks the plan's targets in the overview of the plan-run recording, and links each ROV to the
    target it is heading to: the target of its next photo (captures.jsonl and the telemetry share
    the sim clock)."""

    def __init__(self, plan, run, grid, meta):
        self.meta = meta
        self.targets = {t["target_id"]: t for t in plan["targets"]}
        self.order = {t["target_id"]: n for n, t in enumerate(plan["targets"], 1)}
        self.by_auv = {}
        for c in run.captures:
            self.by_auv.setdefault(c["auv"], []).append(c)
        self.R = float(grid.get("cage_radius_m", 8.0))
        self.D = float(grid.get("cage_depth_m", 8.0))

    def heading(self, k, t):
        for c in self.by_auv.get(k, []):
            if c["sim_time"] >= t:
                return c.get("target_id")
        return "done"

    def point(self, tgt):
        a = math.radians(tgt["theta_deg"])
        return np.array([self.R * math.cos(a), self.R * math.sin(a), -tgt["depth_frac"] * self.D])

    def __call__(self, frame, rec, W, H):
        meta = self.meta
        grid = "section" in meta["cams"] and "demo" in meta["cams"]   # the overview is the top-left half
        vw, vh = (W // 2, H // 2) if grid else (W, H)
        cam = mv.view_cam(meta, rec, "demo", vw, vh)
        d = ImageDraw.Draw(frame, "RGBA")
        for tid, tgt in self.targets.items():
            p = cam.project(self.point(tgt))
            if p is None:
                continue
            col = PRIORITY_COLORS.get(tgt["priority_label"], PRIORITY_COLORS["normal"])
            r = max(6, int(14 * vw / 1920 * 2))
            d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], outline=col + (255,), width=3)
            d.text((p[0] + r + 3, p[1] - r), str(self.order[tid]), font=mv.font(max(10, int(24 * vw / 960))), fill=col)
        for k, rov in enumerate(rec["rov"]):
            tid = self.heading(k, rec["t"])
            if tid in self.targets:
                a, b = cam.project(np.array(rov["pos"])), cam.project(self.point(self.targets[tid]))
                if a is not None and b is not None:
                    d.line([tuple(a), tuple(b)], fill=mv.ROV_COLORS[k % 3] + (200,), width=3)

    def caption(self, img, rec, box, th):
        d = ImageDraw.Draw(img, "RGBA")
        x0, y0, x1, y1 = box
        d.rectangle(box, fill=PANEL)
        x = x0 + th.px(28)
        for k, rov in enumerate(rec["rov"]):
            tid = self.heading(k, rec["t"])
            if tid in self.targets:
                t = self.targets[tid]
                rule = next((r["rule"] for r in t["reasons"] if r["rule"] != "area"), "")
                text = f"ROV {k + 1} -> target {self.order[tid]} ({tid}, cell {t['cell']}, {rule})"
            elif tid == "done":
                text = f"ROV {k + 1}: plan done, returning"
            else:
                text = f"ROV {k + 1}: sweeping other areas"
            d.text((x, y0 + th.px(20)), text, font=th.f["s"], fill=mv.ROV_COLORS[k % 3])
            x += (x1 - x0) // max(1, len(rec["rov"]))


def result_chapter(out, th, plan, run, status, results, args):
    targets = plan["targets"]
    if not targets:
        return
    by_target = {}
    for c in run.captures:
        if c.get("target_id"):
            by_target.setdefault(c["target_id"], []).append(c)
    per_page = 6
    for page in range(0, len(targets), per_page):
        img = canvas(out.W, out.H)
        header(img, th, 4, "Results", "the close-ups, graded by the classifier; each mission closes with what they showed")
        d = ImageDraw.Draw(img, "RGBA")
        cols, rows = 3, 2
        cw, ch = (out.W - th.px(60)) // cols, (out.H - th.px(HEADER_H) - th.px(40)) // rows
        for j, t in enumerate(targets[page:page + per_page]):
            n = page + j + 1
            x, y = th.px(30) + (j % cols) * cw, th.px(HEADER_H) + th.px(20) + (j // cols) * ch
            d.rounded_rectangle([x + th.px(8), y + th.px(8), x + cw - th.px(8), y + ch - th.px(8)], th.px(12), fill=PANEL)
            col = PRIORITY_COLORS.get(t["priority_label"], PRIORITY_COLORS["normal"])
            caps = by_target.get(t["target_id"], [])
            best = max(caps, key=lambda c: max([x["confidence"] for x in (run.vision.get(c["image"]) or {}).get("detections", [])] + [0.0]),
                       default=None)
            box = (x + th.px(20), y + th.px(60), x + cw - th.px(20), y + ch - th.px(130))
            if best:
                _, proc = processed_photo(run, best, run.vision.get(best["image"]))
                paste_fit(img, proc, box)
            else:
                d.text((box[0], box[1] + th.px(40)), "no close-up photo came back", font=th.f["s"], fill=DIM)
            d.text((x + th.px(20), y + th.px(18)), f"{n}  {t['target_id']}  cell {t['cell']}", font=th.f["b"], fill=col)
            st = (status or {}).get("targets", {}).get(t["target_id"], {})
            photos = ", ".join(f"ROV {int(k) + 1}: {v}" for k, v in sorted(st.get("photos", {}).items()))
            extra = f"   {st.get('timeouts', 0)} timed out" if st.get("timeouts") else ""
            extra += f"   {len(st['blocked'])} view(s) blocked" if st.get("blocked") else ""
            d.text((x + th.px(20), y + ch - th.px(122)), f"photos  {photos or len(caps)}{extra}", font=th.f["xs"], fill=DIM)
            res = results.get(t["target_id"])
            rc = (255, 90, 80) if res and res.startswith("confirmed") else \
                 (150, 230, 170) if res and res.startswith("clear") else (255, 200, 90)
            lines = wrap(d, plain(res) if res else "result not available (the database was reset or not found)",
                         th.f["xs"], cw - th.px(60))
            for i, line in enumerate(lines[:3]):
                d.text((x + th.px(20), y + ch - th.px(92) + i * th.px(24)), line, font=th.f["xs"], fill=rc if res else DIM)
        out.add(img, args.per_result_page)


def summary_card(out, th, plan, results, next_plan):
    img = canvas(out.W, out.H)
    header(img, th, 4, "The loop, once around")
    d = ImageDraw.Draw(img)
    words = [r.split(":")[0].split(" ")[0] for r in results.values()]
    other = len(words) - words.count("confirmed") - words.count("clear")
    missing = len(plan["targets"]) - len(words)
    lines = [f"{len(plan['targets'])} areas sent for a closer look",
             f"{words.count('confirmed')} confirmed   -   {words.count('clear')} cleared   -   {other} need another look"
             + (f"   -   {missing} without a result" if missing else "")]
    if next_plan is not None:
        lines.append(f"next plan: {len(next_plan['targets'])} targets, escalated from what is still unsure")
    y = out.H // 2 - th.px(100)
    for i, line in enumerate(lines):
        d.text((th.px(120), y), line, font=th.f["l"] if i == 0 else th.f["m"], fill=INK if i == 0 else DIM)
        y += th.px(70)
    out.add(img, 5)


# ------------------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("loop_dir", help="the loop folder (run_loop.ps1 -Out)")
    ap.add_argument("--grader", default="rules", help="which plan run to show: rules or d1 (default rules)")
    ap.add_argument("--out", default=None, help="output MP4 (default <loop_dir>/runthrough_<grader>.mp4)")
    ap.add_argument("--db", default=None, help="decision-layer database, if not in run_plan_<grader>/shoal.db")
    ap.add_argument("--res", default="1920x1080")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--speed", type=float, default=4.0, help="playback speed of the robot recordings")
    ap.add_argument("--max-photos", type=int, default=16, help="photos shown in the classifier chapter")
    ap.add_argument("--wipe", type=float, default=0.6, help="seconds the classifier takes to sweep across a photo")
    ap.add_argument("--hold", type=float, default=0.9, help="seconds each graded photo stays up")
    ap.add_argument("--per-target", type=float, default=1.2)
    ap.add_argument("--decision-hold", type=float, default=6.0)
    ap.add_argument("--max-targets", type=int, default=8)
    ap.add_argument("--per-result-page", type=float, default=6.0)
    ap.add_argument("--chapters", default="1,2,3,4,5", help="which chapters to render, e.g. 2,3")
    args = ap.parse_args()

    loop = os.path.abspath(args.loop_dir)
    sweep = Run(os.path.join(loop, "run_sweep"))
    plan_run = Run(os.path.join(loop, f"run_plan_{args.grader}"))
    plan = read_json(os.path.join(sweep.path, f"plan_{args.grader}.json"))
    if not sweep.captures:
        sys.exit(f"no photos in {sweep.path} (captures.jsonl)")
    if plan is None:
        sys.exit(f"no plan in {os.path.join(sweep.path, f'plan_{args.grader}.json')}")
    status = read_json(os.path.join(plan_run.path, "plan_status.json"))
    next_plan = read_json(os.path.join(plan_run.path, "next_plan.json"))
    results, db = mission_results(plan, [os.path.join(plan_run.path, "shoal.db"), args.db])
    rec_sweep = Recording.open(os.path.join(loop, "rec_sweep"))
    rec_plan = Recording.open(os.path.join(loop, f"rec_plan_{args.grader}"))
    chapters = {int(c) for c in args.chapters.split(",") if c.strip()}
    print(f"[runthrough] sweep {len(sweep.captures)} photos, {len(sweep.vision)} graded; plan {len(plan['targets'])} targets; "
          f"plan run {len(plan_run.captures)} photos; recordings: sweep {'yes' if rec_sweep else 'no'}, "
          f"plan {'yes' if rec_plan else 'no'}; mission results {len(results)} ({db or 'no database'})")

    W, H = (int(v) for v in args.res.lower().split("x"))
    th = Theme(W)
    out = Writer(args.out or os.path.join(loop, f"runthrough_{args.grader}.mp4"), W, H, args.fps, args.crf)

    netmap = NetMap()
    if 1 in chapters:
        title_card(out, th, 0, "Sweep", ["Three ROVs survey the whole net from a distance.",
                                         f"{len(sweep.captures)} photos, every area of the wall."], 3)
        if rec_sweep:
            recording_chapter(out, th, rec_sweep, 0, "Sweep", f"{args.speed:g}x speed", args.speed)
        else:
            photo_chapter(out, th, sweep, 0, "Sweep", "photos in the order they were taken", 0.25)
    if 2 in chapters or 3 in chapters:
        if 2 in chapters:
            title_card(out, th, 1, "Classifier", ["Each photo is graded: holes, thin twine, fouling.",
                                                  "Every finding is placed on its area of the net."], 3)
            netmap = classifier_chapter(out, th, sweep, args)
        else:
            for c in sweep.captures:
                if sweep.vision.get(c["image"]):
                    netmap.add_report(sweep.vision[c["image"]])
    if 3 in chapters:
        title_card(out, th, 2, "Decision layer", ["Grades and ranks every area, then plans the close-ups:",
                                                  "where to go, how close, from which angles, which robots."], 3)
        decision_chapter(out, th, plan, netmap, args.grader, args)
    if 4 in chapters and plan["targets"]:
        title_card(out, th, 3, "The robots act", ["The ROVs fly the plan: closer, from other angles, more shots.",
                                                  "Each one is labelled with the target it is heading to."], 3)
        if rec_plan:
            overlay = PlanOverlay(plan, plan_run, sweep.grid, rec_plan.meta)
            recording_chapter(out, th, rec_plan, 3, "The robots act", f"{args.speed:g}x speed", args.speed, overlay)
        else:
            photo_chapter(out, th, plan_run, 3, "The robots act", "close-ups in the order they were taken", 0.5)
    if 5 in chapters:
        title_card(out, th, 4, "Results", ["The close-ups go through the classifier again,",
                                           "and every mission closes with what they showed."], 3)
        result_chapter(out, th, plan, plan_run, status, results, args)
        summary_card(out, th, plan, results, next_plan)
    out.close()


if __name__ == "__main__":
    main()
