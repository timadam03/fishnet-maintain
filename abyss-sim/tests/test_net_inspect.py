"""A hole with a rope across it, on a drawn net (perception/net_inspect.py). Needs numpy and OpenCV.

    uv run --with numpy --with pytest --with opencv-python-headless pytest abyss-sim/tests/test_net_inspect.py
"""
import os
import sys

import cv2 as cv
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "perception"))
from net_inspect import Config, inspect_frame  # noqa: E402

WATER, TWINE, ROPE = (197, 191, 139), (68, 66, 36), (60, 100, 110)   # BGR, as the sim renders them


def net(hole=False, rope=False):
    frame = np.full((360, 640, 3), WATER, np.uint8)
    for k in range(-360, 1000, 44):
        cv.line(frame, (k, 0), (k + 360, 360), TWINE, 5)
        cv.line(frame, (k, 0), (k - 360, 360), TWINE, 5)
    if hole:
        cv.circle(frame, (320, 180), 85, WATER, -1)
    if rope:
        cv.line(frame, (322, 0), (322, 360), ROPE, 16)
    return frame


def openings(frame):
    found, _ = inspect_frame(frame, config=Config(mode="investigation"), render=False)
    return [d for d in found if d["type"] in ("hole", "unknown")]


def test_a_hole_with_a_rope_across_it_is_one_hole_centred_on_the_whole():
    found = openings(net(hole=True, rope=True))
    assert len(found) == 1 and found[0]["type"] == "hole"
    cx, cy = found[0]["centroid"]
    assert abs(cx - 320) < 20 and abs(cy - 180) < 20
    assert found[0]["bbox"][2] > 120                      # both sides of the rope


def test_a_rope_over_healthy_net_is_not_a_hole():
    assert openings(net(rope=True)) == []
