"""
run_vision.py -- the image-pipeline step of the closed loop.

Runs the net detector (perception/net_inspect.py) on every photo of a sim run and writes
vision.jsonl in the decision layer's contract (contracts/vision-report.schema.json on the
decision-layer branch).

    python abyss-sim/tools/run_vision.py <run_dir> [--overlays]

Reads  <run_dir>/captures.jsonl   (written by fishfarm_demo.py)
Writes <run_dir>/vision.jsonl     one line per photo, including photos where nothing was found:
                                  "looked, nothing there" is the evidence that clears an area
       <run_dir>/overlays/...     with --overlays, each photo with its detections drawn on

Then:  npm run cli -- import <run_dir>   (in decision-layer/), in place of the stand-in grader.

Plain Python with opencv-python and numpy. It does not need Isaac Sim, so it runs on any machine.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import cv2 as cv
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "perception"))
from net_inspect import Config, inspect_frame  # noqa: E402

MODEL = "net-inspect-cv-v1"

# Camera of fishfarm_demo.py (FOCAL, H_APERTURE): used only to turn a pixel size into metres.
HFOV = 2 * math.atan(20.955 / (2 * 18.0))
CAM_FWD, CAM_UP = 0.24, 0.02     # camera mount on the vehicle: set_xform(cam, (0.24, 0, 0.02), ...)
GRID_DEFAULT = {"ui_sectors": 24, "ui_wall_rows": 8, "cage_radius_m": 8.0, "cage_depth_m": 8.0}

# Mesh pitch (pixels per mesh opening, in the detector's working image) below which the mesh can't
# be made out, and at which everything can be judged. 14 px is the detector's own bar for judging
# thinning (`resolved` in net_inspect._thinning); holes are still found below it, so the ramp
# passes 0.5 a little under 10 px rather than at 14.
PITCH_BLIND, PITCH_CLEAR = 5.0, 14.0


def to_class(det):
    """The detector's `type` to the contract's `class`."""
    kind = det["type"]
    if kind != "unknown":
        return kind  # hole, thinning, biofouling all exist in the contract as they are
    # "unknown" means the detector saw something but could not commit. Which detector produced it
    # decides what it is a candidate for; its confidence is already capped low, which puts it in
    # the decision layer's "unsure, look again" band.
    return "thinning" if det.get("evidence") == "apparent_width" else "mesh_opening"


def to_severity(value):
    return "low" if value < 0.4 else "medium" if value < 0.7 else "high"


def look_distance(capture, cage_r):
    """Camera-to-net distance for this photo [m]."""
    if capture.get("look_dist"):
        return float(capture["look_dist"])          # plan-mode and aimed survey photos carry it
    x, y = capture["position"][:2]
    return max(0.3, cage_r - math.hypot(x, y))       # otherwise: distance to the net along the radius


def camera_yaw(capture, cage_r):
    """Heading of the camera [rad]: recorded by the sim, or (older runs) towards the aimed net point."""
    if "yaw_deg" in capture:
        return math.radians(float(capture["yaw_deg"]))
    x, y = capture["position"][:2]
    th = math.radians(float(capture["theta_deg"]))
    return math.atan2(cage_r * math.sin(th) - y, cage_r * math.cos(th) - x)


def pixel_on_net(capture, px, py, width, height, grid):
    """Where the pixel (px, py) of this photo lands on the net wall: (theta [rad], z [m]).

    Pinhole camera looking along the vehicle's heading, image right = clockwise (smaller theta),
    image up = +z. The ray is cast from the camera to the cylinder of the net wall.
    """
    cage_r = grid["cage_radius_m"]
    yaw = camera_yaw(capture, cage_r)
    f = (width / 2) / math.tan(HFOV / 2)
    u, v = (px - width / 2) / f, (py - height / 2) / f          # right, down (per unit forward)
    x, y, z = capture["position"]
    cx, cy, cz = x + CAM_FWD * math.cos(yaw), y + CAM_FWD * math.sin(yaw), z + CAM_UP
    head = yaw - math.atan(u)
    dx, dy = math.cos(head), math.sin(head)
    b = cx * dx + cy * dy
    t = -b + math.sqrt(max(0.0, b * b - (cx * cx + cy * cy - cage_r * cage_r)))   # horizontal range
    theta = math.atan2(cy + t * dy, cx + t * dx)
    return theta, cz - v * t / math.sqrt(1 + u * u)


def ui_cell(theta, z, grid):
    """Same as fishfarm_demo.ui_cell: row * sectors + col, row 0 at the surface, col 0 at 0 deg."""
    sectors, rows = int(grid["ui_sectors"]), int(grid["ui_wall_rows"])
    col = int((theta % (2 * math.pi)) // (2 * math.pi / sectors)) % sectors
    row = int(min(rows - 1, max(0.0, -z) / grid["cage_depth_m"] * rows))
    return row * sectors + col


def cells_in_view(capture, width, height, grid, detections):
    """Every cell this photo shows a real part of, so "looked, nothing there" counts for all of them.

    A far survey photo spans about 4 x 4 cells; crediting it only to its centre cell would leave
    most of the net unseen as far as the decision layer knows.
    """
    hits = {}
    for i in range(8):
        for j in range(5):
            at = pixel_on_net(capture, (i + 0.5) * width / 8, (j + 0.5) * height / 5, width, height, grid)
            if -grid["cage_depth_m"] <= at[1] <= 0:          # above the surface or below the wall: not net
                c = ui_cell(*at, grid)
                hits[c] = hits.get(c, 0) + 1
    cells = {c for c, n in hits.items() if n >= 2} | {d["cell"] for d in detections}
    return sorted(cells)


def quality(diag):
    """How usable the photo is, from how well the detector could make out the mesh.

    sharpness: how many pixels a mesh opening spans. Too few and holes and thin twine can't be judged,
               which is exactly the case where the decision layer should send a robot closer.
    visibility: share of the frame where the detector found healthy mesh to compare against.
    Both are proxies; the detector reports no image-quality score of its own.
    """
    pitch = math.sqrt(diag.get("typical_opening_area_px") or 0.0)
    if not pitch:
        return {"visibility": 0.0, "sharpness": 0.0}
    sharp = (pitch - PITCH_BLIND) / (PITCH_CLEAR - PITCH_BLIND)
    valid = diag.get("valid")
    vis = float(np.mean(valid != 0)) * 1.5 if valid is not None else 0.5
    return {"visibility": round(float(np.clip(vis, 0, 1)), 3),
            "sharpness": round(float(np.clip(sharp, 0, 1)), 3)}


def report(capture, frame, grid, overlay_path=None):
    """One vision.jsonl line for one photo."""
    mode = "investigation" if capture.get("target_id") else "survey"
    diag = {}
    dets, annotated = inspect_frame(frame, config=Config(mode=mode), tracker=None,
                                    render=overlay_path is not None, diagnostics=diag)
    height, width = frame.shape[:2]
    px_per_m = width / (2 * look_distance(capture, grid["cage_radius_m"]) * math.tan(HFOV / 2))

    out, fouled_px = [], 0
    for d in dets:
        cls = to_class(d)
        item = {"class": cls, "confidence": round(float(d["confidence"]), 3),
                "bbox": [int(v) for v in d["bbox"]], "severity": to_severity(float(d["severity"]))}
        # The cell this detection is on, not the photo's: a far photo spans three or four cells.
        bx, by, bw, bh = d["bbox"]
        px, py = d.get("centroid") or (bx + bw / 2, by + bh / 2)
        at = pixel_on_net(capture, float(px), float(py), width, height, grid)
        item["cell"] = ui_cell(*at, grid)
        item["_at"] = at                  # kept only for the self-check in main(), not written
        if cls in ("hole", "mesh_opening"):
            item["size_m"] = round(max(d["bbox"][2], d["bbox"][3]) / px_per_m, 3)
        if cls == "biofouling":
            fouled_px += int(d.get("projected_area_px", 0))
        out.append(item)

    line = {"image": capture["image"], "model": MODEL, "quality": quality(diag),
            "fouling_pct": round(min(1.0, fouled_px / float(width * height)), 4),
            "cells_in_view": cells_in_view(capture, width, height, grid, out), "detections": out}
    if overlay_path is not None:
        os.makedirs(os.path.dirname(overlay_path), exist_ok=True)
        cv.imwrite(overlay_path, annotated)
    return line


def check_cells(capture, line, grid, tally):
    """Self-check of the detection positions against the sim's ground truth (scoring only).

    For each hole or opening found in a photo with a real hole in view: how far is it from the
    nearest real hole, placed by its own pixel position vs. simply at the photo's centre?
    """
    holes = [h for h in capture.get("holes_in_view") or [] if "theta" in h]
    if not holes:
        return
    r = grid["cage_radius_m"]
    centre = (math.radians(float(capture["theta_deg"])), float(capture["depth"]))

    def miss(at):
        return min(math.hypot(r * math.remainder(at[0] - h["theta"], 2 * math.pi), at[1] - h["z"]) - h["radius"]
                   for h in holes)

    for d in line["detections"]:
        if d["class"] in ("hole", "mesh_opening"):
            tally["own"].append(max(0.0, miss(d["_at"])))
            tally["photo"].append(max(0.0, miss(centre)))
            tally["same_cell"] += d["cell"] in {h["cell"] for h in holes}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("run_dir", help="folder with captures.jsonl and the auv_*/ photos")
    ap.add_argument("--overlays", action="store_true", help="also save each photo with its detections drawn")
    args = ap.parse_args()

    run = os.path.abspath(args.run_dir)
    cap_path = os.path.join(run, "captures.jsonl")
    if not os.path.isfile(cap_path):
        sys.exit(f"no captures.jsonl in {run}")
    grid = dict(GRID_DEFAULT)
    gt_path = os.path.join(run, "ground_truth.json")
    if os.path.isfile(gt_path):
        with open(gt_path) as f:
            grid.update({k: v for k, v in json.load(f).get("grid", {}).items() if k in GRID_DEFAULT})

    with open(cap_path) as f:
        captures = [json.loads(line) for line in f if line.strip()]

    written, missing, counts, qual = 0, [], {}, []
    cell_check = {"own": [], "photo": [], "same_cell": 0}
    with open(os.path.join(run, "vision.jsonl"), "w") as out:
        for c in captures:
            # captures.jsonl stores forward-slash paths; build the real one natively (Windows too).
            img_path = os.path.join(run, *c["image"].split("/"))
            frame = cv.imread(img_path, cv.IMREAD_COLOR)    # BGR uint8, what inspect_frame expects
            if frame is None:
                missing.append(c["image"])
                continue
            ov = os.path.join(run, "overlays", *c["image"].split("/")) if args.overlays else None
            line = report(c, frame, grid, ov)
            if ov is not None:
                line["heatmap"] = "overlays/" + c["image"]
            written += 1
            qual.append(min(line["quality"]["visibility"], line["quality"]["sharpness"]))
            for d in line["detections"]:
                counts[d["class"]] = counts.get(d["class"], 0) + 1
            check_cells(c, line, grid, cell_check)
            for d in line["detections"]:
                d.pop("_at", None)
            out.write(json.dumps(line) + "\n")

    print(f"[vision] {written} photos -> {os.path.join(run, 'vision.jsonl')}")
    print(f"[vision] detections: {counts or 'none'}")
    if qual:
        low = sum(q < 0.5 for q in qual)
        print(f"[vision] image quality: mean {np.mean(qual):.2f}, {low} of {len(qual)} below 0.5 "
              f"(the decision layer will want those re-imaged closer)")
    if cell_check["own"]:
        n = len(cell_check["own"])
        print(f"[vision] position check vs ground truth ({n} openings found in photos with a real hole in view): "
              f"median miss {np.median(cell_check['own']):.2f} m placed by pixel, "
              f"{np.median(cell_check['photo']):.2f} m if placed at the photo centre; "
              f"{cell_check['same_cell']} of {n} on the hole's own cell")
    if missing:
        print(f"[vision] WARNING: {len(missing)} photos listed in captures.jsonl were not found, "
              f"e.g. {missing[0]}")


if __name__ == "__main__":
    main()
