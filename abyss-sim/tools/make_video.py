"""
make_video.py -- turn a `fishfarm_demo.py --record DIR` run into an annotated MP4.

    python make_video.py DIR          # -> DIR/abyss_orbit.mp4, DIR/abyss_section.mp4, DIR/abyss_grid.mp4
    python make_video.py DIR --views section --no-tiles --fps 30

Views (whatever was recorded):  demo = orbiting overview,  section = cutaway / cross-section,
plus a strip of the three ROV camera feeds under each.  The grid video shows orbit | section on top
and the ROV feeds below.

Needs numpy + Pillow (both ship with Isaac Sim's python: use python.sh / python.bat if your
system python lacks them) and ffmpeg on PATH (or `pip install imageio-ffmpeg`). Without ffmpeg it
writes annotated PNG frames to DIR/annotated/ and prints the ffmpeg command to run later.

Overlays on the orbit camera:
  - yellow arrow : nominal command (what the planner / policy asked for)
  - green arrow  : command after the HOCBF filter   (red + red label while the filter intervenes)
  - orange rings : safety boundary the HOCBF keeps around every obstacle (radius r + inflation)
  - panel        : per-ROV clearance, filter state, photos taken, contacts
  - flash        : white flash on a ROV tile when it takes an inspection photo
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROV_COLORS = [(255, 160, 40), (80, 200, 255), (230, 110, 255)]
NOM, SAFE, ACTIVE, RING = (255, 215, 40), (60, 255, 120), (255, 50, 40), (255, 120, 30)


def font(size, bold=False):
    names = ["DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
             "arialbd.ttf" if bold else "arial.ttf", "segoeuib.ttf" if bold else "segoeui.ttf"]
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


class Cam:
    """Pinhole model of the USD DemoCam (look-at, z-up)."""

    def __init__(self, eye, target, focal, h_ap, W, H):
        self.eye = np.asarray(eye, float)
        f = np.asarray(target, float) - self.eye
        self.f = f / np.linalg.norm(f)
        r = np.cross(self.f, [0.0, 0.0, 1.0])
        self.r = r / np.linalg.norm(r)
        self.u = np.cross(self.r, self.f)
        self.fx = W * focal / h_ap
        self.W, self.H = W, H

    def project(self, p):
        d = np.asarray(p, float) - self.eye
        z = d @ self.f
        if z < 0.1:
            return None
        return (self.W / 2 + self.fx * (d @ self.r) / z, self.H / 2 - self.fx * (d @ self.u) / z)


def polyline(draw, cam, pts, color, width):
    proj = [cam.project(p) for p in pts]
    for a, b in zip(proj[:-1], proj[1:]):
        if a is not None and b is not None:
            draw.line([a, b], fill=color, width=width)


def arrow(draw, cam, p0, vec, color, width=5, scale=2.5):
    p1 = np.asarray(p0, float) + scale * np.array([vec[0], vec[1], 0.0])
    a, b = cam.project(p0), cam.project(p1)
    if a is None or b is None or math.hypot(b[0] - a[0], b[1] - a[1]) < 4:
        return
    draw.line([a, b], fill=color, width=width)
    ang = math.atan2(b[1] - a[1], b[0] - a[0])
    head = 16
    for s in (-1, 1):
        draw.line([b, (b[0] - head * math.cos(ang + s * 0.45), b[1] - head * math.sin(ang + s * 0.45))],
                  fill=color, width=width)


def ring(cx, cy, z, R, n=40):
    return [(cx + R * math.cos(2 * math.pi * i / n), cy + R * math.sin(2 * math.pi * i / n), z) for i in range(n + 1)]


def annotate_main(img, rec, meta, cam, fonts, panel=True):
    draw = ImageDraw.Draw(img, "RGBA")
    infl = meta["inflation"]
    zs = [r["pos"][2] for r in rec["rov"]]
    z_ring = float(np.mean(zs)) if zs else -3.0
    if meta.get("hocbf"):
        for (x, y, r) in meta["obstacles"]:
            polyline(draw, cam, ring(x, y, z_ring, r + infl), RING + (200,), 3)
        if "diver" in rec and meta.get("diver_r"):
            dx, dy, dz = rec["diver"]
            polyline(draw, cam, ring(dx, dy, dz, meta["diver_r"] + infl), RING + (220,), 3)
    for k, r in enumerate(rec["rov"]):
        p = np.array(r["pos"]) + [0, 0, 0.35]
        if meta.get("nav"):
            arrow(draw, cam, p, r["u_nom"], NOM + (230,), width=4)
            arrow(draw, cam, p, r["u_safe"], (ACTIVE if r["filter"] else SAFE) + (255,), width=6)
        c = cam.project(np.array(r["pos"]) + [0, 0, 0.9])
        if c is not None:
            label = f"ROV {k + 1}"
            if r["filter"]:
                label += "  HOCBF ACTIVE"
            tw = draw.textlength(label, font=fonts["s"])
            draw.rounded_rectangle([c[0] - tw / 2 - 8, c[1] - 30, c[0] + tw / 2 + 8, c[1] - 2], 6,
                                   fill=(ACTIVE if r["filter"] else ROV_COLORS[k]) + (210,))
            draw.text((c[0] - tw / 2, c[1] - 28), label, font=fonts["s"], fill=(10, 10, 10))
    if panel:
        draw_panel(img, rec, meta, fonts, img.width / 1920.0)
    return img


def draw_panel(img, rec, meta, fonts, sc):
    """Status panel + legend (geometry designed at 1920 px wide, scaled by sc)."""
    draw = ImageDraw.Draw(img, "RGBA")
    x0, y0, w = int(24 * sc), int(24 * sc), int(540 * sc)
    row = int(46 * sc)
    h = int(70 * sc) + row * len(rec["rov"]) + (int(34 * sc) if meta.get("hocbf") else 0)
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], 14, fill=(5, 20, 30, 185))
    draw.text((x0 + int(18 * sc), y0 + int(12 * sc)), "ABYSS  |  autonomous net-pen inspection", font=fonts["b"],
              fill=(230, 245, 255))
    mode = ("HOCBF safety filter ON" if meta.get("hocbf") else "safety filter OFF") + \
           ("  (sonar-based)" if meta.get("perception") else "")
    draw.text((x0 + int(18 * sc), y0 + int(44 * sc)), f"t = {rec['t']:6.1f} s    {mode}", font=fonts["s"],
              fill=(150, 255, 170) if meta.get("hocbf") else (255, 140, 120))
    for k, r in enumerate(rec["rov"]):
        yy = y0 + int(76 * sc) + row * k
        draw.ellipse([x0 + int(18 * sc), yy + int(6 * sc), x0 + int(34 * sc), yy + int(22 * sc)], fill=ROV_COLORS[k])
        status = "returning" if r["done"] else ("AVOIDING" if r["filter"] else "inspecting")
        clr = r["clr"] if r["clr"] < 8.9 else float("nan")
        line = f"ROV {k + 1}  {status:<10}  photos {r['shots']:3d}   clearance {clr:4.2f} m"
        draw.text((x0 + int(44 * sc), yy + int(2 * sc)), line, font=fonts["s"],
                  fill=(255, 120, 110) if r["filter"] else (230, 240, 245))
    if meta.get("hocbf"):
        worst = min(r["min_clr"] for r in rec["rov"])
        cont = sum(r["contacts"] for r in rec["rov"])
        draw.text((x0 + int(18 * sc), y0 + h - int(34 * sc)), f"min clearance so far {worst:+.2f} m     contacts {cont}",
                  font=fonts["s"], fill=(150, 255, 170) if cont == 0 else (255, 120, 110))
    # legend
    lx, ly = img.width - int(330 * sc), int(24 * sc)
    draw.rounded_rectangle([lx, ly, lx + int(306 * sc), ly + int(112 * sc)], 12, fill=(5, 20, 30, 170))
    for i, (col, txt) in enumerate([(NOM, "planned command"), (SAFE, "HOCBF-safe command"),
                                    (ACTIVE, "filter intervening"), (RING, "safety boundary")]):
        yl = ly + int((20 + 24 * i) * sc)
        draw.line([lx + int(16 * sc), yl, lx + int(56 * sc), yl], fill=col, width=5)
        draw.text((lx + int(66 * sc), yl - int(10 * sc)), txt, font=fonts["xs"], fill=(230, 240, 245))
    return img


def tile(img_main, rov_imgs, rec, fonts):
    W = img_main.width
    n = len(rov_imgs)
    tw = W // n
    th = int(tw * rov_imgs[0].height / rov_imgs[0].width)
    out = Image.new("RGB", (W, img_main.height + th), (0, 0, 0))
    out.paste(img_main, (0, 0))
    draw = ImageDraw.Draw(out, "RGBA")
    for i, (k, im) in enumerate(rov_imgs_items(rov_imgs)):
        x = i * tw
        out.paste(im.resize((tw, th)), (x, img_main.height))
        r = rec["rov"][k]
        col = ACTIVE if r["filter"] else ROV_COLORS[k]
        draw.rectangle([x, img_main.height, x + tw - 1, img_main.height + th - 1], outline=col, width=4)
        draw.rounded_rectangle([x + 10, img_main.height + 10, x + 250, img_main.height + 40], 6, fill=(5, 20, 30, 190))
        draw.text((x + 20, img_main.height + 13), f"ROV {k + 1} camera", font=fonts["s"], fill=col)
        if k in rec.get("shot", []):
            draw.rectangle([x, img_main.height, x + tw - 1, img_main.height + th - 1], fill=(255, 255, 255, 110))
            draw.text((x + tw - 130, img_main.height + 13), "PHOTO", font=fonts["b"], fill=(255, 255, 255))
    return out


def rov_imgs_items(rov_imgs):
    return list(rov_imgs.items()) if isinstance(rov_imgs, dict) else list(enumerate(rov_imgs))


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


VIEW_FILE = {"demo": "abyss_orbit.mp4", "section": "abyss_section.mp4", "grid": "abyss_grid.mp4"}


def view_cam(meta, rec, view, W, H):
    info = meta.get("views", {}).get(view) or {"focal": meta["demo_focal"], "h_aperture": meta["demo_h_aperture"],
                                               "target": meta["demo_target"]}
    eye = rec.get("eyes", {}).get(view) or rec["eye"]
    return Cam(eye, info["target"], info["focal"], info["h_aperture"], W, H)


def compose(d, rec, meta, layout, rov_cams, fonts, W, H):
    if layout == "grid":
        halves = []
        small = fonts.get("small_set") or fonts
        for v in ("demo", "section"):
            img = Image.open(os.path.join(d, v, f"{rec['i']:05d}.png")).convert("RGB").resize((W // 2, H // 2))
            img = annotate_main(img, rec, meta, view_cam(meta, rec, v, W // 2, H // 2), small, panel=False)
            halves.append(img)
        top = Image.new("RGB", (W, H // 2))
        top.paste(halves[0], (0, 0))
        top.paste(halves[1], (W // 2, 0))
        draw = ImageDraw.Draw(top, "RGBA")
        for x, title in ((0, "OVERVIEW"), (W // 2, "CUTAWAY  (near net wall removed)")):
            draw.text((x + W // 2 - int(14 * W / 1920) - draw.textlength(title, font=small["b"]), H // 2 - int(40 * W / 1920)),
                      title, font=small["b"], fill=(230, 245, 255))
        draw.line([(W // 2, 0), (W // 2, H // 2)], fill=(5, 20, 30), width=4)
        draw_panel(top, rec, meta, small, 0.72 * W / 1920.0)
        img = top
    else:
        img = Image.open(os.path.join(d, layout, f"{rec['i']:05d}.png")).convert("RGB")
        img = annotate_main(img, rec, meta, view_cam(meta, rec, layout, W, H), fonts)
    if rov_cams:
        rov_imgs = {int(c[-1]): Image.open(os.path.join(d, c, f"{rec['i']:05d}.png")).convert("RGB") for c in rov_cams}
        img = tile(img, rov_imgs, rec, fonts)
    if img.width % 2 or img.height % 2:
        img = img.crop((0, 0, img.width - img.width % 2, img.height - img.height % 2))
    return img


def render(d, meta, recs, layout, rov_cams, fps, out_path, crf, W, H):
    need = ["demo", "section"] if layout == "grid" else [layout]
    frames = [r for r in recs if all(os.path.exists(os.path.join(d, c, f"{r['i']:05d}.png")) for c in need + rov_cams)]
    if not frames:
        print(f"[video] {layout}: no complete frames, skipped")
        return
    sc = W / 1920.0
    fonts = {"xs": font(max(10, int(18 * sc))), "s": font(max(12, int(22 * sc))),
             "b": font(max(14, int(26 * sc)), bold=True)}
    s2 = 0.72 * sc
    fonts["small_set"] = {"xs": font(max(9, int(18 * s2))), "s": font(max(10, int(22 * s2))),
                          "b": font(max(11, int(26 * s2)), bold=True)}
    flash_frames, last_shot = max(1, int(0.4 * fps)), {}
    ffmpeg, proc, png_dir = find_ffmpeg(), None, None
    print(f"[video] {layout}: {len(frames)} frames at {fps:.0f} fps -> {out_path}")
    for n, rec in enumerate(frames):
        rec = dict(rec)
        for k in rec.get("shot", []):
            last_shot[k] = n
        rec["shot"] = [k for k, f in last_shot.items() if n - f < flash_frames]
        img = compose(d, rec, meta, layout, rov_cams, fonts, W, H)
        if ffmpeg:
            if proc is None:
                proc = subprocess.Popen([ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                                         "-s", f"{img.width}x{img.height}", "-r", f"{fps}", "-i", "-",
                                         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf),
                                         "-preset", "medium", out_path], stdin=subprocess.PIPE)
            proc.stdin.write(img.tobytes())
        else:
            png_dir = png_dir or os.path.join(d, f"annotated_{layout}")
            os.makedirs(png_dir, exist_ok=True)
            img.save(os.path.join(png_dir, f"{n:05d}.png"))
        if n % 200 == 0:
            print(f"[video]   {layout} frame {n}/{len(frames)}")
    if proc is not None:
        proc.stdin.close()
        proc.wait()
        print(f"[video] wrote {os.path.abspath(out_path)}")
    else:
        print(f"[video] ffmpeg not found -> frames in {png_dir}\n"
              f"        encode later:  ffmpeg -r {fps} -i {png_dir}/%05d.png -c:v libx264 -pix_fmt yuv420p {out_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rec_dir")
    ap.add_argument("--views", default=None, help="comma list of demo,section,grid (default: all recorded)")
    ap.add_argument("--fps", type=float, default=None)
    ap.add_argument("--no-tiles", action="store_true", help="no ROV camera strip")
    ap.add_argument("--crf", type=int, default=18, help="x264 quality (lower = better, 18 is visually lossless)")
    args = ap.parse_args()
    d = args.rec_dir
    meta = json.load(open(os.path.join(d, "meta.json")))
    recs = [json.loads(l) for l in open(os.path.join(d, "telemetry.jsonl")) if l.strip()]
    fps = args.fps or meta.get("fps", 30)
    W, H = meta["demo_res"]
    cams = meta["cams"]
    rov_cams = [] if args.no_tiles else [c for c in cams if c.startswith("auv")]
    views = [v for v in ("demo", "section") if v in cams]
    if "demo" in cams and "section" in cams:
        views.append("grid")
    if args.views:
        views = [v for v in args.views.split(",") if v in views]
    for v in views:
        render(d, meta, recs, v, rov_cams, fps, os.path.join(d, VIEW_FILE[v]), args.crf, W, H)


if __name__ == "__main__":
    main()
