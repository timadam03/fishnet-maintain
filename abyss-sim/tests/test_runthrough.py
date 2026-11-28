"""Tests for tools/make_runthrough.py: what the demo video shows, without rendering it.

    uv run --with numpy --with pillow --with pytest pytest abyss-sim/tests
"""
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import make_runthrough as mr  # noqa: E402

PLAN = {"plan_id": "p", "created_at": "2026-11-28T01:00:00.000Z",
        "targets": [{"target_id": "m1", "mission_id": 1, "cell": 30},
                    {"target_id": "m2", "mission_id": 2, "cell": 100},
                    {"target_id": "m3", "mission_id": 3, "cell": 150}]}


def make_db(path, rows):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE missions (id INTEGER PRIMARY KEY, created_at TEXT, cells_json TEXT, status TEXT, result TEXT)")
    con.executemany("INSERT INTO missions VALUES (?, ?, ?, ?, ?)", rows)
    con.commit()
    con.close()


def test_results_only_from_this_plans_missions(tmp_path):
    db = str(tmp_path / "shoal.db")
    make_db(db, [(1, "2026-11-28T00:59:00.000Z", "[30]", "done", "confirmed: opening"),     # this plan's
                 (2, "2026-11-28T02:00:00.000Z", "[100]", "done", "clear"),                 # a later loop's, same cell
                 (3, "2026-11-28T00:59:00.000Z", "[151]", "done", "clear")])                # another cell
    results, used = mr.mission_results(PLAN, [db])
    assert results == {"m1": "confirmed: opening"} and used == db


def test_unfinished_missions_have_no_result(tmp_path):
    db = str(tmp_path / "shoal.db")
    make_db(db, [(1, "2026-11-28T00:59:00.000Z", "[30]", "requested", None)])
    assert mr.mission_results(PLAN, [db]) == ({}, None)


def test_an_unreadable_database_is_skipped_not_fatal(tmp_path):
    bad = tmp_path / "shoal.db"
    sqlite3.connect(str(bad)).close()                     # no missions table
    good = str(tmp_path / "snapshot.db")
    make_db(good, [(1, "2026-11-28T00:59:00.000Z", "[30]", "done", "clear")])
    assert mr.mission_results(PLAN, [str(bad), None, good]) == ({"m1": "clear"}, good)


def test_classifier_shows_the_evidence_behind_each_target_first():
    hit = lambda cell, conf: {"detections": [{"class": "hole", "confidence": conf, "cell": cell}]}
    reports = [hit(5, 0.9)] * 20 + [hit(30, 0.5), hit(30, 0.8), {"detections": []}, hit(100, 0.6)]
    shown = mr.pick_photos(reports, PLAN, 6)
    assert 21 in shown and 23 in shown and 20 not in shown          # best photo per target cell
    assert 22 in shown                                              # one where nothing was found
    assert len(shown) <= 6 and shown == sorted(shown)


def test_each_rov_heads_for_the_target_of_its_next_photo():
    class R:
        captures = [{"auv": 0, "sim_time": 10.0, "target_id": "m1"}, {"auv": 0, "sim_time": 30.0, "target_id": "m2"},
                    {"auv": 1, "sim_time": 12.0, "target_id": None}]
    ov = mr.PlanOverlay({"targets": [{"target_id": "m1"}, {"target_id": "m2"}]}, R, {}, {})
    assert ov.heading(0, 5.0) == "m1" and ov.heading(0, 10.0) == "m1" and ov.heading(0, 10.1) == "m2"
    assert ov.heading(0, 31.0) == "done" and ov.heading(1, 1.0) is None


def test_plan_text_is_read_as_utf8_and_shown_without_dashes_fonts_lack(tmp_path):
    p = tmp_path / "plan.json"
    p.write_bytes(json.dumps({"area": "2.5–5 m, 90–105°"}, ensure_ascii=False).encode("utf-8"))
    area = mr.read_json(str(p))["area"]
    assert area == "2.5–5 m, 90–105°"
    assert mr.plain(area) == "2.5-5 m, 90-105°"
