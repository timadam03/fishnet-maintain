"""
safe_nav.py -- shared by train_fishfarm_nav.py (training, in the SJTU_SafeRL_AUV repo) and
fishfarm_demo.py (Isaac Sim). numpy only, so it runs inside Isaac Sim's Python unchanged.

Same HOCBF as finrl/cbf.py (2nd-order point mass  v_dot = a_max*u - drag*v,  world motion
p_dot = v + current), extended with an INSIDE-circle barrier for the net-pen wall:

    pillar / other AUV (stay outside):  h = |p - c|^2 - R^2
    net wall          (stay inside):    h = R_w^2 - |p|^2   = -(outside barrier with c = 0)

For the inside barrier every term of the HOCBF chain flips sign, so its constraint is exactly the
outside one negated:  (-A) u >= (-b).

Planar navigation in the horizontal plane (x, y); depth is handled separately by the caller.
"""
from __future__ import annotations

import json
import math

import numpy as np

# Defaults matched to the Isaac Sim demo (BlueROV2-scale vehicle in an 8 m radius pen).
DEFAULTS = dict(
    a_max=0.6,          # m/s^2 per axis at |u| = 1
    drag=0.5,           # 1/s linear drag  -> top speed a_max/drag = 1.2 m/s
    dt=0.1,             # policy step [s] (10 Hz)
    net_radius=8.0,     # physical net radius [m]
    inflation=0.6,      # vehicle radius (0.35) + safety margin -> what the HOCBF keeps
    vehicle_radius=0.35,  # physical contact (collision) is measured with this
    n_rays=8,
    ray_max=4.0,
    alpha1=1.0,         # HOCBF class-K gains (your "never-doomed" tuning)
    alpha2=2.0,
    detect_radius=4.0,  # only obstacles closer than this create constraints
)


# --------------------------------------------------------------------------- HOCBF rows
def hocbf_outside(p, v, c, R, a_max, drag, alpha1, alpha2, current, v_obs=None):
    """A u >= b keeping the vehicle outside a circle (centre c, effective radius R).

    Moving obstacle (velocity v_obs, assumed constant over the horizon): use the RELATIVE motion
        d = p - c,   d_dot = (v + current) - v_obs,   d_ddot = a_max*u - drag*v
        h = d.d - R^2,  h_dot = 2 d.d_dot,  h_ddot = 2 d_dot.d_dot + 2 d.(a_max*u - drag*v)
    HOCBF:  h_ddot + (a1+a2) h_dot + a1*a2*h >= 0   ->   A u >= b.   v_obs = 0 gives finrl/cbf.py.
    """
    d = p - c
    vc = v + current
    dd = vc if v_obs is None else vc - v_obs
    A = 2.0 * a_max * d
    N = (2.0 * (dd @ dd) - 2.0 * drag * (d @ v)
         + 2.0 * (alpha1 + alpha2) * (d @ dd) + alpha1 * alpha2 * ((d @ d) - R * R))
    return A, -N


def hocbf_inside(p, v, R, a_max, drag, alpha1, alpha2, current):
    """A u >= b keeping the vehicle inside a circle of radius R centred at the origin."""
    A, b = hocbf_outside(p, v, np.zeros(2), R, a_max, drag, alpha1, alpha2, current)
    return -A, -b


def solve_qp(u0, cons, lo=-1.0, hi=1.0, max_iter=200, tol=1e-9):
    """min |u - u0|^2  s.t.  A_i u >= b_i  and  lo <= u <= hi   (Dykstra projection, as in finrl)."""
    x = np.asarray(u0, float).copy()
    corr = [np.zeros(2) for _ in range(len(cons) + 1)]
    for _ in range(max_iter):
        x_old = x.copy()
        for i, (A, b) in enumerate(cons):
            y = x + corr[i]
            Ay = A @ y
            x = y if Ay >= b else y + ((b - Ay) / (A @ A)) * A
            corr[i] = y - x
        y = x + corr[-1]
        xb = np.clip(y, lo, hi)
        corr[-1] = y - xb
        x = xb
        if np.linalg.norm(x - x_old) < tol:
            break
    return x


class SafetyFilter:
    """Level-3 HOCBF filter.

    Obstacles are rows (cx, cy, r_physical) or (cx, cy, r_physical, vx, vy) for moving ones
    (other ROVs, a diver). `inflation` (vehicle radius + margin) is added to every radius.
    Point obstacles from a sonar / sphere-cast are just rows with r = 0 (perception mode).
    `use_wall=False` drops the analytic net barrier (perception mode senses the net instead).
    """

    def __init__(self, a_max, drag, alpha1, alpha2, net_radius, inflation, detect_radius,
                 current=(0.0, 0.0), use_wall=True):
        self.use_wall = use_wall
        self.a_max, self.drag = a_max, drag
        self.alpha1, self.alpha2 = alpha1, alpha2
        self.net_radius, self.inflation = net_radius, inflation
        self.detect_radius = detect_radius
        self.current = np.asarray(current, float)

    def constraints(self, p, v, circles):
        cons = []
        circ = np.asarray(circles, float)
        circ = circ.reshape(-1, circ.shape[-1] if circ.size else 3)
        for row in circ:
            c = row[:2]
            r = row[2]
            if np.linalg.norm(p - c) - r > self.detect_radius:
                continue
            v_obs = row[3:5] if len(row) >= 5 else None
            A, b = hocbf_outside(p, v, c, r + self.inflation, self.a_max, self.drag,
                                 self.alpha1, self.alpha2, self.current, v_obs)
            if A @ A > 1e-12:
                cons.append((A, b))
        R_w = self.net_radius - self.inflation
        if self.use_wall and R_w - np.linalg.norm(p) < self.detect_radius:
            A, b = hocbf_inside(p, v, R_w, self.a_max, self.drag, self.alpha1, self.alpha2, self.current)
            if A @ A > 1e-12:
                cons.append((A, b))
        return cons

    def filter(self, p, v, u_nom, circles, escape=0.0):
        """Return the safe action closest to u_nom.

        escape > 0: deadlock tie-break. A head-on threat (or a ROV pressed straight at a rope) gives a
        constraint normal parallel to the nominal action, so the QP only ever brakes/retreats in a
        line. We then add a sideways nudge (perpendicular to the most violated constraint) to the
        nominal action and re-solve -- the QP still enforces every constraint, so safety is unchanged.
        """
        p = np.asarray(p, float)
        v = np.asarray(v, float)
        u_nom = np.clip(np.asarray(u_nom, float), -1.0, 1.0)
        cons = self.constraints(p, v, circles)
        if all(A @ u_nom >= b - 1e-9 for A, b in cons):
            return u_nom, {"intervened": False, "infeasible": False, "n_constraints": len(cons)}
        if escape > 0.0:
            A_w, b_w = min(cons, key=lambda c: (c[0] @ u_nom - c[1]) / (np.linalg.norm(c[0]) + 1e-9))
            n = A_w / (np.linalg.norm(A_w) + 1e-9)
            u_nom = np.clip(u_nom + escape * np.array([-n[1], n[0]]), -1.0, 1.0)
        u = solve_qp(u_nom, cons)
        return u, {"intervened": True,
                   "infeasible": not all(A @ u >= b - 1e-6 for A, b in cons),
                   "n_constraints": len(cons)}


# --------------------------------------------------------------------------- perception / obs
def _xyr(circles):
    """Accept (k,3) or (k,5) obstacle rows; return (k,3) [x, y, r]."""
    c = np.asarray(circles, float)
    if c.size == 0:
        return np.zeros((0, 3))
    c = c.reshape(-1, c.shape[-1])
    return c[:, :3]

def cast_rays(p, circles, net_radius, n_rays=8, ray_max=4.0):
    """Range to the nearest physical surface along n_rays world-frame directions (sonar-like)."""
    p = np.asarray(p, float)
    circ = _xyr(circles)
    out = np.full(n_rays, ray_max)
    pp = p @ p
    for k in range(n_rays):
        ang = 2 * math.pi * k / n_rays
        d = np.array([math.cos(ang), math.sin(ang)])
        t = ray_max
        if len(circ):
            o = p - circ[:, :2]
            b = o @ d
            disc = b * b - (np.einsum("ij,ij->i", o, o) - circ[:, 2] ** 2)
            hit = disc >= 0
            if np.any(hit):
                tc = -b[hit] - np.sqrt(disc[hit])
                tc = tc[tc >= 0]
                if tc.size:
                    t = min(t, float(tc.min()))
        b = p @ d                                           # exit through the net (inside circle)
        disc = b * b - (pp - net_radius ** 2)
        if disc >= 0:
            te = -b + math.sqrt(disc)
            if te >= 0:
                t = min(t, te)
        out[k] = t
    return out


def build_obs(p, v, goal, circles, net_radius, n_rays=8, ray_max=4.0):
    """[dx/Rn, dy/Rn, dist/(2Rn), vx, vy, rays/ray_max]  -- same layout as finrl NavEnv2D."""
    p = np.asarray(p, float)
    dx, dy = np.asarray(goal, float) - p
    dist = math.hypot(dx, dy)
    rays = cast_rays(p, circles, net_radius, n_rays, ray_max)
    return np.concatenate([[dx / net_radius, dy / net_radius, dist / (2 * net_radius), v[0], v[1]],
                           rays / ray_max]).astype(np.float32)


def clearance(p, circles, net_radius, margin):
    """Signed clearance (>= 0 safe) to obstacles and net, with `margin` (vehicle radius etc.)."""
    p = np.asarray(p, float)
    best = net_radius - np.linalg.norm(p)
    for cx, cy, r in _xyr(circles):
        best = min(best, math.hypot(p[0] - cx, p[1] - cy) - r)
    return best - margin


# --------------------------------------------------------------------------- policy runner
class NumpyPolicy:
    """Deterministic tanh-MLP actor exported by train_fishfarm_nav.py (mean action, clipped)."""

    def __init__(self, path):
        z = np.load(path, allow_pickle=False)
        n = int(z["n_layers"])
        self.layers = [(z[f"W{i}"], z[f"b{i}"]) for i in range(n)]
        self.cfg = json.loads(str(z["cfg"]))

    def __call__(self, obs):
        x = np.asarray(obs, np.float32)
        for i, (W, b) in enumerate(self.layers):
            x = x @ W.T + b
            if i < len(self.layers) - 1:
                x = np.tanh(x)
        return np.clip(x, -1.0, 1.0)
