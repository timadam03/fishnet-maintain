"""
plan_mode.py -- turns the decision layer's inspection plan (plan.json) into waypoints for
fishfarm_demo.py --plan. numpy only, so it runs in Isaac Sim's python and on a laptop
(tests: tests/test_plan_mode.py).

The plan format is contracts/inspection-plan.schema.json on the decision-layer branch. Only grid
positions cross the seam: a target is a cell (row * sectors + col) with its centre angle and
depth fraction, and this module converts that to metres for this pen.

How a target is flown:
- one waypoint per viewpoint, `standoff_m` from the net, aimed at the target's `aim` point (where
  the survey saw the defect; the cell centre if there is none), so offset viewpoints look at the
  same spot from another angle. align.py then corrects the aim from the live picture;
- when a target lists several robots, the viewpoints are shared out between them and the robots
  take turns on the target (fishfarm_demo.py holds a lock per target), because two robots next to
  each other at the target would block each other under the HOCBF;
- `shots` photos per waypoint and `margin_m` as that robot's HOCBF inflation.
"""
from __future__ import annotations

import heapq
import json
import math

import numpy as np

Z_EDGE = 0.5        # [m] keep waypoints this far below the surface and above the sinker ring
CAM_UP = 0.02       # [m] camera above the vehicle's centre


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


def aimed_waypoint(theta, z, d_theta, standoff, cage_r, cage_depth, **extra):
    """A photo spot that puts the net point (theta, z) in the middle of the picture. `d_theta` [rad]
    moves the vehicle round the pen for another angle on the same point."""
    return waypoint(theta, theta + d_theta, (CAM_UP - z) / cage_depth, standoff, cage_r, cage_depth, **extra)


def view_blocked(wp, obstacles, cage_r, slack=0.2):
    """A rope is too close to the photo spot, or hangs between the camera and the point aimed at."""
    x0, y0 = wp["pos"][0], wp["pos"][1]
    dx, dy = cage_r * math.cos(wp["theta"]) - x0, cage_r * math.sin(wp["theta"]) - y0
    for x, y, r in obstacles:
        if math.hypot(x0 - x, y0 - y) <= r + wp["margin"] + slack:
            return True
        s = min(1.0, max(0.0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
        if math.hypot(x0 + s * dx - x, y0 + s * dy - y) <= r:
            return True
    return False


# Other places to photograph the same point from, nearest to the planned one first.
VIEW_D_THETA = [math.radians(d) for d in (0, 5, -5, 10, -10, 15, -15)]
VIEW_D_STANDOFF = (0.0, 0.3)


def clear_view(wp, standoff, obstacles, cage_r, cage_depth):
    """The aimed waypoint `wp`, moved round or back until no rope is in the way. None if none works."""
    for back in VIEW_D_STANDOFF:
        for turn in VIEW_D_THETA:
            new = aimed_waypoint(wp["theta"], wp["aim_z"], wp["aim_d_theta"] + turn, standoff + back,
                                 cage_r, cage_depth)
            moved = dict(wp, **{k: new[k] for k in ("pos", "yaw", "z", "look_dist", "standoff")})
            if not view_blocked(moved, obstacles, cage_r):
                return moved
    return None


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
                common = dict(target_id=t["target_id"], cell=t["cell"], viewpoint=i,
                              margin=t["safety"]["margin_m"], shots=t["scan"]["shots"])
                aim = t.get("aim")
                if aim:     # where the survey saw the defect. A depth offset would move it off centre.
                    theta, d_theta = math.radians(aim["theta_deg"]), math.radians(v["d_theta_deg"])
                    z = -aim["depth_frac"] * cage_depth
                    out[k].append(aimed_waypoint(theta, z, d_theta, t["scan"]["standoff_m"], cage_r, cage_depth,
                                                 aim_kind=aim["kind"], aim_z=z, aim_d_theta=d_theta,
                                                 planned_standoff=t["scan"]["standoff_m"], **common))
                else:
                    out[k].append(waypoint(
                        math.radians(t["theta_deg"]), math.radians(t["theta_deg"] + v["d_theta_deg"]),
                        t["depth_frac"] + v["d_depth_frac"], t["scan"]["standoff_m"], cage_r, cage_depth, **common))
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


class Router:
    """The way around the ropes and the other robots, one per robot.

    The HOCBF filter only stops a robot from getting too close: steering straight at a goal behind a
    rope, it parks in front of the rope until the waypoint times out. This finds a path on a grid of
    the pen's horizontal plane and gives the controller a point a short way along it to steer for.
    The filter still has the last word on safety.
    """
    CELL = 0.2          # [m] grid spacing
    SLACK = 0.1         # [m] the path keeps this much more than the HOCBF margin
    LOOKAHEAD = 1.2     # [m] how far along the path to steer
    REPLAN = 0.5        # [s] the other robots move, so the path is refreshed
    ROBOT_R = 0.35      # [m] another robot's radius

    def __init__(self, obstacles, net_radius):
        self.obstacles = np.asarray(obstacles, float).reshape(-1, 3)
        self.net_radius = net_radius
        n = int(math.ceil(net_radius / self.CELL))
        self.axis = np.arange(-n, n + 1) * self.CELL
        self.x, self.y = np.meshgrid(self.axis, self.axis, indexing="ij")
        self.path, self.key, self.planned_at = None, None, -math.inf

    def aim(self, t, pos, goal, margin, others=()):
        """The point to steer for now: `goal` itself once nothing is in the way."""
        pos, goal = np.asarray(pos, float)[:2], np.asarray(goal, float)[:2]
        key = (round(float(goal[0]), 2), round(float(goal[1]), 2), margin)
        if key != self.key or t - self.planned_at >= self.REPLAN:
            self.key, self.planned_at = key, t
            circles = [(x, y, r + margin + self.SLACK) for x, y, r in self.obstacles]
            robots = [(p[0], p[1], self.ROBOT_R + margin + self.SLACK) for p in others]
            # A robot sitting on the goal cannot be routed around: head for it anyway and let the
            # HOCBF hold this one off until the spot is free.
            self.circles = circles + [c for c in robots if math.hypot(goal[0] - c[0], goal[1] - c[1]) > c[2]]
            self.wall = max(self.net_radius - margin - self.SLACK / 2, float(np.linalg.norm(goal)))
            self.path = None if self._clear(pos, goal) else self._search(pos, goal)
        if self.path is None:
            return goal
        i = int(np.argmin(np.linalg.norm(self.path - pos, axis=1)))
        best = self.path[min(i + 1, len(self.path) - 1)]
        for p in self.path[i + 1:]:
            if np.linalg.norm(p - pos) > self.LOOKAHEAD or not self._clear(pos, p):
                break
            best = p
        return best

    def _clear(self, a, b):
        """Is the straight line a -> b outside every keep-out? A start already inside one only has
        to not go deeper into it."""
        d = b - a
        dd = float(d @ d)
        for x, y, r in self.circles:
            c = np.array([x, y])
            s = 0.0 if dd == 0 else min(1.0, max(0.0, float((c - a) @ d) / dd))
            if np.linalg.norm(a + s * d - c) < min(r, np.linalg.norm(a - c)) - 1e-6:
                return False
        return np.linalg.norm(b) <= max(self.wall, np.linalg.norm(a)) + 1e-6

    def _search(self, start, goal):
        """A* from start to goal. Cells inside a keep-out cost much more instead of being closed, so
        a robot that starts inside one (or a goal that has no clear way in) still gets a path."""
        cost = np.where(np.hypot(self.x, self.y) > self.wall, 50.0, 1.0)
        for x, y, r in self.circles:
            cost[np.hypot(self.x - x, self.y - y) < r] = 50.0
        n = len(self.axis)
        index = lambda p: tuple(int(v) for v in np.clip(np.round(p / self.CELL) + n // 2, 0, n - 1))
        s, g = index(start), index(goal)
        cost = cost.tolist()
        steps = [(i, j, math.hypot(i, j)) for i in (-1, 0, 1) for j in (-1, 0, 1) if i or j]
        best, came, queue = {s: 0.0}, {}, [(0.0, s)]
        while queue:
            _, c = heapq.heappop(queue)
            if c == g:
                break
            for i, j, length in steps:
                m = (c[0] + i, c[1] + j)
                if not (0 <= m[0] < n and 0 <= m[1] < n):
                    continue
                total = best[c] + length * cost[m[0]][m[1]]
                if total < best.get(m, math.inf):
                    best[m], came[m] = total, c
                    heapq.heappush(queue, (total + math.hypot(m[0] - g[0], m[1] - g[1]), m))
        cells = [g]
        while cells[-1] in came:
            cells.append(came[cells[-1]])
        pts = [np.array([self.axis[i], self.axis[j]]) for i, j in reversed(cells)]
        return np.array(pts[:-1] + [goal])


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
