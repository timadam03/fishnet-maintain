"""
score_loop.py -- how good were the decision layer's choices? Scores plans (and mission results)
against the sim's ground truth, so the rules grader and the d1 grader can be compared on the
same sweep.

    python abyss-sim/tools/score_loop.py <loop_dir> [--db C:\\fishnet\\shoal.db]

Reads  <loop_dir>/run_sweep/ground_truth.json      where the holes, thinning and fouling really are
       <loop_dir>/run_sweep/plan*.json             every plan made from that sweep (plan_rules, plan_d1, ...)
       --db shoal.db (optional)                    mission results, to check what the close-ups concluded

Ground truth is used only here, for scoring. The decision layer never sees it.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sqlite3
import sys


class Tee:
    """Writes to the console and a file at once."""

    def __init__(self, *streams):
        self.streams = streams

    def write(self, text):
        for s in self.streams:
            s.write(text)

    def flush(self):
        for s in self.streams:
            s.flush()


def covered_cells(patches, grid):
    """Cells each disk-shaped defect (hole or patch) touches, sampled on a fine grid."""
    sectors, rows = grid["ui_sectors"], grid["ui_wall_rows"]
    r_cage, depth = grid["cage_radius_m"], grid["cage_depth_m"]
    out = set()
    for p in patches:
        rad = p["radius"]
        for i in range(-6, 7):
            for j in range(-6, 7):
                du, dv = i / 6 * rad, j / 6 * rad
                if du * du + dv * dv > rad * rad:
                    continue
                th, z = p["theta"] + du / r_cage, p["z"] + dv
                if not -depth <= z <= 0:
                    continue
                col = int((th % (2 * math.pi)) // (2 * math.pi / sectors)) % sectors
                row = int(min(rows - 1, max(0.0, -z) / depth * rows))
                out.add(row * sectors + col)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("loop_dir")
    ap.add_argument("--db", help="shoal.db, to score the mission results of the last plan run too")
    ap.add_argument("--top", type=int, default=5, help="how many of the first targets count as 'first look'")
    ap.add_argument("--save", help="also write the report to this file (UTF-8), e.g. for make_loop_video.py")
    args = ap.parse_args()
    if args.save:
        sys.stdout = Tee(sys.stdout, open(args.save, "w", encoding="utf-8"))

    sweep = os.path.join(args.loop_dir, "run_sweep")
    with open(os.path.join(sweep, "ground_truth.json")) as f:
        truth = json.load(f)
    grid = truth["grid"]
    holes = truth["holes"]
    hole_cells = [covered_cells([h], grid) for h in holes]
    any_hole = set().union(*hole_cells) if hole_cells else set()
    thin = covered_cells(truth.get("thin_patches", []), grid)
    foul = covered_cells(truth.get("foul_patches", []), grid)

    def kind(cell):
        return "HOLE" if cell in any_hole else "thin" if cell in thin else "foul" if cell in foul else "-"

    print(f"ground truth (seed {truth.get('defect_seed')}): {len(holes)} holes on cells {sorted(any_hole)}, "
          f"thinning on {len(thin)} cells, fouling on {len(foul)} cells")
    for h, cells in zip(holes, hole_cells):
        print(f"  hole r={h['radius']:.2f} m  centre cell {h['cell']}  covers {sorted(cells)}")

    rows = []
    for path in sorted(glob.glob(os.path.join(sweep, "plan*.json"))):
        with open(path) as f:
            plan = json.load(f)
        targets = plan["targets"]
        name = os.path.splitext(os.path.basename(path))[0]
        print(f"\n{name}  ({plan.get('rules_version')}, {len(targets)} targets)")
        for rank, t in enumerate(targets, 1):
            rules = "+".join(r["rule"] for r in t["reasons"][1:])
            print(f"  {rank:2d}. cell {t['cell']:3d} [{kind(t['cell']):4s}] p={t['priority']:.2f} "
                  f"AUV {'+'.join(map(str, t['robots']))} {t['scan']['standoff_m']} m  {rules}")
        cells = [t["cell"] for t in targets]
        found = [next((i for i, c in enumerate(cells, 1) if c in hc), None) for hc in hole_cells]
        big = [i for i, h in enumerate(holes) if h["radius"] >= 0.25]
        useful = sum(kind(c) != "-" for c in cells)
        top = cells[: args.top]
        rows.append({
            "plan": name,
            "targets": len(cells),
            "holes": f"{sum(f is not None for f in found)}/{len(holes)}",
            "big holes": f"{sum(found[i] is not None for i in big)}/{len(big)}",
            f"holes in top {args.top}": sum(any(c in hc for c in top) for hc in hole_cells),
            "first hole at": min((f for f in found if f), default="-"),
            "on a defect": f"{useful}/{len(cells)}",
            "wasted": len(cells) - useful,
        })

    if rows:
        keys = list(rows[0])
        widths = {k: max(len(k), *(len(str(r[k])) for r in rows)) for k in keys}
        print("\n" + "  ".join(k.ljust(widths[k]) for k in keys))
        for r in rows:
            print("  ".join(str(r[k]).ljust(widths[k]) for k in keys))
        print("holes = holes with at least one target on a cell they cover; wasted = targets on clean net")
    else:
        print(f"no plan*.json in {sweep}")

    if args.db and os.path.isfile(args.db):
        con = sqlite3.connect(args.db)
        ms = con.execute("SELECT id, cells_json, status, result FROM missions WHERE status = 'done' ORDER BY id").fetchall()
        if ms:
            print("\nmission results vs ground truth (last plan run in this database)")
            right = 0
            for mid, cells_json, _, result in ms:
                cell = json.loads(cells_json)[0]
                said_open = result.startswith(("confirmed: opening", "possible opening"))
                said_wear = result.startswith("confirmed: wear")
                said_clear = result.startswith(("clear", "not found again"))
                k = kind(cell)
                ok = (k == "HOLE" and said_open) or (k == "thin" and (said_wear or said_open)) or (k in ("-", "foul") and said_clear)
                right += ok
                print(f"  #{mid:<3d} cell {cell:3d} [{k:4s}] {'OK ' if ok else 'XX '} {result}")
            print(f"  {right}/{len(ms)} missions concluded correctly (unsure / needs another look counts as not correct)")


if __name__ == "__main__":
    main()
