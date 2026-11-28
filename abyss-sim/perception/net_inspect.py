"""CPU-only simulated net inspection. Input and annotated output are uint8 BGR."""

from dataclasses import dataclass, field
from time import perf_counter

import cv2 as cv
import numpy as np


@dataclass(frozen=True)
class Config:
    mode: str = "survey"
    survey_width: int = 960
    # Close-ups are scaled down further: at full size the near strands are wider than the
    # segmentation's 9 px window, which hollows them out and the whole mesh is misread.
    investigation_width: int = 640
    hole_ratio: float = 1.65
    thinning_ratio: float = 0.73


def _components(mask):
    return cv.connectedComponentsWithStats(mask, connectivity=8, ltype=cv.CV_32S)


def _mask(condition):
    return condition.astype(np.uint8) * 255


def _segment(frame):
    hsv = cv.cvtColor(frame, cv.COLOR_BGR2HSV)
    gray = cv.cvtColor(frame, cv.COLOR_BGR2GRAY)
    hue, saturation, value = cv.split(hsv)
    local = cv.dilate(gray, np.ones((9, 9), np.uint8))
    contrast = cv.subtract(local, gray)
    strands = _mask((contrast >= 20) & (gray < 156) & (hue >= 67) & (hue <= 110))
    fouling = cv.inRange(hsv, (35, 78, 35), (69, 220, 148))
    material = strands | fouling
    water = cv.inRange(hsv, (86, 58, 175), (101, 93, 213))
    return strands, fouling, material, water


def _polygon(mask, x, y):
    contours, _ = cv.findContours(mask, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv.contourArea)
    return (cv.approxPolyDP(contour, 1.2, True).reshape(-1, 2) + (x, y)).tolist()


def _record(kind, box, center, polygon, confidence, severity, **metrics):
    return dict(type=kind, bbox=list(map(int, box)), centroid=list(map(float, center)),
                polygon=polygon, confidence=float(np.clip(confidence, 0, 1)),
                severity=float(np.clip(severity, 0, 1)), recommended_action="investigate",
                **metrics)


def _ropes(frame, material, water):
    """Ropes and hoses: long solid bands that are neither twine, growth nor water."""
    hue = cv.cvtColor(frame, cv.COLOR_BGR2HSV)[:, :, 0]
    other = _mask((material == 0) & (water == 0) & (hue >= 12) & (hue <= 75))
    other = cv.morphologyEx(other, cv.MORPH_OPEN, np.ones((3, 3), np.uint8))
    _, labels, stats, _ = _components(other)
    long_side = np.maximum(stats[:, 2], stats[:, 3])
    keep = long_side >= min(material.shape) * .45
    keep[0] = False
    return _mask(keep[labels])


def _faint(frame):
    """Pixels with even a trace of an edge. Twine washed out by a lamp still has one; open water has none."""
    gray = cv.cvtColor(frame, cv.COLOR_BGR2GRAY)
    return cv.subtract(cv.dilate(gray, np.ones((9, 9), np.uint8)), gray) >= 5


def _across_ropes(clean_water, ropes, faint, refs, typical, pitch):
    """Openings with a rope hanging across them.

    Each side of the rope alone is cut off by it and often fails the single-opening checks, or shows
    as two defects. Where open water faces open water across a rope, the two sides and the rope
    between them are one opening. A rope over healthy mesh joins nothing: that needs a gap wider
    than a mesh on both sides.
    """
    # Only where the mesh is well resolved (close-ups): from far off, washed-out net and the water
    # above the net look the same as a gap.
    if pitch < 18 or not cv.countNonZero(ropes):
        return []
    margin = round(pitch * .7)
    disk = cv.getStructuringElement(cv.MORPH_ELLIPSE, (2 * margin + 1,) * 2)
    core = _mask(cv.distanceTransform(clean_water, cv.DIST_L2, 5) > pitch * .81)
    count, cores, stats, _ = _components(core)
    gaps = cv.dilate(core, disk) & clean_water           # the cores grown back to their own gap
    # The rope's width, from its thickest point, says how far apart the two sides can be.
    width = 2 * int(np.ceil(np.percentile(cv.distanceTransform(ropes, cv.DIST_L2, 5)[ropes > 0], 98)))
    reach = width + 2 * margin + 3
    bridge = ropes & cv.dilate(gaps, cv.getStructuringElement(cv.MORPH_ELLIPSE, (reach | 1,) * 2))
    # Blended pixels along the rope's edges are neither rope nor water: close that seam.
    union = cv.morphologyEx(gaps | bridge, cv.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    _, joined, joined_stats, _ = _components(union)
    found = []
    for idx, (bx, by, bw, bh, _) in enumerate(joined_stats[1:], 1):
        region = joined == idx
        pieces = [c for c in np.unique(cores[region]) if c and stats[c, 4] >= typical * .24]
        if len(pieces) < 2 or not (ropes[region] != 0).any():
            continue
        # Only the rope between the pieces belongs to the opening, not its whole length.
        water_part = _mask(region & np.isin(cores, pieces))
        water_part = cv.dilate(water_part, disk) & clean_water
        points = cv.findNonZero(water_part)
        hull = np.zeros_like(water_part)
        cv.fillConvexPoly(hull, cv.convexHull(points), 255)
        opening = cv.morphologyEx((water_part | (hull & ropes)) & hull, cv.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        moments = cv.moments(opening, binaryImage=True)
        if not moments["m00"] or np.mean((clean_water | ropes)[hull > 0] != 0) < .8:
            continue                                      # mesh in between: two separate gaps
        # Washed-out twine inside is not a gap. (Eroded, so the real edges around it don't count.)
        inside = (cv.erode(opening, np.ones((9, 9), np.uint8)) > 0) & (clean_water > 0)
        if inside.any() and faint[inside].mean() > .02:
            continue
        cx, cy = moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]
        delta = refs - (cx, cy)
        radius = np.sqrt(moments["m00"] / np.pi)
        near = delta[np.sum(delta ** 2, axis=1) < (radius + pitch * 6) ** 2]
        if len(near) < 15 or np.unique((near[:, 0] > 0) + 2 * (near[:, 1] > 0)).size < 2:
            continue
        found.append((opening, (cx, cy), moments["m00"]))
    return found


def _openings(material, water, config, ropes, faint):
    height, width = material.shape
    # Bridge rasterization gaps only in the topology used for opening extraction.
    topology = cv.morphologyEx(material, cv.MORPH_CLOSE,
                              cv.getStructuringElement(cv.MORPH_CROSS, (3, 3)))
    _, labels, stats, centers = _components(cv.bitwise_not(topology))
    x, y, w, h, area = stats.T
    enclosed = (x > 0) & (y > 0) & (x + w < width) & (y + h < height)
    enclosed[0] = False
    # Estimate the common cell size from the central vertical panel.
    seed = enclosed & (centers[:, 1] > height * .27) & (centers[:, 1] < height * .72)
    seed &= (area >= 12) & (w / np.maximum(h, 1) > .45) & (w / np.maximum(h, 1) < 2.2)
    if seed.sum() < 12:
        return [], labels, np.zeros(len(stats), bool), np.zeros_like(material), 0.
    typical = np.median(area[seed])
    healthy = enclosed & (area >= .32 * typical) & (area <= 1.48 * typical)
    healthy &= (w > h * .45) & (h > w * .45)
    pitch = np.sqrt(typical)
    coverage = cv.boxFilter(_mask(healthy[labels]).astype(np.float32) / 255, -1,
                            (max(3, int(pitch * 9) | 1),) * 2)
    valid = _mask(coverage > .24)
    # Also keep pixels inside local gaps for the diagnostics and region detectors.
    valid = cv.dilate(valid, np.ones((max(3, int(pitch * 3)),) * 2, np.uint8))
    detections = []
    open_distance = cv.distanceTransform(cv.bitwise_not(topology), cv.DIST_L2, 5)
    refs = centers[healthy]
    ref_area = area[healthy]
    for idx in np.flatnonzero(enclosed & (area > typical * 1.15)):
        cx, cy = centers[idx]
        if not valid[int(cy), int(cx)]:
            continue
        nearby = ((refs[:, 0] - cx) ** 2 + (refs[:, 1] - cy) ** 2) < (pitch * 7) ** 2
        if nearby.sum() < 12:
            continue
        local = refs[nearby] - (cx, cy)
        vertical = local[np.abs(local[:, 0]) < pitch * 3, 1]
        if min(np.count_nonzero(vertical < -pitch), np.count_nonzero(vertical > pitch)) < 3:
            continue
        local_area = np.median(ref_area[nearby])
        relative = area[idx] / local_area
        threshold = config.hole_ratio + (.15 if config.mode == "investigation" else 0)
        if relative < threshold:
            continue
        bx, by, bw, bh, size = stats[idx]
        if min(bw, bh) < pitch * .55 or max(bw, bh) > pitch * 18:
            continue
        region = np.s_[by:by + bh, bx:bx + bw]
        opening = labels[region] == idx
        water_fraction = np.mean(water[region][opening] != 0)
        radius_ratio = open_distance[region][opening].max() / np.sqrt(local_area / np.pi)
        if water_fraction < .82 or size / (bw * bh) < .25 or radius_ratio < 1.07:
            continue
        polygon = _polygon(_mask(opening), bx, by)
        if radius_ratio < 1.48:
            kind = "unknown"
        else:
            kind = "hole"
        confidence = (.58 + .13 * min(radius_ratio - 1, 2)
                      + .07 * min(np.log2(relative), 2.5))
        if kind == "unknown":
            confidence = min(confidence, .66)
        detections.append(_record(kind, (bx, by, bw, bh), (cx, cy), polygon,
                                  confidence,
                                  .32 + .12 * np.log2(relative),
                                  opening_area_px=int(size), area_ratio=float(relative),
                                  local_median_area_px=float(local_area),
                                  opening_fill=float(size / (bw * bh)),
                                  radius_ratio=float(radius_ratio)))
    # A real break may open onto the edge or be divided by a support rope.
    # Look for large water-only cores within reach of the healthy mesh.
    clean_water = water & cv.bitwise_not(topology)
    water_distance = cv.distanceTransform(clean_water, cv.DIST_L2, 5)
    core = _mask((water_distance > pitch * .81) & (valid != 0))
    _, core_labels, core_stats, _ = _components(core)
    for idx, (bx, by, bw, bh, size) in enumerate(core_stats[1:], 1):
        if size < typical * .24:
            continue
        margin = round(pitch * .7)
        left, top = max(0, bx-margin), max(0, by-margin)
        right, bottom = min(width, bx+bw+margin), min(height, by+bh+margin)
        roi = np.s_[top:bottom, left:right]
        region = _mask(core_labels[roi] == idx)
        region = cv.dilate(region, cv.getStructuringElement(cv.MORPH_ELLIPSE, (2*margin+1,) * 2))
        region &= clean_water[roi]
        moments = cv.moments(region, binaryImage=True)
        size = moments["m00"]
        if not size:
            continue
        cx, cy = left + moments["m10"]/size, top + moments["m01"]/size
        if any(cv.pointPolygonTest(np.array(item["polygon"], np.int32), (cx, cy), False) >= 0
               for item in detections):
            continue
        delta = refs - (cx, cy)
        neighbors = delta[np.sum(delta**2, axis=1) < (pitch*8)**2]
        if len(neighbors) < 15:
            continue
        quadrants = np.unique((neighbors[:, 0] > 0) + 2 * (neighbors[:, 1] > 0)).size
        if quadrants < 3:
            continue
        polygon = _polygon(region, left, top)
        complete = (quadrants == 4 and top > 0 and bottom < height and left > 0 and right < width
                    and np.count_nonzero(neighbors[:, 1] > pitch) >= 4
                    and np.count_nonzero(neighbors[:, 1] < -pitch) >= 4)
        kind = "hole" if complete else "unknown"
        box = cv.boundingRect(np.asarray(polygon, np.int32))
        detections.append(_record(kind, box, (cx, cy), polygon,
                                  .76 if kind == "hole" else .56, .62,
                                  opening_area_px=int(size), evidence="water_core"))
    for opening, (cx, cy), size in _across_ropes(clean_water & cv.bitwise_not(ropes), ropes, faint, refs, typical, pitch):
        # The whole opening replaces whatever was found of its parts.
        detections = [d for d in detections
                      if not opening[min(height - 1, int(d["centroid"][1])), min(width - 1, int(d["centroid"][0]))]]
        polygon = _polygon(opening, 0, 0)
        detections.append(_record("hole", cv.boundingRect(np.asarray(polygon, np.int32)), (cx, cy), polygon,
                                  .80, .75, opening_area_px=int(size), evidence="across_rope"))
    return detections, labels, healthy, valid, pitch


def _widths(mask):
    distance = cv.distanceTransform(mask, cv.DIST_L2, 5)
    # Distance ridges approximate centerlines without iterative skeletonization.
    # A ridge may follow either diagonal or either axial strand orientation.
    d = np.pad(distance, 1)
    center = d[1:-1, 1:-1]
    ridge = np.zeros_like(mask, dtype=bool)
    for first, second in (
        (d[:-2, :-2], d[2:, 2:]), (d[:-2, 2:], d[2:, :-2]),
        (d[:-2, 1:-1], d[2:, 1:-1]), (d[1:-1, :-2], d[1:-1, 2:]),
    ):
        ridge |= (center >= first) & (center >= second) & ((center > first) | (center > second))
    return np.where(ridge, 2 * distance, 0)


def _fouling(fouling, valid, widths, pitch):
    if not pitch:
        return []
    if not cv.countNonZero(fouling):
        return []
    density_size = max(5, int(pitch * 1.5) | 1)
    density = cv.boxFilter(fouling, -1, (density_size, density_size))
    clustered = cv.dilate(_mask(density >= 63), np.ones((density_size, density_size), np.uint8))
    evidence = fouling & valid & clustered
    size = max(5, int(pitch * .9) | 1)
    grouped = cv.morphologyEx(evidence, cv.MORPH_CLOSE,
                              cv.getStructuringElement(cv.MORPH_ELLIPSE, (size, size)))
    _, labels, stats, centers = _components(grouped)
    detections = []
    for idx, (x, y, w, h, _) in enumerate(stats[1:], 1):
        if min(w, h) < pitch:
            continue
        region = np.s_[y:y+h, x:x+w]
        support = labels[region] == idx
        actual = (evidence[region] != 0) & support
        area = int(actual.sum())
        if area < pitch ** 2 * 2.5 or area / support.sum() < .13:
            continue
        yy, xx = np.where(actual)
        nearby = widths[max(0, y-h//2):y+h+h//2, max(0, x-w//2):x+w+w//2]
        normal = nearby[(nearby > 0) & (nearby < pitch * .38)]
        fouled = _widths(evidence[region])
        fouled = fouled[fouled > 0]
        reference = np.median(normal) if normal.size else 0
        excess = float(np.percentile(fouled, 75) / reference - 1) if reference and fouled.size else None
        confidence = .79 + .10 * np.clip(excess or 0., 0, 1)
        detections.append(_record("biofouling", (x, y, w, h), (x+xx.mean(), y+yy.mean()),
                                  _polygon(_mask(support), x, y), confidence,
                                  .35 + .15 * np.log2(1 + area / pitch ** 2),
                                  projected_area_px=area, excess_material_ratio=excess))
    return detections


def _thinning(widths, valid, fouling, pitch, config, water):
    if not pitch:
        return []
    height, width = widths.shape
    # Aggregate supported centerline samples over mesh-scale tiles. Compare each
    # tile against its neighbors at comparable perspective and require adjacency.
    tile = max(9, round(pitch * 1.5))
    cols, rows = width // tile, height // tile
    if min(cols, rows) < 5:
        return []
    shape = (rows * tile, cols * tile)
    def tiles(image):
        return image[:shape[0], :shape[1]].reshape(rows, tile, cols, tile)
    thin = (widths > 0) & (widths <= max(3.3, pitch * .37))
    thin &= (valid != 0) & (cv.dilate(fouling, np.ones((5, 5), np.uint8)) == 0)
    count = tiles(thin).sum(axis=(1, 3))
    mean = tiles(widths * thin).sum(axis=(1, 3)) / np.maximum(count, 1)
    covered = tiles(valid != 0).mean(axis=(1, 3)) > .8
    watery = tiles(water != 0).mean(axis=(1, 3)) > .58
    # A partially visible strand must still span a substantial part of a tile.
    sampled = covered & (count >= tile * .6)
    healthy = np.where(sampled, mean, 0).astype(np.float32)
    reference = cv.dilate(cv.medianBlur(healthy, 3), np.ones((7, 7), np.uint8))
    ratio = mean / np.maximum(reference, 1)
    threshold = config.thinning_ratio - (.03 if config.mode == "investigation" else 0)
    seed = sampled & watery & (ratio <= threshold) & (reference >= 2.30)
    seed[[0, -1], :] = False
    seed[:, [0, -1]] = False
    _, labels, stats, centers = _components(_mask(seed))
    detections = []
    for idx, (x, y, w, h, count_tiles) in enumerate(stats[1:], 1):
        if count_tiles < 3:
            continue
        matched = labels[y:y+h, x:x+w] == idx
        observed = float(np.median(ratio[y:y+h, x:x+w][matched]))
        normal_width = float(np.median(reference[y:y+h, x:x+w][matched]))
        # A normal cell this small typically has strands only 1–2 pixels wide.
        resolved = normal_width >= 2.65 and pitch >= 14
        kind = "thinning" if resolved else "unknown"
        cx, cy = (centers[idx] + .5) * tile
        outline = cv.resize(_mask(matched), (w*tile, h*tile), interpolation=cv.INTER_NEAREST)
        detections.append(_record(kind, (x*tile, y*tile, w*tile, h*tile), (cx, cy),
                                  _polygon(outline, x*tile, y*tile),
                                  .62 + .20 * resolved, 1 - observed,
                                  width_ratio=observed, thickness_reduction=1-observed,
                                  evidence="apparent_width", reference_width_processing_px=normal_width))
    return detections


ACTION = {"hole": "urgent_repair_alert", "thinning": "preventative_maintenance",
          "biofouling": "mark_for_cleaning", "unknown": "acquire_more_observations"}
COLORS = {"hole": (35, 40, 250), "thinning": (15, 150, 255),
          "biofouling": (45, 225, 50), "unknown": (35, 225, 225)}


@dataclass
class _Track:
    detection: dict
    hits: int = 1
    streak: int = 1
    missed: int = 0
    confirmed: bool = False
    assessed: bool = False


@dataclass
class Tracker:
    """One instance per camera stream. IDs are scoped to this instance."""

    min_hits: int = 2
    max_misses: int = 3
    selected_id: int | None = field(init=False, default=None)
    _next_id: int = field(init=False, default=0)
    _tracks: dict[int, _Track] = field(init=False, default_factory=dict)

    def mark_assessed(self, target_id):
        """Exclude a tracked target from selection while it remains associated."""
        if target_id in self._tracks:
            self._tracks[target_id].assessed = True
        if self.selected_id == target_id:
            self.selected_id = None

    def reset(self):
        """Call on a camera cut, stream restart, or localization reset."""
        self._tracks.clear()
        self.selected_id = None

    def update(self, detections):
        pairs = []
        for index, detection in enumerate(detections):
            for target_id, track in self._tracks.items():
                previous = track.detection
                change = np.hypot(detection["dx"]-previous["dx"], detection["dy"]-previous["dy"])
                same = detection["type"] == previous["type"] or "unknown" in (
                    detection["type"], previous["type"])
                locked = target_id == self.selected_id
                if change < (.19 if locked else .14):
                    pairs.append((change + .085 * (not same), index, target_id))
        used = set()
        assigned = set()
        for _, index, target_id in sorted(pairs):
            if index in assigned or target_id in used:
                continue
            track = self._tracks[target_id]
            track.detection = detections[index]
            track.hits += 1
            track.streak = 1 if track.missed else track.streak + 1
            track.confirmed |= track.streak >= self.min_hits
            track.missed = 0
            used.add(target_id)
            assigned.add(index)
        for target_id in list(self._tracks):
            if target_id not in used:
                track = self._tracks[target_id]
                track.missed += 1
                retention = max(self.max_misses, 30) if track.assessed else self.max_misses
                if track.missed > retention:
                    del self._tracks[target_id]
        for index, detection in enumerate(detections):
            if index not in assigned:
                self._tracks[self._next_id] = _Track(detection, confirmed=self.min_hits <= 1)
                self._next_id += 1
        eligible = {
            target_id: track for target_id, track in self._tracks.items()
            if track.confirmed and not track.assessed and track.missed <= self.max_misses
        }
        if self.selected_id not in eligible:
            visible = [target_id for target_id, track in eligible.items() if not track.missed]
            self.selected_id = max(visible, key=lambda i: _priority(
                eligible[i].detection, eligible[i].hits), default=None)
        result = []
        for target_id, track in eligible.items():
            selected = target_id == self.selected_id
            if track.missed and not selected:
                continue
            result.append(dict(track.detection, id=target_id, selected=selected,
                               observed=not track.missed, missed_frames=track.missed,
                               persistence=track.hits,
                               confidence=track.detection["confidence"] * .82**track.missed,
                               recommended_action=("acquire_more_observations" if track.missed
                                                   else track.detection["recommended_action"])))
        return result


def _priority(detection, persistence=1):
    bonus = {"hole": .30, "thinning": .13, "biofouling": .08, "unknown": 0}
    return (.43*detection["severity"] + .36*detection["confidence"] + bonus[detection["type"]]
            - .10*np.hypot(detection["dx"], detection["dy"]) + .025*min(persistence, 6))


def _annotate(frame, detections):
    overlay = frame.copy()
    order = {"unknown": 0, "thinning": 1, "biofouling": 2, "hole": 3}
    for item in sorted(detections, key=lambda item: order[item["type"]]):
        if item["observed"]:
            cv.fillPoly(overlay, [np.asarray(item["polygon"], np.int32)], COLORS[item["type"]])
    output = cv.addWeighted(overlay, .37, frame, .63, 0)
    center = (frame.shape[1]//2, frame.shape[0]//2)
    for item in detections:
        point = tuple(map(round, item["centroid"]))
        if item["selected"]:
            cv.line(output, center, point, (0, 240, 255), 1, cv.LINE_AA)
            cv.drawMarker(output, point, (0, 240, 255), cv.MARKER_CROSS, 27, 2)
        x, y, _, _ = item["bbox"]
        label = f'{item["type"]} C {item["confidence"]:.2f} S {item["severity"]:.2f}'
        if not item["observed"]:
            label += " (last seen)"
        anchor = (min(x, max(0, output.shape[1]-235)), max(17, y-5))
        cv.putText(output, label, anchor, cv.FONT_HERSHEY_SIMPLEX, .47, (0, 0, 0), 3, cv.LINE_AA)
        cv.putText(output, label, anchor, cv.FONT_HERSHEY_SIMPLEX, .47, COLORS[item["type"]], 1, cv.LINE_AA)
    cv.drawMarker(output, center, (255, 255, 255), cv.MARKER_CROSS, 22, 1)
    return output


def inspect_frame(frame, *, config=None, tracker=None, render=True, diagnostics=None, timings=None):
    """Return (detections, annotated BGR image or None) from a uint8 BGR frame.

    Pass dicts as diagnostics or timings to receive intermediate images or stage seconds.
    Large frames are downscaled internally. Returned coordinates always refer to the input.
    """
    if not isinstance(frame, np.ndarray) or frame.dtype != np.uint8 or frame.ndim != 3 or frame.shape[2] != 3:
        raise ValueError("expected a uint8 H×W×3 BGR NumPy array")
    height, width = frame.shape[:2]
    if min(height, width) < 16:
        raise ValueError("frame dimensions must both be at least 16 pixels")
    config = config or Config()
    if config.mode not in ("survey", "investigation") or min(config.survey_width, config.investigation_width) < 16:
        raise ValueError("invalid perception mode or survey width")

    start = stage = perf_counter()
    def finish(name):
        nonlocal stage
        now = perf_counter()
        if timings is not None:
            timings[name] = now-stage
        stage = now

    working = frame
    target_width = config.survey_width if config.mode == "survey" else config.investigation_width
    if width > target_width:
        working = cv.resize(frame, (target_width, max(16, round(height*target_width/width))),
                            interpolation=cv.INTER_AREA)
    strands, fouling, material, water = _segment(working)
    finish("segmentation")
    detections, labels, healthy, valid, pitch = _openings(
        material, water, config, _ropes(working, material, water), _faint(working))
    finish("hole")
    widths = _widths(strands) if pitch or diagnostics is not None else None
    detections.extend(_thinning(widths, valid, fouling, pitch, config, water))
    finish("thinning")
    detections.extend(_fouling(fouling, valid, widths, pitch))
    finish("biofouling")
    sx, sy = width/working.shape[1], height/working.shape[0]
    for item in detections:
        x, y, bw, bh = item["bbox"]
        left, top = round(x*sx), round(y*sy)
        item["bbox"] = [left, top, round((x+bw)*sx)-left, round((y+bh)*sy)-top]
        item["polygon"] = [[min(width-1, round(px*sx)), min(height-1, round(py*sy))]
                           for px, py in item["polygon"]]
        cx, cy = item["centroid"]
        cx, cy = cx*sx, cy*sy
        item.update(centroid=[cx, cy], dx=2*cx/width-1, dy=2*cy/height-1)
        for key in ("opening_area_px", "projected_area_px", "local_median_area_px"):
            if key in item:
                item[key] = round(item[key]*sx*sy)
        if config.mode == "investigation" and item["confidence"] >= .72:
            item["recommended_action"] = ACTION[item["type"]]
        elif config.mode == "investigation" or item["type"] == "unknown":
            item["recommended_action"] = ACTION["unknown"]
    if tracker is None:
        detections.sort(key=_priority, reverse=True)
        for index, item in enumerate(detections):
            item.update(id=index, selected=index == 0, observed=True, persistence=1, missed_frames=0)
    else:
        detections = tracker.update(detections)
    finish("tracking")
    annotated = _annotate(frame, detections) if render else None
    finish("rendering")
    if diagnostics is not None:
        opening_view = cv.applyColorMap((labels % 251 + 1).astype(np.uint8), cv.COLORMAP_TURBO)
        opening_view[labels == 0] = 0
        width_view = cv.applyColorMap(np.clip(widths*34, 0, 255).astype(np.uint8), cv.COLORMAP_TURBO)
        width_view[widths == 0] = 0
        diagnostics.update(original=working, strands=strands, biofouling=fouling, material=material,
                           valid=valid, openings=opening_view, thickness=width_view,
                           mesh_openings=int(healthy.sum()), typical_opening_area_px=pitch**2,
                           selected_overlay=annotated)
    finish("diagnostics")
    if timings is not None:
        timings["total"] = perf_counter()-start
    return detections, annotated