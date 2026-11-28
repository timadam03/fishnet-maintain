"""Tests for sim/plan_mode.py against the decision layer's example plan (tests/fixtures/plan.json,
a copy of contracts/example-run/plan.json on the decision-layer branch).

    uv run --with numpy --with pytest pytest abyss-sim/tests
"""
import math
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "sim"))
import plan_mode as pm  # noqa: E402
import safe_nav as sn  # noqa: E402

PLAN = os.path.join(HERE, "fixtures", "plan.json")
R, DEPTH, N_AUV = 8.0, 8.0, 3


@pytest.fixture
def plan():
    return pm.load_plan(PLAN, 24, 8)


def by_target(wps):
    out = {}
    for k, seq in enumerate(wps):
        for w in seq:
            out.setdefault(w["target_id"], []).append((k, w))
    return out


def test_refuses_other_grid():
    with pytest.raises(ValueError, match="grid"):
        pm.load_plan(PLAN, 12, 3)


def test_waypoint_is_standoff_inside_net_and_looks_at_cell_centre(plan):
    wps = by_target(pm.target_waypoints(plan, N_AUV, R, DEPTH))
    k, w = wps["m2"][0]                                   # cell 100: 67.5 deg, 1.15 m standoff, AUV 0
    assert k == 0 and w["cell"] == 100 and w["shots"] == 3 and w["margin"] == 0.6
    assert math.hypot(*w["pos"][:2]) == pytest.approx(R - 1.15)
    assert math.degrees(w["yaw"]) == pytest.approx(67.5)
    assert w["z"] == pytest.approx(-0.5625 * DEPTH)
    assert w["look_dist"] == pytest.approx(1.15)


def test_two_robots_take_one_viewpoint_each_aimed_at_the_same_spot(plan):
    wps = by_target(pm.target_waypoints(plan, N_AUV, R, DEPTH))["m1"]
    assert sorted((k, w["viewpoint"]) for k, w in wps) == [(0, 0), (1, 1)]
    centre = (R * math.cos(math.radians(97.5)), R * math.sin(math.radians(97.5)))
    for _, w in wps:
        p = w["pos"]
        # the camera axis from the spot passes through the cell centre on the net
        assert math.atan2(centre[1] - p[1], centre[0] - p[0]) == pytest.approx(w["yaw"])
        assert w["look_dist"] > 1.55                      # oblique view, farther than the radial standoff
        assert w["cell"] == 30                            # the target cell, not the cell beside it


def test_one_robot_flies_every_viewpoint(plan):
    wps = by_target(pm.target_waypoints(plan, N_AUV, R, DEPTH))["m5"]   # P4: +-8 deg, AUV 2 only
    assert [(k, w["viewpoint"]) for k, w in wps] == [(2, 0), (2, 1)]
    assert {w["cell"] for _, w in wps} == {60}            # +-8 deg crosses the 7.5 deg half-cell


def test_depth_is_clamped_inside_the_wall(plan):
    _, w = by_target(pm.target_waypoints(plan, N_AUV, R, DEPTH))["m4"][0]
    assert -DEPTH + pm.Z_EDGE <= w["z"] <= -pm.Z_EDGE


def test_refuses_robot_the_sim_does_not_have(plan):
    plan["targets"][0]["robots"] = [0, 3]
    with pytest.raises(ValueError, match="AUV"):
        pm.target_waypoints(plan, N_AUV, R, DEPTH)


def test_refuses_standoff_inside_margin(plan):
    plan["targets"][0]["scan"]["standoff_m"] = 0.8
    with pytest.raises(ValueError, match="margin"):
        pm.target_waypoints(plan, N_AUV, R, DEPTH)


def test_revisits_spread_targets_through_coverage(plan):
    wps = pm.build_waypoints(plan, N_AUV, R, DEPTH, coverage_standoff=4.0, base_margin=0.6,
                             revisits=1, coverage_limit=12)
    seq = wps[2]                                          # AUV 2: targets m4, m5 (x2 viewpoints)
    kinds = [w["target_id"] or "cov" for w in seq]
    first_cov, last_target = kinds.index("cov"), max(i for i, x in enumerate(kinds) if x != "cov")
    assert kinds[:3] == ["m4", "m5", "m5"] and first_cov < last_target   # targets again after some coverage
    assert kinds.count("m4") == 2
    cover = [w for s in wps for w in s if w["target_id"] is None]
    assert sorted(w["cell"] for w in cover) == sorted(plan["coverage"][:12])
    for k, s in enumerate(wps):                           # each coverage cell goes to its sector's robot
        for w in s:
            if w["target_id"] is None:
                assert int(w["theta"] // (2 * math.pi / N_AUV)) == k
                assert math.hypot(*w["pos"][:2]) == pytest.approx(R - 4.0)


def test_no_coverage_by_default(plan):
    wps = pm.build_waypoints(plan, N_AUV, R, DEPTH, coverage_standoff=4.0, base_margin=0.6)
    assert all(w["target_id"] for s in wps for w in s)
    assert sum(len(s) for s in wps) == 7                  # m1 x2, m2, m3, m4, m5 x2


def test_drop_blocked_uses_each_waypoints_margin(plan):
    _, w = by_target(pm.target_waypoints(plan, N_AUV, R, DEPTH))["m2"][0]
    x, y = w["pos"][:2]
    rope = [(x + 0.9, y, 0.1)]                            # keep-out = 0.1 rope + margin + 0.2 slack
    assert pm.drop_blocked([w], rope)[1] == [w]
    assert pm.drop_blocked([dict(w, margin=0.5)], rope)[0]


def test_ramp_margin_never_starts_out_violated():
    assert pm.ramp_margin(1.0, 0.6, feasible=0.3) == 0.6          # lowering: at once
    assert pm.ramp_margin(0.6, 1.0, feasible=0.8) == pytest.approx(0.78)   # raising: only as far as it clears
    assert pm.ramp_margin(0.6, 1.0, feasible=0.5) == 0.6          # never below the current margin
    assert pm.ramp_margin(0.6, 1.0, feasible=3.0) == 1.0


def test_robots_sharing_a_target_take_turns(plan):
    wps = pm.target_waypoints(plan, N_AUV, R, DEPTH)     # AUV 0: m1, m2; AUV 1: m1, m3
    locks, held = {}, [None, None]
    go0, held[0] = pm.take_turn(locks, 0, held[0], wps[0][0]["target_id"])
    go1, held[1] = pm.take_turn(locks, 1, held[1], wps[1][0]["target_id"])
    assert (go0, go1) == (True, False)                    # both start on m1: AUV 1 waits
    go0, held[0] = pm.take_turn(locks, 0, held[0], wps[0][1]["target_id"])   # AUV 0 moves on to m2
    assert go0 and locks == {"m2": 0}
    go1, held[1] = pm.take_turn(locks, 1, held[1], "m1")
    assert go1 and locks == {"m1": 1, "m2": 0}
    go1, held[1] = pm.take_turn(locks, 1, held[1], None)  # coverage: hands m1 back
    assert go1 and held[1] is None and locks == {"m2": 0}


def fly_to(router, start, goal, margin, ropes, seconds=60.0):
    """A point-mass robot under the HOCBF filter, steering the way fishfarm_demo.py does."""
    cfg, dt = sn.DEFAULTS, 1 / 60
    filt = sn.SafetyFilter(cfg["a_max"], cfg["drag"], cfg["alpha1"], cfg["alpha2"], R, margin,
                           cfg["detect_radius"])
    p, v, closest = np.array(start, float), np.zeros(2), math.inf
    for i in range(int(seconds / dt)):
        aim = router.aim(i * dt, p, goal, margin) if router else np.array(goal, float)
        u = np.clip((aim - p - 1.6 * v + cfg["drag"] * v) / cfg["a_max"], -1, 1)
        u, _ = filt.filter(p, v, u, ropes, escape=0.3)
        v = v + (cfg["a_max"] * u - cfg["drag"] * v) * dt
        p = p + v * dt
        closest = min(closest, sn.clearance(p, ropes, R, cfg["vehicle_radius"]))
        if np.linalg.norm(p - goal) < 0.1:
            break
    return np.linalg.norm(p - goal), closest


def test_router_gets_round_a_rope_that_stops_the_filter_alone():
    # A rope right between the robot and its goal, as in the recorded runs that timed out.
    ropes = np.array([[0.0, 0.0, 0.12]])
    start, goal = (-4.0, 0.0), (4.0, 0.0)
    stuck, _ = fly_to(None, start, goal, 1.0, ropes)
    off, closest = fly_to(pm.Router(ropes, R), start, goal, 1.0, ropes)
    assert stuck > 4.0
    assert off < 0.1 and closest > 0


def test_router_steers_straight_when_nothing_is_in_the_way():
    router = pm.Router(np.array([[0.0, 5.0, 0.1]]), R)
    assert router.aim(0.0, (-3.0, 0.0), (3.0, 0.0), 0.6) == pytest.approx([3.0, 0.0])
