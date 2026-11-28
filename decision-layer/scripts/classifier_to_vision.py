"""Run the net classifier on an Isaac run and write vision.jsonl in the decision layer's contract.

    python classifier_to_vision.py <run_dir> --classifier <path/to/classifier.py> [--out <file>]

The classifier is loaded from its file, so it can live anywhere; it must provide
``inspect_frame(frame, config=..., render=..., diagnostics=...)`` and ``Config(mode=...)``.
Sweep photos run in its "survey" mode, photos taken for a plan target (with ``target_id``)
in "investigation" mode. Needs numpy and opencv, like the classifier itself.

Two things the classifier's output doesn't say, which the decision layer needs:
- **Image quality.** When the classifier can't find the mesh (murky, blurred) it returns no
  detections, which would read as "looked, nothing there". Quality is taken from its
  diagnostics instead: no mesh found means quality 0, so the layer sends a robot closer.
- **Image name and model.** Added from captures.jsonl.
"""
import argparse
import importlib.util
import json
import os
import sys

import cv2 as cv
import numpy as np

MODEL = "net-classifier-cv"
# Below this many resolved mesh openings the classifier can't judge the image (it needs 12 to
# estimate the mesh size at all); 40 or more counts as fully sharp. Demo values.
SHARP_MESHES = 40
# Share of the image where the mesh was resolved that counts as fully visible.
VISIBLE_SHARE = 0.6


def load_classifier(path):
    spec = importlib.util.spec_from_file_location("net_classifier", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"can't load a classifier from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("inspect_frame", "Config"):
        if not hasattr(module, name):
            raise SystemExit(f"{path} has no {name}")
    return module


def contract_class(detection):
    """The classifier's 'unknown' is an unsure opening, or unsure thinning when it came from the width check."""
    kind = detection["type"]
    if kind in ("hole", "thinning", "biofouling"):
        return kind
    if kind == "unknown":
        return "thinning" if detection.get("evidence") == "apparent_width" else "mesh_opening"
    return "other"


def quality_of(diagnostics):
    meshes = int(diagnostics.get("mesh_openings", 0))
    valid = diagnostics.get("valid")
    share = float(np.count_nonzero(valid)) / valid.size if valid is not None and valid.size else 0.0
    return {"visibility": round(min(1.0, share / VISIBLE_SHARE), 3), "sharpness": round(min(1.0, meshes / SHARP_MESHES), 3)}


def fouling_of(diagnostics):
    mask = diagnostics.get("biofouling")
    return round(float(np.count_nonzero(mask)) / mask.size, 3) if mask is not None and mask.size else 0.0


def report(record, frame, classifier):
    mode = "investigation" if record.get("target_id") else "survey"
    diagnostics = {}
    detections, _ = classifier.inspect_frame(frame, config=classifier.Config(mode=mode), render=False, diagnostics=diagnostics)
    return {
        "image": record["image"],
        "model": f"{MODEL}:{mode}",
        "quality": quality_of(diagnostics),
        "fouling_pct": fouling_of(diagnostics),
        "detections": [
            {
                "class": contract_class(d),
                "confidence": round(float(d["confidence"]), 3),
                "bbox": [int(v) for v in d["bbox"]],
                "offset": [round(float(np.clip(d["dx"], -1, 1)), 4), round(float(np.clip(d["dy"], -1, 1)), 4)],
                "severity": round(float(np.clip(d["severity"], 0, 1)), 3),
            }
            for d in detections
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("run_dir")
    parser.add_argument("--classifier", required=True, help="path to the classifier's .py file")
    parser.add_argument("--out", help="default: <run_dir>/vision.jsonl")
    args = parser.parse_args(argv)

    classifier = load_classifier(args.classifier)
    out_path = args.out or os.path.join(args.run_dir, "vision.jsonl")
    written, missing = 0, []
    with open(os.path.join(args.run_dir, "captures.jsonl")) as captures, open(out_path, "w") as out:
        for line in captures:
            if not line.strip():
                continue
            record = json.loads(line)
            # The sim may write Windows separators; the report keeps the capture's exact string to join on.
            frame = cv.imread(os.path.join(args.run_dir, *record["image"].replace("\\", "/").split("/")), cv.IMREAD_COLOR)
            if frame is None:
                missing.append(record["image"])
                continue
            out.write(json.dumps(report(record, frame, classifier)) + "\n")
            written += 1
    print(f"wrote {written} reports to {out_path}" + (f"; {len(missing)} images missing or unreadable, e.g. {missing[0]}" if missing else ""))
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
