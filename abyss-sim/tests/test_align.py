"""Tests for sim/align.py and the aimed waypoints of sim/plan_mode.py (numpy only).

    uv run --with numpy --with pytest pytest abyss-sim/tests/test_align.py
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "sim"))
import align as al  # noqa: E402
import plan_mode as pm  # noqa: E402

R, DEPTH, STANDOFF = 8.0, 8.0, 2.2
THETA, Z = math.radians(40.0), -3.0


def spot(theta=THETA, z=Z, standoff=STANDOFF, d_theta=0.0):
    return pm.aimed_waypoint(theta, z, d_theta, standoff, R, DEPTH, margin=0.8, aim_z=z, aim_d_theta=d_theta)


def hole(theta=THETA, z=Z, size=100):
    return {"class": "hole", "_at": (theta, z), "bbox": [0, 0, size, size]}


def look(aligner, wp, detections):
    return aligner.look(wp["pos"], wp["yaw"], detections, R)


def test_aimed_waypoint_puts_the_point_in_the_middle_from_any_side():
    for d_theta in (0.0, math.radians(8), math.radians(-8)):
        wp = spot(d_theta=d_theta)
        u, v = al.frame_offset(wp["pos"], wp["yaw"], THETA, Z, R, 16 / 9)
        assert abs(u) < 1e-6 and abs(v) < 1e-6


def test_centred_detection_at_distance_is_accepted():
    action, info = look(al.Aligner("opening", THETA, Z, STANDOFF), spot(), [hole()])
    assert action == "shoot" and info["status"] == "aligned"


def test_detection_off_to_the_side_moves_onto_it_then_accepts():
    a = al.Aligner("opening", THETA, Z, STANDOFF)
    real = (THETA + math.radians(4), Z - 0.4)                      # 0.69 m from where the survey put it
    action, info = look(a, spot(), [hole(*real)])
    assert action == "move" and (info["theta"], info["z"]) == real
    action, info = look(a, spot(*real), [hole(*real)])
    assert action == "shoot" and info["status"] == "aligned"


def test_nothing_seen_steps_back_once_then_says_so():
    a = al.Aligner("opening", THETA, Z, STANDOFF)
    action, info = look(a, spot(), [])
    assert action == "move" and info["standoff"] == STANDOFF + al.SEARCH_BACK
    action, info = look(a, spot(standoff=info["standoff"]), [])
    assert action == "move" and info["standoff"] == STANDOFF
    action, info = look(a, spot(), [])
    assert action == "shoot" and info["status"] == "not_seen"


def test_gives_up_as_off_centre_when_it_cannot_get_there():
    a = al.Aligner("opening", THETA, Z, STANDOFF)
    stuck = spot(theta=THETA + math.radians(15))                   # never moves
    actions = [look(a, stuck, [hole()]) for _ in range(al.MAX_MOVES + 1)]
    assert [x[0] for x in actions] == ["move"] * al.MAX_MOVES + ["shoot"]
    assert actions[-1][1]["status"] == "off_centre"


def test_ignores_other_kinds_and_far_detections():
    other = [dict(hole(), **{"class": "biofouling"}), hole(THETA + math.radians(12))]
    assert al.match(other, "opening", THETA, Z, R) is None


def test_two_halves_of_a_split_hole_aim_at_the_middle():
    halves = [hole(THETA - 0.03), hole(THETA + 0.03)]
    assert math.isclose(al.match(halves, "opening", THETA, Z, R)["_at"][0], THETA)


def test_a_rope_in_the_way_moves_the_spot_but_keeps_it_aimed():
    wp = spot()
    mid = (wp["pos"][0] + R * math.cos(THETA)) / 2, (wp["pos"][1] + R * math.sin(THETA)) / 2
    ropes = [(mid[0], mid[1], 0.12)]                               # hangs between camera and hole
    assert pm.view_blocked(wp, ropes, R)
    moved = pm.clear_view(wp, STANDOFF, ropes, R, DEPTH)
    assert moved is not None and not pm.view_blocked(moved, ropes, R)
    u, v = al.frame_offset(moved["pos"], moved["yaw"], THETA, Z, R, 16 / 9)
    assert abs(u) < 1e-6 and abs(v) < 1e-6
