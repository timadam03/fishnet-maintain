"""
align.py -- lines a close-up up on the defect before the photo is accepted. numpy only
(tests: tests/test_align.py).

The plan gets a robot to the area, aimed where the survey saw the defect. From there the detector
looks at the live frame and this decides: move so the defect is in the middle of the picture at the
asked distance, or accept the photo, or give up and say why.

    aligned     the detector sees the defect, centred, at the distance asked
    not_seen    the spot the survey reported is centred at the distance asked, but the detector finds
                nothing there: a real photo of the spot, for a person to judge
    off_centre  it could not be centred (net edge, rope, ran out of tries): not evidence of anything
"""
from __future__ import annotations

import math

import numpy as np

HFOV = 2 * math.atan(20.955 / (2 * 18.0))   # fishfarm_demo.py FOCAL, H_APERTURE
CAM_FWD, CAM_UP = 0.24, 0.02                # camera mount on the vehicle

# "Centred": the defect within this fraction of the half-width / half-height from the middle.
CENTRE_U, CENTRE_V = 0.20, 0.25
RANGE_TOL = 0.25        # [m] accepted error on the distance to the net
BACK_OK = 0.3           # [m] this much farther is fine too: where a rope leaves no spot at the distance
GATE_M = 0.8            # [m] a detection farther than this from the expected spot is something else
MAX_MOVES = 4           # corrections before giving up
SEARCH_BACK = 0.4       # [m] nothing found: step back this far once, for a wider view

CLASSES = {"opening": {"hole", "mesh_opening"},
           "wear": {"thinning", "fraying", "distortion", "rope_contact"},
           "fouling": {"biofouling"}}


def frame_offset(position, yaw, theta, z, cage_r, aspect):
    """Where the net point (theta, z) sits in the picture: (u, v), 0 = centre, +-1 = the edges,
    u to the right, v down. None if it is behind the camera."""
    x, y, height = position
    cx, cy, cz = x + CAM_FWD * math.cos(yaw), y + CAM_FWD * math.sin(yaw), height + CAM_UP
    dx, dy = cage_r * math.cos(theta) - cx, cage_r * math.sin(theta) - cy
    forward = dx * math.cos(yaw) + dy * math.sin(yaw)
    if forward <= 0.05:
        return None
    left = -dx * math.sin(yaw) + dy * math.cos(yaw)
    half_w = math.tan(HFOV / 2)
    return -left / forward / half_w, -(z - cz) / forward / (half_w / aspect)


def match(detections, kind, theta, z, cage_r):
    """What the detector sees of this kind near the expected spot, or None. Each detection needs
    `_at`, its (theta, z) on the net.

    Pieces close together are one defect (a rope across a hole splits it in two), so `_at` of the
    result is their size-weighted middle; the other fields are those of the nearest piece."""
    def apart(a, b):
        return math.hypot(cage_r * math.remainder(a[0] - b[0], 2 * math.pi), a[1] - b[1])

    near = [d for d in detections if d["class"] in CLASSES[kind] and apart(d["_at"], (theta, z)) <= GATE_M]
    if not near:
        return None
    nearest = min(near, key=lambda d: apart(d["_at"], (theta, z)))
    pieces = [d for d in near if apart(d["_at"], nearest["_at"]) <= GATE_M]
    weight = [max(1.0, float(d["bbox"][2] * d["bbox"][3])) for d in pieces]
    base = nearest["_at"][0]
    at_theta = base + sum(w * math.remainder(d["_at"][0] - base, 2 * math.pi) for w, d in zip(weight, pieces)) / sum(weight)
    at_z = sum(w * d["_at"][1] for w, d in zip(weight, pieces)) / sum(weight)
    return dict(nearest, _at=(at_theta, at_z))


class Aligner:
    """The state of one close-up spot. Call look() with each settled frame until it says "shoot"."""

    def __init__(self, kind, theta, z, standoff, aspect=16 / 9):
        self.kind, self.theta, self.z = kind, theta, z
        self.standoff, self.target_range = standoff, standoff
        self.aspect = aspect
        self.moves, self.searched, self.seen = 0, False, False

    def look(self, position, yaw, detections, cage_r):
        """Returns (action, info). action is "move" (fly to info["theta"], info["z"], info["standoff"])
        or "shoot" (info["status"] says how good the photo is)."""
        found = match(detections, self.kind, self.theta, self.z, cage_r)
        if found is not None:
            self.theta, self.z = found["_at"]
            self.seen = True
            self.target_range = self.standoff
        offset = frame_offset(position, yaw, self.theta, self.z, cage_r, self.aspect)
        dist = cage_r - math.hypot(position[0], position[1])
        centred = offset is not None and abs(offset[0]) <= CENTRE_U and abs(offset[1]) <= CENTRE_V
        in_range = -RANGE_TOL <= dist - self.standoff <= RANGE_TOL + BACK_OK
        info = {"theta": self.theta, "z": self.z, "standoff": self.target_range, "range_m": round(dist, 3),
                "offset": None if offset is None else [round(float(v), 3) for v in offset],
                "moves": self.moves, "seen": found is not None}

        if found is not None and centred and in_range:
            return "shoot", dict(info, status="aligned")
        if self.moves < MAX_MOVES:
            if found is None and not self.searched and not self.seen:
                self.searched, self.target_range = True, self.standoff + SEARCH_BACK
                return self._move(info)
            if found is not None or self.target_range != self.standoff or not (centred and in_range):
                self.target_range = self.standoff
                return self._move(info)
        status = "not_seen" if found is None and centred and in_range else "off_centre"
        return "shoot", dict(info, status=status)

    def _move(self, info):
        self.moves += 1
        return "move", dict(info, standoff=self.target_range, moves=self.moves)
