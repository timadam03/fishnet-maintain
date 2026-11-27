"""
plan_mode.py -- turns the decision layer's inspection plan (plan.json) into waypoints for
fishfarm_demo.py --plan. numpy only, so it runs in Isaac Sim's python and on a laptop
(tests: tests/test_plan_mode.py).

The plan format is contracts/inspection-plan.schema.json on the decision-layer branch. Only grid
positions cross the seam: a target is a cell (row * sectors + col) with its centre angle and
depth fraction, and this module converts that to metres for this pen.

How a target is flown:
- one waypoint per viewpoint, `standoff_m` from the net, aimed at the cell centre, so offset
  viewpoints look at the same spot from another angle;
- when a target lists several robots, the viewpoints are shared out between them and the robots
  take turns on the target (fishfarm_demo.py holds a lock per target), because two robots next to
  each other at the target would block each other under the HOCBF;
- `shots` photos per waypoint and `margin_m` as that robot's HOCBF inflation.
"""
from __future__ import annotations

import json
import math

import numpy as np

Z_EDGE = 0.5        # [m] keep waypoints this far below the surface and above the sinker ring


def load_plan(path, sectors, wall_rows):
    """Reads plan.json and refuses a plan made for a different cell grid."""
    with open(path) as f:
        plan = json.load(f)
    grid = plan.get("grid", {})
    if grid.get("sectors") != sectors or grid.get("wall_rows") != wall_rows:
        raise ValueError(f"plan {plan.get('plan_id')} is for a {grid.get('sectors')} x {grid.get('wall_rows')} grid, "
                         f"this sim uses {sectors} x {wall_rows} (UI_SECTORS / UI_WALL_ROWS)")
    return plan


def cell_centre(cell, sectors, wall_rows):
    """Centre of a cell: (theta [rad], depth as a fraction of the wall depth)."""
    row, col = divmod(cell, sectors)
    return math.radians((col + 0.5) * 360.0 / sectors), (row + 0.5) / wall_rows


def waypoint(theta_aim, theta_at, depth_frac, standoff, cage_r, cage_depth, **extra):
    """A photo spot `standoff` m inside the net at angle `theta_at`, looking at the net at `theta_aim`.

    The vehicle only yaws, so it looks horizontally: the depth it photographs is its own depth.
    """
    if standoff <= 0 or standoff >= cage_r:
        raise ValueError(f"standoff {standoff} m is outside (0, {cage_r}) for this pen")
    z = -min(cage_depth - Z_EDGE, max(Z_EDGE, depth_frac * cage_depth))
    r = cage_r - standoff
    pos = np.array([r * math.cos(theta_at), r * math.sin(theta_at), z])
    aim = np.array([cage_r * math.cos(theta_aim), cage_r * math.sin(theta_aim)])
    dx, dy = aim - pos[:2]
    wp = {"pos": pos, "yaw": math.atan2(dy, dx), "theta": theta_aim, "z": float(z), "band": None,
          "standoff": standoff, "look_dist": math.hypot(dx, dy)}
    wp.update(extra)
    return wp


def target_waypoints(plan, n_auv, cage_r, cage_depth):
    """Per robot, the waypoints for the plan's targets, best target first."""
    out = [[] for _ in range(n_auv)]
    for t in plan["targets"]:
        robots, views = t["robots"], t["scan"]["viewpoints"]
        bad = [k for k in robots if not 0 <= k < n_auv]
        if bad:
            raise ValueError(f"target {t['target_id']} asks for AUV {bad}, this sim has {n_auv}")
        if t["scan"]["standoff_m"] < t["safety"]["margin_m"]:
            raise ValueError(f"target {t['target_id']}: standoff {t['scan']['standoff_m']} m is inside its "
                             f"safety margin {t['safety']['margin_m']} m, so the HOCBF can't reach it")
        for j, k in enumerate(robots):
            # More viewpoints than robots: share them out. Fewer: each robot takes one, in turn.
            mine = [i for i in range(len(views)) if i % len(robots) == j] if len(views) >= len(robots) \
                else [j % len(views)]
            for i in mine:
                v = views[i]
                out[k].append(waypoint(
                    math.radians(t["theta_deg"]), math.radians(t["theta_deg"] + v["d_theta_deg"]),
                    t["depth_frac"] + v["d_depth_frac"], t["scan"]["standoff_m"], cage_r, cage_depth,
                    target_id=t["target_id"], cell=t["cell"], viewpoint=i,
                    margin=t["safety"]["margin_m"], shots=t["scan"]["shots"]))
    return out


def coverage_waypoints(plan, n_auv, cage_r, cage_depth, standoff, margin, limit):
    """Per robot, the first `limit` coverage cells (stalest first), each in its robot's sector."""
    sectors, wall_rows = plan["grid"]["sectors"], plan["grid"]["wall_rows"]
    out = [[] for _ in range(n_auv)]
    for cell in plan["coverage"][:limit]:
        theta, frac = cell_centre(cell, sectors, wall_rows)
        k = min(n_auv - 1, int(theta // (2 * math.pi / n_auv)))
        out[k].append(waypoint(theta, theta, frac, standoff, cage_r, cage_depth,
                               target_id=None, cell=cell, viewpoint=0, margin=margin, shots=1))
    return out


def build_waypoints(plan, n_auv, cage_r, cage_depth, *, coverage_standoff, base_margin,
                    revisits=0, coverage_limit=0):
    """Per robot: its targets, then coverage. `revisits` > 0 flies the targets again that many
    times, spread through the coverage, so the ranked areas are looked at more often."""
    targets = target_waypoints(plan, n_auv, cage_r, cage_depth)
    cover = coverage_waypoints(plan, n_auv, cage_r, cage_depth, coverage_standoff, base_margin, coverage_limit)
    passes = revisits + 1
    out = []
    for k in range(n_auv):
        chunks = np.array_split(np.arange(len(cover[k])), passes)
        seq = []
        for p in range(passes):
            seq += [dict(w, pos=w["pos"].copy(), visit=p) for w in targets[k]]
            seq += [dict(cover[k][i], visit=p) for i in chunks[p]]
        out.append(seq)
    return out


def drop_blocked(waypoints, obstacles, slack=0.2):
    """Splits waypoints into (reachable, blocked): blocked ones sit inside a rope's HOCBF keep-out."""
    kept, blocked = [], []
    for w in waypoints:
        ok = all(math.hypot(w["pos"][0] - x, w["pos"][1] - y) > r + w["margin"] + slack for x, y, r in obstacles)
        (kept if ok else blocked).append(w)
    return kept, blocked


def take_turn(locks, k, held, wanted):
    """Robots sharing a target take turns. AUV k holds target `held` and wants to fly to a waypoint
    of target `wanted` (None for a coverage waypoint). `locks` maps target_id -> AUV on it.

    Leaving a target hands it over. Returns (may_go, target_now_held).
    """
    if held and held != wanted:
        locks.pop(held, None)
        held = None
    if wanted is None:
        return True, None
    if locks.get(wanted, k) != k:
        return False, held
    locks[wanted] = k
    return True, wanted


def ramp_margin(current, target, feasible, slack=0.02):
    """Next HOCBF inflation for one robot.

    Lowering is safe at once. Raising past what the robot already clears (`feasible`, its distance
    to the nearest surface) would start the barrier out violated, so the margin only grows as the
    robot moves clear.
    """
    if target <= current:
        return target
    return min(target, max(current, feasible - slack))
