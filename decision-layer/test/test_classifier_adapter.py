"""Checks scripts/classifier_to_vision.py against a stand-in with the real classifier's output shape.

    uv run --with numpy==2.1.3 --with opencv-python-headless==4.10.0.84 --with jsonschema==4.23.0 \
        python test/test_classifier_adapter.py <scratch_dir>
"""
import json
import os
import sys

import cv2 as cv
import jsonschema
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import classifier_to_vision as adapter  # noqa: E402

# Same signature and output keys as the net classifier's inspect_frame; values chosen per image.
FAKE_CLASSIFIER = '''
from dataclasses import dataclass
import numpy as np

@dataclass(frozen=True)
class Config:
    mode: str = "survey"

CALLS = []

def det(kind, dx, conf, sev, **extra):
    return dict(type=kind, bbox=[100, 80, 40, 40], centroid=[0.0, 0.0], polygon=[[0, 0]], confidence=conf,
                severity=sev, recommended_action="investigate", dx=dx, dy=0.1, id=0, selected=True,
                observed=True, persistence=1, missed_frames=0, **extra)

def inspect_frame(frame, *, config=None, tracker=None, render=True, diagnostics=None, timings=None):
    CALLS.append(config.mode)
    h, w = frame.shape[:2]
    blank = int(frame[0, 0, 0]) == 0        # the test's "murky" image
    diagnostics.update(valid=np.zeros((h, w), np.uint8) if blank else np.full((h, w), 255, np.uint8),
                       biofouling=np.zeros((h, w), np.uint8) if blank else np.pad(np.full((h, w // 4), 255, np.uint8), ((0, 0), (0, w - w // 4))),
                       mesh_openings=0 if blank else 120)
    if blank:
        return [], None
    return [det("hole", 0.9, 0.81, 0.62, radius_ratio=1.6),
            det("unknown", -0.4, 0.56, 0.62, evidence="water_core"),
            det("unknown", 0.2, 0.66, 0.4, radius_ratio=1.2),
            det("unknown", 0.0, 0.62, 0.3, evidence="apparent_width"),
            det("biofouling", -0.7, 0.85, 0.5, projected_area_px=900)], None
'''


def main(scratch):
    run = os.path.join(scratch, "run")
    os.makedirs(os.path.join(run, "auv_0"), exist_ok=True)
    classifier_path = os.path.join(scratch, "fake_classifier.py")
    with open(classifier_path, "w") as f:
        f.write(FAKE_CLASSIFIER)
    cv.imwrite(os.path.join(run, "auv_0", "img_0000.png"), np.full((360, 640, 3), 120, np.uint8))
    cv.imwrite(os.path.join(run, "auv_0", "img_0001.png"), np.zeros((360, 640, 3), np.uint8))
    captures = [
        {"image": "auv_0/img_0000.png", "run_id": "t", "auv": 0, "sim_time": 1.0, "theta_deg": 97.5, "depth": -1.5, "position": [-0.52, 3.97, -1.5], "cell": 30},
        {"image": "auv_0\\img_0001.png", "run_id": "t", "auv": 0, "sim_time": 2.0, "theta_deg": 97.5, "depth": -1.5, "position": [-0.86, 6.52, -1.5], "cell": 30, "target_id": "m1"},
        {"image": "auv_0/img_0404.png", "run_id": "t", "auv": 0, "sim_time": 3.0, "theta_deg": 0, "depth": -1, "position": [4, 0, -1], "cell": 24},
    ]
    with open(os.path.join(run, "captures.jsonl"), "w") as f:
        f.write("".join(json.dumps(c) + "\n" for c in captures))

    assert adapter.main([run, "--classifier", classifier_path]) == 0
    reports = [json.loads(l) for l in open(os.path.join(run, "vision.jsonl"))]
    schema = json.load(open(os.path.join(HERE, "..", "..", "contracts", "vision-report.schema.json")))
    for r in reports:
        jsonschema.validate(r, schema)

    survey, murky = reports
    assert survey["image"] == "auv_0/img_0000.png" and survey["model"] == "net-classifier-cv:survey"
    assert [d["class"] for d in survey["detections"]] == ["hole", "mesh_opening", "mesh_opening", "thinning", "biofouling"]
    assert survey["detections"][0]["offset"] == [0.9, 0.1]
    assert survey["quality"] == {"visibility": 1.0, "sharpness": 1.0}
    assert survey["fouling_pct"] == 0.25
    # Plan photo (target_id) ran in investigation mode; the Windows path kept its exact string.
    assert murky["image"] == "auv_0\\img_0001.png" and murky["model"] == "net-classifier-cv:investigation"
    # No mesh found: no detections, and quality 0 so the layer won't read it as "clear".
    assert murky["detections"] == [] and murky["quality"] == {"visibility": 0.0, "sharpness": 0.0}
    with open(os.path.join(scratch, "captures_for_import.jsonl"), "w") as f:
        f.write("".join(json.dumps(c) + "\n" for c in captures[:2]))
    print(f"adapter ok: {len(reports)} reports valid against the schema; 1 missing image skipped")


if __name__ == "__main__":
    main(sys.argv[1])
