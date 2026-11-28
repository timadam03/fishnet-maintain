"""
fishfarm_demo.py  --  Isaac Sim 5.x standalone demo (Abyss net-pen inspection)

Builds a fish-farm net pen (diamond-mesh netting split into labelled panels, floating
collar, handrail, sinker ring, bottom net), a seabed, underwater lighting + fog, a
school of fish, spawns 3 underwater vehicles with simple hydrodynamics + PD control,
and has each vehicle inspect its 120 deg sector of the net, saving labelled images.

Run with Isaac Sim's own Python:
    Linux:    ~/isaacsim/python.sh fishfarm_demo.py
    Windows:  C:\\isaacsim\\python.bat fishfarm_demo.py
    pip:      python fishfarm_demo.py          (if you installed `isaacsim` via pip)

Options:
    --bands N          number of depth bands per vehicle in demo mode (default 3)
    --full-coverage    compute bands/columns from camera FOV for 100% net coverage
    --view V           viewport camera: orbit | auv0 | auv1 | auv2   (default orbit)
    --out DIR          output folder for images (default ./fence_captures)
    --no-fish          skip the fish school
    --headless         no GUI (images are still captured)
    --no-surface --no-fog --brightness 2.0     visibility knobs if the scene looks too dark
    --lite             low-end PC mode (smaller cameras, fewer objects)
    --save-usd FILE    build the scene, save it as .usd and quit (inspect it in the Isaac Sim app)
    --preview          build the scene and display it without running physics
    --record DIR       save frames + telemetry for a video (headless OK), then:  python make_video.py DIR
    --record-cams demo,section,auv0,auv1,auv2   --record-res 1920x1080   --record-every 2   --pathtrace 32
    --view section     watch the cutaway (cross-section) camera in the GUI
    --hq               high-quality scene for a big GPU (finer net, more fish/rocks, kelp forest)
    --auv-usd PATH     use a real vehicle model (e.g. BlueROV2 USD) instead of the built-in box ROV
    --auv-scale S --auv-rpy R P Y --auv-offset X Y Z   fit that model to the body frame
    --oceansim         use OceanSim's UW_Camera (underwater colour/haze model) for the vehicle cameras
    --nav-policy NPZ   learned PPO navigator (from train_fishfarm_nav.py) + HOCBF safety filter
    --safe-nav         HOCBF filter with a simple goal-seeking nominal controller (no learned policy)
    --obstacles N      hanging ropes inside the pen to avoid (default 3)   --no-cbf  filter off (A/B)
    --diver            moving obstacle: a diver crossing the pen (HOCBF uses its velocity)
    --perception       HOCBF built from simulated sonar hits (no map) -- the sim-to-real path
    --no-viz           hide the nominal (yellow) / safe (green, red = filter active) command arrows
    --plan PLAN.json   fly the decision layer's ranked targets (closer, other angles, more shots, per-target
                       HOCBF margin) instead of the sweep; photos carry target_id; writes plan_status.json
    --plan-revisits N  --plan-coverage N  --wp-timeout S       (see sim/plan_mode.py)
"""

import argparse
import json
import math
import os
import time

parser = argparse.ArgumentParser()
parser.add_argument("--bands", type=int, default=3)
parser.add_argument("--survey", default="centre", choices=["centre", "orbit"],
                    help="centre (default): hold station near the middle of the pen and yaw through "
                         "the sector, so the whole net is surveyed from far away. orbit: fly along "
                         "the net at --standoff, the close pass a decision layer asks for.")
parser.add_argument("--centre-radius", type=float, default=1.5,
                    help="distance from the pen axis each vehicle holds in centre survey [m]. "
                         "Keeps the three apart; 0 would stack them on the axis.")
parser.add_argument("--standoff", type=float, default=4.0,
                    help="distance from the net when taking pictures [m]. The survey pass runs far "
                         "(default 4); a decision-layer re-inspection runs close (e.g. 1.5)")
parser.add_argument("--full-coverage", action="store_true")
parser.add_argument("--view", default="orbit", choices=["orbit", "section", "auv0", "auv1", "auv2"])
parser.add_argument("--hq", action="store_true",
                    help="high-quality scene for big GPUs: finer net, 1280x720 ROV cams, more fish/rocks, kelp forest")
parser.add_argument("--out", default="fence_captures")
parser.add_argument("--no-fish", action="store_true")
parser.add_argument("--headless", action="store_true")
parser.add_argument("--record", default=None,
                    help="save video frames + telemetry to this folder (works headless; then run make_video.py)")
parser.add_argument("--record-cams", default="demo,section,auv0,auv1,auv2",
                    help="comma list of cameras to record: demo (orbit), section (cutaway), auv0, auv1, auv2")
parser.add_argument("--record-res", default="1920x1080", help="resolution of the demo (orbit) camera frames")
parser.add_argument("--record-every", type=int, default=2, help="save every N physics steps (2 -> 30 fps video)")
parser.add_argument("--pathtrace", type=int, default=0,
                    help="path-traced frames with this many samples/pixel (e.g. 32); 0 = real-time RTX")
parser.add_argument("--save-usd", default=None,
                    help="build the scene, save it to this .usd file and quit (open it in the Isaac Sim app)")
parser.add_argument("--preview", action="store_true", help="build the scene and just display it (no physics, no capture)")
parser.add_argument("--lite", action="store_true",
                    help="low-end mode: 640x360 cameras, fewer rocks/fish, coarser net (8 GB GPU / 16 GB RAM)")
parser.add_argument("--no-surface", action="store_true", help="hide the water surface plane")
parser.add_argument("--defect-seed", type=int, default=7,
                    help="seed for hole / thinning / fouling placement only. Vary it to generate a "
                         "set of different nets for training; the rest of the scene is unaffected.")
parser.add_argument("--scenery", action="store_true",
                    help="keep the seabed, rocks, kelp and water surface in view. Off by default: an "
                         "inspection frame should be net against flat water, nothing else, or the "
                         "classifier learns the scenery. Turn it on for cinematic recording.")
parser.add_argument("--no-fog", action="store_true", help="disable underwater haze")
parser.add_argument("--brightness", type=float, default=1.0, help="scale dome + sun light (e.g. 2.0)")
parser.add_argument("--auv-usd", default=None,
                    help="USD of a vehicle model (e.g. BlueROV2 from OceanSim_assets or GRAAL BROV_low.usd); "
                         "used as visuals, physics stays in this script")
parser.add_argument("--auv-scale", type=float, default=1.0, help="scale for --auv-usd (0.01 if the asset is in cm)")
parser.add_argument("--auv-rpy", type=float, nargs=3, default=[0.0, 0.0, 0.0],
                    help="roll pitch yaw [deg] so the model's nose points along +X")
parser.add_argument("--auv-offset", type=float, nargs=3, default=[0.0, 0.0, 0.0])
parser.add_argument("--oceansim", action="store_true", help="use OceanSim UW_Camera for the vehicle cameras")
parser.add_argument("--nav-policy", default=None,
                    help="fishfarm_nav.npz from train_fishfarm_nav.py: learned navigator for transits")
parser.add_argument("--safe-nav", action="store_true",
                    help="HOCBF safety filter on all motion (implied by --nav-policy)")
parser.add_argument("--no-cbf", action="store_true", help="disable the HOCBF filter (A/B comparison)")
parser.add_argument("--diver", action="store_true", help="a diver swims back and forth through the pen")
parser.add_argument("--perception", action="store_true",
                    help="HOCBF constraints from simulated sonar (PhysX sphere-casts) instead of the known map")
parser.add_argument("--no-viz", action="store_true", help="hide HOCBF arrows / safety rings")
parser.add_argument("--obstacles", type=int, default=3,
                    help="hanging ropes/hoses inside the pen when navigation is on (any number, e.g. 3, 6, 12)")
parser.add_argument("--oceansim-ext", default="isaacsim.oceansim",
                    help="OceanSim extension id as shown in Window > Extensions")
parser.add_argument("--plan", default=None,
                    help="fly the decision layer's plan.json (ranked targets) instead of the coverage sweep. "
                         "Use the same --standoff, --bands, --obstacles and --defect-seed as the sweep, so the scene matches")
parser.add_argument("--plan-revisits", type=int, default=0,
                    help="fly the plan targets this many extra times, spread through the coverage cells")
parser.add_argument("--plan-coverage", type=int, default=0,
                    help="after the targets, sweep this many of the plan's coverage cells (stalest first) at --standoff")
parser.add_argument("--wp-timeout", type=float, default=None,
                    help="seconds to reach a waypoint before photographing anyway (default 20, 40 with --plan)")
args, _ = parser.parse_known_args()

# SimulationApp must be created before any other omni / isaacsim import
from isaacsim import SimulationApp

simulation_app = SimulationApp({"headless": args.headless, "width": 1920, "height": 1080})

import carb
import numpy as np
import omni.replicator.core as rep
import omni.usd
from isaacsim.core.api import World
from isaacsim.core.prims import RigidPrim
from PIL import Image
from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux, UsdPhysics, UsdShade, Vt

UW_Camera = None
if args.oceansim:
    try:
        from isaacsim.core.utils.extensions import enable_extension
        enable_extension(args.oceansim_ext)
        simulation_app.update()
        from isaacsim.oceansim.sensors.UW_Camera import UW_Camera
        print("[demo] OceanSim UW_Camera enabled")
    except Exception as exc:  # fall back to plain RTX cameras
        print(f"[demo] WARNING: OceanSim not available ({exc}); using plain cameras. "
              f"Check the extension id in Window > Extensions and pass --oceansim-ext.")

# ----------------------------------------------------------------------------- config
CAGE_R = 8.0              # net pen radius [m]
CAGE_DEPTH = 8.0          # net wall depth [m] (from z=0 down to z=-8)
N_COLS, N_ROWS = 12, 3    # panels around x panels down  -> labels panel_r{row}_c{col}
# Logical inspection grid, shared with the operator UI (web/src/data/model.ts).
# Deliberately separate from the visual panel grid above: the mesh stays coarse to keep the
# render cheap, while captures are addressed on the UI's cell grid so one capture maps to
# exactly one cell the decision layer reasons about. The Isaac pen is a scale model -- only
# (row, col) cross the seam, never metres.
UI_SECTORS = 24           # must equal ANGLE_SECTORS in web/src/data/model.ts
UI_WALL_ROWS = 8          # must equal WALL_ROWS in web/src/data/model.ts
RUN_ID = time.strftime("%Y%m%dT%H%M%S")   # stamped into every capture record
MESH_SPACING = 0.25 if args.lite else (0.1 if args.hq else 0.15)   # visual net mesh size [m]
TWINE_W, ROPE_W = 0.018, 0.05
# Injected defects (ground truth goes into the metadata). Sparse on purpose: a first pass is
# meant to surface a few weak areas worth re-inspecting, not to label every panel. Patches live
# in (u, v) arc-length space so they straddle panel borders instead of looking panel-shaped.
N_HOLES = 4                             # cut-through holes, mixed sizes
N_THIN = 3                              # abraded / thinning twine: the precursor to a hole
N_FOUL = 4                              # biofouling and mould growth
HOLE_RADII = (0.10, 0.16, 0.28, 0.45)   # m, one per hole: mostly small, one obvious
THIN_RADIUS = (0.75, 1.25)              # m, patch radius range
FOUL_RADIUS = (0.60, 1.10)              # m, patch radius range
DEFECT_BUDGET = 0.10                    # refuse to build a net more defective than this
SEABED_Z = -30.0          # deep enough to sit beyond the fog, so it never shows behind the net

N_AUV = 3
MASS, G = 11.0, 9.81      # BlueROV2-ish
BUOYANCY_RATIO = 1.0      # 1.0 = neutrally buoyant
COB_HEIGHT = 0.05         # centre of buoyancy above CG -> passive roll/pitch stability
LIN_DAMP, QUAD_DAMP, ANG_DAMP = 8.0, 20.0, 1.0
CURRENT = np.array([0.12, 0.05, 0.0])   # water current [m/s]
KP, KD, F_MAX = 20.0, 15.0, 30.0
KP_YAW, KD_YAW, TZ_MAX = 2.0, 0.5, 3.0

STANDOFF = args.standoff  # distance from net [m]; --standoff 1.5 for a close re-inspection pass
OVERLAP = 0.30
RES = (640, 360) if args.lite else (1280, 720)   # --hq keeps 1280x720; use --record-res for the cinematic views
FOCAL, H_APERTURE = 18.0, 20.955
V_APERTURE = H_APERTURE * RES[1] / RES[0]
SETTLE_POS, SETTLE_YAW, SETTLE_SPEED = 0.15, math.radians(4.0), 0.08
SETTLE_FRAMES = 30
# A plan sends robots across the pen between targets, with the filter slowing them: allow longer.
# 40 s is a starting value to tune on the GPU, not a measured transit time.
WP_TIMEOUT = args.wp_timeout or (40.0 if args.plan else 20.0)

LAMP_INTENSITY = 1.5e6    # vehicle spotlights -- tweak if too bright/dark
# Real net-inspection footage is a lit net against flat, dark water: everything past the net is
# gone. At 35 m the surface and the seabed stayed lit and washed the frame out, so this is the
# number that sets the look. Keep it a few metres past STANDOFF, never far enough to reach the
# surface or the seabed.
FOG_END = 12.0            # visibility distance [m]

rng = np.random.default_rng(7)

# ----------------------------------------------------------------------------- safe navigation
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plan_mode as pm  # noqa: E402  numpy only; also builds the centre-survey waypoints
NAV = bool(args.nav_policy or args.safe_nav)
POLICY, SAFETY, NCFG = None, None, None
if NAV:
    import safe_nav as sn
    NCFG = dict(sn.DEFAULTS)
    if args.nav_policy:
        POLICY = sn.NumpyPolicy(args.nav_policy)
        NCFG.update({k: v for k, v in POLICY.cfg.items() if k in sn.DEFAULTS})
        print(f"[nav] learned policy {args.nav_policy}  (training eval: {POLICY.cfg.get('eval')})")
    if not args.no_cbf:
        # One filter per ROV: a plan gives each target its own margin (inflation), and one robot
        # moving in close must not change the margin the others keep.
        SAFETY = [sn.SafetyFilter(NCFG["a_max"], NCFG["drag"], NCFG["alpha1"], NCFG["alpha2"],
                                  NCFG["net_radius"], NCFG["inflation"], NCFG["detect_radius"],
                                  current=CURRENT[:2], use_wall=not args.perception)
                  for _ in range(N_AUV)]
    print(f"[nav] HOCBF filter {'ON' if SAFETY else 'OFF'}, nominal = {'PPO policy' if POLICY else 'goal-seeking'}")
NAV_SWITCH = 0.8          # [m] use the policy for transits longer than this, PD-in-accel for final approach
HOVER_KP, HOVER_KD = 1.0, 1.6
ROPE_R = 0.12
ESCAPE = 0.3              # HOCBF deadlock tie-break (sideways nudge, safety unchanged)
DIVER_R, DIVER_SPEED, DIVER_Z = 0.45, 0.35, -3.5
DIVER_DIR = np.array([math.cos(math.radians(25)), math.sin(math.radians(25))])
DIVER_HALF = 6.2          # swims along a chord through the centre, turning at +-6.2 m
SONAR_N, SONAR_SPHERE, SONAR_EVERY = 32, 0.1, 3


def diver_state(t):
    """Triangle-wave swim along a chord: returns (xy, velocity_xy)."""
    L = 2 * DIVER_HALF
    s = (DIVER_SPEED * t + DIVER_HALF) % (2 * L)
    if s < L:
        return DIVER_DIR * (s - DIVER_HALF), DIVER_DIR * DIVER_SPEED
    return DIVER_DIR * (DIVER_HALF - (s - L)), -DIVER_DIR * DIVER_SPEED


def rows5(arr, vel=None):
    """Obstacle rows -> (k,5) [x, y, r, vx, vy]."""
    a = np.asarray(arr, float).reshape(-1, 3) if np.asarray(arr).size else np.zeros((0, 3))
    v = np.zeros((len(a), 2)) if vel is None else np.asarray(vel, float).reshape(-1, 2)
    return np.hstack([a, v])
DTH_PANEL = 2 * math.pi / N_COLS
PANEL_H = CAGE_DEPTH / N_ROWS

# ----------------------------------------------------------------------------- world
world = World(stage_units_in_meters=1.0, physics_dt=1.0 / 60.0, rendering_dt=1.0 / 60.0)
stage = omni.usd.get_context().get_stage()
UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
UsdGeom.Xform.Define(stage, "/World/Looks")


def make_mat(name, color, rough=0.5, metal=0.0, opacity=1.0, emissive=(0, 0, 0)):
    path = f"/World/Looks/{name}"
    mat = UsdShade.Material.Define(stage, path)
    sh = UsdShade.Shader.Define(stage, path + "/Shader")
    sh.CreateIdAttr("UsdPreviewSurface")
    sh.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*color))
    sh.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(rough)
    sh.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(metal)
    sh.CreateInput("opacity", Sdf.ValueTypeNames.Float).Set(opacity)
    sh.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*emissive))
    mat.CreateSurfaceOutput().ConnectToSource(sh.ConnectableAPI(), "surface")
    return mat


def bind(prim, mat):
    prim = prim.GetPrim() if hasattr(prim, "GetPrim") else prim
    UsdShade.MaterialBindingAPI.Apply(prim).Bind(mat)


def set_xform(prim, t=(0, 0, 0), r=None, s=None):
    prim = prim.GetPrim() if hasattr(prim, "GetPrim") else prim
    x = UsdGeom.Xformable(prim)
    x.ClearXformOpOrder()
    x.AddTranslateOp().Set(Gf.Vec3d(*map(float, t)))
    if r is not None:
        x.AddRotateXYZOp().Set(Gf.Vec3f(*map(float, r)))
    if s is not None:
        x.AddScaleOp().Set(Gf.Vec3f(*map(float, s)))


def make_mesh(path, pts, counts, idx, normals=None, double_sided=False):
    m = UsdGeom.Mesh.Define(stage, path)
    pts = np.asarray(pts, dtype=np.float32)
    m.CreatePointsAttr(Vt.Vec3fArray([Gf.Vec3f(*p) for p in pts.tolist()]))
    m.CreateFaceVertexCountsAttr(Vt.IntArray(counts))
    m.CreateFaceVertexIndicesAttr(Vt.IntArray(idx))
    m.CreateSubdivisionSchemeAttr("none")
    m.CreateDoubleSidedAttr(double_sided)
    m.CreateExtentAttr(Vt.Vec3fArray([Gf.Vec3f(*pts.min(0).tolist()), Gf.Vec3f(*pts.max(0).tolist())]))
    if normals is not None:
        m.CreateNormalsAttr(Vt.Vec3fArray([Gf.Vec3f(*n) for n in np.asarray(normals, dtype=np.float32).tolist()]))
        m.SetNormalsInterpolation("vertex")
    return m


def torus(path, major, minor, z, mat, nu=160, nv=16):
    pts, nrm, counts, idx = [], [], [], []
    for i in range(nu):
        th = 2 * math.pi * i / nu
        for j in range(nv):
            ph = 2 * math.pi * j / nv
            c = major + minor * math.cos(ph)
            pts.append((c * math.cos(th), c * math.sin(th), z + minor * math.sin(ph)))
            nrm.append((math.cos(ph) * math.cos(th), math.cos(ph) * math.sin(th), math.sin(ph)))
    for i in range(nu):
        for j in range(nv):
            a, b = i * nv + j, ((i + 1) % nu) * nv + j
            c, d = ((i + 1) % nu) * nv + (j + 1) % nv, i * nv + (j + 1) % nv
            counts.append(4)
            idx += [a, b, c, d]
    bind(make_mesh(path, pts, counts, idx, normals=nrm), mat)


# ----------------------------------------------------------------------------- materials
M = {
    # Light twine against the dark teal fog: the net has to separate from the background, or a
    # classifier trained on these frames learns the haze instead of the mesh.
    # Dark twine against lit water. A pale net on a pale background is what washed the frames out;
    # a dark net silhouettes, which is how real inspection footage reads and what a classifier can
    # actually segment. Fouling is the one thing that gets lighter and warmer, so it separates.
    "net": make_mat("net", (0.08, 0.12, 0.11), rough=0.75),
    "net_thin": make_mat("net_thin", (0.17, 0.21, 0.19), rough=0.7),
    "net_fouled": make_mat("net_fouled", (0.30, 0.25, 0.10), rough=0.95),
    "rope": make_mat("rope", (0.16, 0.12, 0.07), rough=0.8),
    "hdpe": make_mat("hdpe", (0.03, 0.03, 0.03), rough=0.35),
    "steel": make_mat("steel", (0.55, 0.57, 0.6), rough=0.3, metal=0.9),
    "sand": make_mat("sand", (0.42, 0.38, 0.28), rough=0.95),
    "rock": make_mat("rock", (0.22, 0.21, 0.19), rough=0.9),
    "water": make_mat("water_surface", (0.05, 0.20, 0.26), rough=0.05, opacity=0.6),
    "fish": make_mat("fish", (0.62, 0.66, 0.72), rough=0.3, metal=0.6),
    "auv": make_mat("auv_hull", (1.0, 0.55, 0.05), rough=0.4),
    "auv_top": make_mat("auv_top", (0.92, 0.92, 0.9), rough=0.5),
    "thruster": make_mat("thruster", (0.05, 0.05, 0.06), rough=0.4),
    "led": make_mat("led", (0.1, 0.8, 1.0), emissive=(0.2, 2.0, 3.0)),
}

# ----------------------------------------------------------------------------- environment
UsdGeom.Xform.Define(stage, "/World/Env")
seabed = UsdGeom.Cube.Define(stage, "/World/Env/Seabed")
seabed.CreateSizeAttr(1.0)
set_xform(seabed, (0, 0, SEABED_Z - 0.5), s=(300, 300, 1))
UsdPhysics.CollisionAPI.Apply(seabed.GetPrim())   # collision stays: the AUVs still cannot fall through
bind(seabed, M["sand"])
if not args.scenery:
    UsdGeom.Imageable(seabed.GetPrim()).MakeInvisible()

for i in range(0 if not args.scenery else (15 if args.lite else (160 if args.hq else 70))):
    r, a = rng.uniform(9, 70), rng.uniform(0, 2 * math.pi)
    rock = UsdGeom.Sphere.Define(stage, f"/World/Env/Rocks/rock_{i:02d}")
    rock.CreateRadiusAttr(1.0)
    sc = rng.uniform(0.4, 2.5)
    set_xform(rock, (r * math.cos(a), r * math.sin(a), SEABED_Z),
              r=(0, 0, rng.uniform(0, 360)), s=(sc * rng.uniform(0.8, 1.6), sc, sc * rng.uniform(0.3, 0.6)))
    bind(rock, M["rock"])

water = make_mesh("/World/Env/WaterSurface", [(-200, -200, 0), (200, -200, 0), (200, 200, 0), (-200, 200, 0)],
                  [4], [0, 1, 2, 3], double_sided=True)
bind(water, M["water"])
# the surface must never shadow the pen (it is meant to be a see-through visual only)
UsdGeom.PrimvarsAPI(water.GetPrim()).CreatePrimvar("doNotCastShadows", Sdf.ValueTypeNames.Bool).Set(True)
if args.no_surface or not args.scenery:
    UsdGeom.Imageable(water.GetPrim()).MakeInvisible()

# With the scenery hidden, the dome is the only thing behind the net: its colour is the flat blue
# the net is seen against, and it lights the net at the same time.
dome = UsdLux.DomeLight.Define(stage, "/World/Env/Dome")
dome.CreateIntensityAttr((900.0 if not args.scenery else 450.0) * args.brightness)
dome.CreateColorAttr(Gf.Vec3f(0.22, 0.46, 0.52))
sun = UsdLux.DistantLight.Define(stage, "/World/Env/Sun")
sun.CreateIntensityAttr((1200.0 if not args.scenery else 3000.0) * args.brightness)
sun.CreateAngleAttr(2.0)
sun.CreateColorAttr(Gf.Vec3f(0.8, 0.95, 1.0))
set_xform(sun, r=(15, 10, 0))

# underwater haze (RTX distance fog). If you see no fog: Render Settings > Common > Fog.
settings = carb.settings.get_settings()
for key, val in {
    "/rtx/fog/enabled": bool(args.scenery) and not args.no_fog,
    "/rtx/fog/fogColor": [0.015, 0.105, 0.135],
    "/rtx/fog/fogColorIntensity": 1.0,
    "/rtx/fog/fogStartDist": max(1.5, STANDOFF * 1.3),
    "/rtx/fog/fogEndDist": FOG_END,
    "/rtx/fog/fogDistanceDensity": 1.0,
}.items():
    settings.set(key, val)

# kelp / seaweed strands outside the pen (visual only)
N_KELP = 0 if (args.lite or not args.scenery) else (140 if args.hq else 50)
kelp_mats = [make_mat(f"kelp_{i}", c, rough=0.7) for i, c in
             enumerate([(0.10, 0.22, 0.06), (0.16, 0.20, 0.05), (0.08, 0.17, 0.09)])]
for i in range(N_KELP):
    r, a = rng.uniform(11, 40), rng.uniform(0, 2 * math.pi)
    h = rng.uniform(2.5, 9.0)
    kelp = UsdGeom.Cylinder.Define(stage, f"/World/Env/Kelp/k_{i:03d}")
    kelp.CreateRadiusAttr(1.0)
    kelp.CreateHeightAttr(1.0)
    kelp.CreateAxisAttr("Z")
    set_xform(kelp, (r * math.cos(a), r * math.sin(a), SEABED_Z + h / 2),
              r=(rng.uniform(-12, 12), rng.uniform(-12, 12), rng.uniform(0, 180)),
              s=(rng.uniform(0.08, 0.18), 0.015, h))
    bind(kelp, kelp_mats[i % 3])

# ----------------------------------------------------------------------------- net pen
UsdGeom.Xform.Define(stage, "/World/Cage")
UsdGeom.Xform.Define(stage, "/World/Cage/Net")


def add_ribbon(store, P, Q, normal, width):
    d = Q - P
    w = np.cross(normal, d)
    nw = np.linalg.norm(w)
    if nw < 1e-9:
        return
    w = w / nw * width / 2
    b = len(store["pts"])
    store["pts"] += [P - w, P + w, Q + w, Q - w]
    store["counts"].append(4)
    store["idx"] += [b, b + 1, b + 2, b + 3]


def cyl(u, v):
    th = u / CAGE_R
    return np.array([CAGE_R * math.cos(th), CAGE_R * math.sin(th), v])


# ----------------------------------------------------------------------------- defects
# Ground truth. (u, v) = arc length around the pen and depth; u wraps at the circumference.
# Its own generator on purpose: `rng` is also drawn by the rocks and kelp, whose counts depend on
# --lite and --scenery, so sharing it meant a flag that only changed scene dressing silently moved
# every hole. Defect layout now depends on --defect-seed and nothing else.
drng = np.random.default_rng(args.defect_seed)
U_MAX = 2 * math.pi * CAGE_R


def du(a, b):
    """Shortest distance along the circumference between two u coordinates."""
    d = abs(a - b) % U_MAX
    return min(d, U_MAX - d)


def patch_dist(u, v, pu, pv):
    return math.hypot(du(u, pu), v - pv)


def panel_of(u, v):
    col = int((u / CAGE_R) % (2 * math.pi) // DTH_PANEL) % N_COLS
    return min(N_ROWS - 1, max(0, int(-v // PANEL_H))), col


def place_patches(n, rmin, rmax, taken, margin=0.5):
    """Centres kept apart and clear of the top and bottom ropes, so patches stay distinct."""
    out = []
    for _ in range(n):
        for _try in range(400):
            r = float(drng.uniform(rmin, rmax))
            u = float(drng.uniform(0, U_MAX))
            v = float(drng.uniform(-CAGE_DEPTH + r + 0.4, -r - 0.4))
            if all(patch_dist(u, v, pu, pv) > r + pr + margin for pu, pv, pr in taken + out):
                out.append((u, v, r))
                break
    return out


THIN = place_patches(N_THIN, THIN_RADIUS[0], THIN_RADIUS[1], taken=[])
FOUL = place_patches(N_FOUL, FOUL_RADIUS[0], FOUL_RADIUS[1], taken=THIN)

# The first holes open inside thinning patches, the way a real net fails where it is already
# abraded; the rest appear on their own. That correlation is something the decision layer can
# learn to act on -- thinning seen today is where to look again next week.
HOLES = []  # (row, col, u, v, radius)
for i, hr in enumerate(HOLE_RADII[:N_HOLES]):
    if i < min(2, len(THIN)):
        pu, pv, pr = THIN[i]
        a = float(drng.uniform(0, 2 * math.pi))
        d = float(drng.uniform(0, max(0.0, pr - hr - 0.1)))
        u = (pu + d * math.cos(a)) % U_MAX
        v = min(-hr - 0.3, max(-CAGE_DEPTH + hr + 0.3, pv + d * math.sin(a)))
    else:
        u = float(drng.uniform(0, U_MAX))
        v = float(drng.uniform(-CAGE_DEPTH + hr + 0.4, -hr - 0.4))
    r, c = panel_of(u, v)
    HOLES.append((r, c, u, v, float(hr)))

NET_AREA = U_MAX * CAGE_DEPTH
DEFECT_AREA = (sum(math.pi * r * r for _, _, r in THIN + FOUL)
               + sum(math.pi * h[4] * h[4] for h in HOLES))
DEFECT_FRAC = DEFECT_AREA / NET_AREA
if DEFECT_FRAC > DEFECT_BUDGET:
    raise SystemExit(f"defects cover {DEFECT_FRAC:.1%} of the net, over the "
                     f"{DEFECT_BUDGET:.0%} budget -- lower N_THIN / N_FOUL or the radii")


def thin_at(u, v):
    """0 outside every thinning patch, 1 at a centre, smooth in between."""
    return max([0.0] + [1.0 - (patch_dist(u, v, pu, pv) / pr) ** 2
                        for pu, pv, pr in THIN if patch_dist(u, v, pu, pv) < pr])


def foul_at(u, v):
    """Same, for biofouling growth."""
    return max([0.0] + [1.0 - (patch_dist(u, v, pu, pv) / pr) ** 2
                        for pu, pv, pr in FOUL if patch_dist(u, v, pu, pv) < pr])


def lump(u, v):
    """Deterministic 0..1 noise, so growth clumps at some crossings instead of coating evenly."""
    s = math.sin(u * 12.9898 + v * 78.233) * 43758.5453
    return s - math.floor(s)


def build_panel(row, col):
    u0, u1 = col * DTH_PANEL * CAGE_R, (col + 1) * DTH_PANEL * CAGE_R
    v1 = -row * PANEL_H
    v0 = v1 - PANEL_H
    def near_u(x):
        """x shifted a whole circumference if that puts it beside this panel (u wraps)."""
        for s in (-U_MAX, 0.0, U_MAX):
            if u0 - 2.0 <= x + s <= u1 + 2.0:
                return x + s
        return x

    # Any hole that reaches this panel, not just one centred in it, so a hole on a border cuts
    # both panels instead of stopping at the seam.
    holes = [(near_u(hu), hv, hr) for (r, c, hu, hv, hr) in HOLES
             if du((u0 + u1) / 2, hu) < (u1 - u0) / 2 + hr and abs((v0 + v1) / 2 - hv) < (v1 - v0) / 2 + hr]
    step = MESH_SPACING * math.sqrt(2)
    segs = []
    k = math.ceil((u0 - v1) / step)          # diagonals u - v = c
    while k * step <= u1 - v0:
        c = k * step
        va, vb = max(v0, u0 - c), min(v1, u1 - c)
        if vb - va > 1e-4:
            segs.append(((va + c, va), (vb + c, vb), TWINE_W, True))
        k += 1
    k = math.ceil((u0 + v0) / step)          # diagonals u + v = c
    while k * step <= u1 + v1:
        c = k * step
        va, vb = max(v0, c - u1), min(v1, c - u0)
        if vb - va > 1e-4:
            segs.append(((c - va, va), (c - vb, vb), TWINE_W, True))
        k += 1
    segs += [((u0, v1), (u1, v1), ROPE_W, False), ((u0, v0), (u1, v0), ROPE_W, False),
             ((u0, v0), (u0, v1), ROPE_W, False)]

    # Twine is split by condition, not by panel: one mesh per material so a patch of growth or
    # abrasion reads as a patch, instead of turning a whole 30-degree panel a different colour.
    store = {"pts": [], "counts": [], "idx": []}
    thin_store = {"pts": [], "counts": [], "idx": []}
    foul_store = {"pts": [], "counts": [], "idx": []}
    rope_store = {"pts": [], "counts": [], "idx": []}
    cu, cv, hu_, hv_ = (u0 + u1) / 2, (v0 + v1) / 2, (u1 - u0) / 2, (v1 - v0) / 2
    touched = any(du(cu, pu) < hu_ + pr and abs(cv - pv) < hv_ + pr for pu, pv, pr in THIN + FOUL)
    piece = 0.06 if holes else (0.12 if touched else 0.4)
    for (a, b, w, cuttable) in segs:
        a, b = np.array(a), np.array(b)
        n = max(1, math.ceil(np.linalg.norm(b - a) / piece))
        for s in range(n):
            pa, pb = a + (b - a) * s / n, a + (b - a) * (s + 1) / n
            mid = (pa + pb) / 2
            thm = mid[0] / CAGE_R
            normal = np.array([math.cos(thm), math.sin(thm), 0.0])
            if not cuttable:
                add_ribbon(rope_store, cyl(*pa), cyl(*pb), normal, w)
                continue
            if any(math.hypot(mid[0] - hu, mid[1] - hv) < hr for hu, hv, hr in holes):
                continue
            um, vm = mid[0] % U_MAX, mid[1]
            f, t = foul_at(um, vm), thin_at(um, vm)
            if f > 0.12:
                # Growth adds bulk unevenly: heavy clumps at some crossings, bare twine between.
                target = foul_store
                width = w * min(4.5, 1.0 + 3.2 * f * (0.3 + lump(um, vm)))
            elif t > 0.25:
                # Abrasion takes it away: down to about a third of the twine at the centre.
                target, width = thin_store, w * (1.0 - 0.68 * t)
            else:
                target, width = store, w * (1.0 - 0.25 * t)
            add_ribbon(target, cyl(*pa), cyl(*pb), normal, width)

    path = f"/World/Cage/Net/panel_r{row}_c{col:02d}"
    mesh = make_mesh(path, store["pts"], store["counts"], store["idx"], double_sided=True)
    bind(mesh, M["net"])
    UsdPhysics.CollisionAPI.Apply(mesh.GetPrim())
    UsdPhysics.MeshCollisionAPI.Apply(mesh.GetPrim()).CreateApproximationAttr("none")
    for suffix, sub, mat in (("_thin", thin_store, M["net_thin"]), ("_fouled", foul_store, M["net_fouled"])):
        if not sub["pts"]:
            continue
        extra = make_mesh(path + suffix, sub["pts"], sub["counts"], sub["idx"], double_sided=True)
        bind(extra, mat)
        UsdPhysics.CollisionAPI.Apply(extra.GetPrim())
        UsdPhysics.MeshCollisionAPI.Apply(extra.GetPrim()).CreateApproximationAttr("none")
    ropes = make_mesh(path + "_ropes", rope_store["pts"], rope_store["counts"], rope_store["idx"], double_sided=True)
    bind(ropes, M["rope"])


for row in range(N_ROWS):
    for col in range(N_COLS):
        build_panel(row, col)

# bottom net (flat diamond grid clipped to circle)
bottom = {"pts": [], "counts": [], "idx": []}
up = np.array([0.0, 0.0, 1.0])
sp = 0.25
for dvec in (np.array([1.0, 1.0]) / math.sqrt(2), np.array([1.0, -1.0]) / math.sqrt(2)):
    nvec = np.array([-dvec[1], dvec[0]])
    for off in np.arange(-CAGE_R + sp / 2, CAGE_R, sp):
        half = math.sqrt(max(CAGE_R ** 2 - off ** 2, 0.0))
        n = max(1, math.ceil(2 * half / 0.4))
        for s in range(n):
            t0, t1 = -half + 2 * half * s / n, -half + 2 * half * (s + 1) / n
            p0, p1 = nvec * off + dvec * t0, nvec * off + dvec * t1
            add_ribbon(bottom, np.array([*p0, -CAGE_DEPTH]), np.array([*p1, -CAGE_DEPTH]), up, TWINE_W)
bm = make_mesh("/World/Cage/Net/panel_bottom", bottom["pts"], bottom["counts"], bottom["idx"], double_sided=True)
bind(bm, M["net"])
UsdPhysics.CollisionAPI.Apply(bm.GetPrim())
UsdPhysics.MeshCollisionAPI.Apply(bm.GetPrim()).CreateApproximationAttr("none")

# collar, handrail, stanchions, sinker ring
torus("/World/Cage/collar_inner", CAGE_R, 0.22, 0.15, M["hdpe"])
torus("/World/Cage/collar_outer", CAGE_R + 0.7, 0.22, 0.15, M["hdpe"])
torus("/World/Cage/handrail", CAGE_R + 0.35, 0.05, 1.1, M["hdpe"])
torus("/World/Cage/sinker_ring", CAGE_R, 0.12, -CAGE_DEPTH, M["steel"])
for i in range(24):
    a = 2 * math.pi * i / 24
    st = UsdGeom.Cylinder.Define(stage, f"/World/Cage/Stanchions/s_{i:02d}")
    st.CreateRadiusAttr(0.045)
    st.CreateHeightAttr(0.95)
    st.CreateAxisAttr("Z")
    set_xform(st, ((CAGE_R + 0.35) * math.cos(a), (CAGE_R + 0.35) * math.sin(a), 0.62))
    bind(st, M["hdpe"])

# ----------------------------------------------------------------------------- fish
fish = []
if not args.no_fish:
    for i in range(25 if args.lite else (160 if args.hq else 80)):
        root = UsdGeom.Xform.Define(stage, f"/World/Fish/f_{i:03d}")
        body = UsdGeom.Sphere.Define(stage, f"/World/Fish/f_{i:03d}/body")
        body.CreateRadiusAttr(1.0)
        sz = rng.uniform(0.8, 1.2)
        set_xform(body, s=(0.24 * sz, 0.05 * sz, 0.075 * sz))
        tail = UsdGeom.Cone.Define(stage, f"/World/Fish/f_{i:03d}/tail")
        tail.CreateRadiusAttr(0.06 * sz)
        tail.CreateHeightAttr(0.1 * sz)
        tail.CreateAxisAttr("X")
        set_xform(tail, t=(-0.27 * sz, 0.0, 0.0), s=(1, 0.3, 1))
        bind(body, M["fish"])
        bind(tail, M["fish"])
        x = UsdGeom.Xformable(root.GetPrim())
        fish.append({
            "t": x.AddTranslateOp(), "r": x.AddRotateZOp(),
            "rad": rng.uniform(1.5, 4.8), "z": rng.uniform(-6.8, -1.0),
            "w": rng.uniform(0.12, 0.28), "ph": rng.uniform(0, 2 * math.pi),
        })


def update_fish(t):
    for f in fish:
        th = f["ph"] + f["w"] * t
        z = f["z"] + 0.25 * math.sin(0.6 * t + f["ph"])
        f["t"].Set(Gf.Vec3d(f["rad"] * math.cos(th), f["rad"] * math.sin(th), z))
        f["r"].Set(math.degrees(th + math.pi / 2))   # long axis +X -> tangent to CCW circle


# ----------------------------------------------------------------------------- vehicles
LED_EMISSIVE = []
def build_auv(k, pos, yaw):
    root = f"/World/auv_{k}"
    xf = UsdGeom.Xform.Define(stage, root)
    x = UsdGeom.Xformable(xf.GetPrim())
    x.ClearXformOpOrder()
    x.AddTranslateOp().Set(Gf.Vec3d(*map(float, pos)))
    x.AddOrientOp().Set(Gf.Quatf(math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)))
    UsdPhysics.RigidBodyAPI.Apply(xf.GetPrim())
    UsdPhysics.MassAPI.Apply(xf.GetPrim()).CreateMassAttr(MASS)

    hull = UsdGeom.Cube.Define(stage, root + "/hull")
    hull.CreateSizeAttr(1.0)
    set_xform(hull, s=(0.45, 0.34, 0.25))
    UsdPhysics.CollisionAPI.Apply(hull.GetPrim())
    bind(hull, M["auv"])
    top = UsdGeom.Cube.Define(stage, root + "/float")
    top.CreateSizeAttr(1.0)
    set_xform(top, (0, 0, 0.16), s=(0.40, 0.30, 0.08))
    bind(top, M["auv_top"])
    for j, (tx, ty, tz, ax) in enumerate([(-0.2, 0.2, 0, "X"), (-0.2, -0.2, 0, "X"), (0.2, 0.2, 0, "X"),
                                          (0.2, -0.2, 0, "X"), (0, 0.22, 0.05, "Z"), (0, -0.22, 0.05, "Z")]):
        th = UsdGeom.Cylinder.Define(stage, f"{root}/thruster_{j}")
        th.CreateRadiusAttr(0.05)
        th.CreateHeightAttr(0.12)
        th.CreateAxisAttr(ax)
        set_xform(th, (tx, ty, tz))
        bind(th, M["thruster"])
    led = UsdGeom.Sphere.Define(stage, root + "/led")
    led.CreateRadiusAttr(0.025)
    set_xform(led, (-0.2, 0, 0.21))
    led_mat = make_mat(f"led_{k}", (0.1, 0.8, 1.0), emissive=(0.2, 2.0, 3.0))
    LED_EMISSIVE.append(UsdShade.Shader.Get(stage, f"/World/Looks/led_{k}/Shader").GetInput("emissiveColor"))
    bind(led, led_mat)

    if args.auv_usd:
        # hide the procedural body (the hull stays as an invisible collider)
        for name in ["hull", "float", "led"] + [f"thruster_{j}" for j in range(6)]:
            UsdGeom.Imageable(stage.GetPrimAtPath(f"{root}/{name}")).MakeInvisible()
        model = UsdGeom.Xform.Define(stage, root + "/model")
        set_xform(model, args.auv_offset, r=args.auv_rpy, s=[args.auv_scale] * 3)
        model.GetPrim().GetReferences().AddReference(os.path.abspath(args.auv_usd))
        # strip the asset's own physics so it rides on our rigid body
        for p in Usd.PrimRange(model.GetPrim()):
            for api in (UsdPhysics.RigidBodyAPI, UsdPhysics.MassAPI, UsdPhysics.CollisionAPI,
                        UsdPhysics.ArticulationRootAPI):
                if p.HasAPI(api):
                    p.RemoveAPI(api)
            if p.IsA(UsdPhysics.Joint):
                p.SetActive(False)

    # camera looks along body +X (USD cameras look down local -Z, +Y up)
    cam = UsdGeom.Camera.Define(stage, root + "/cam")
    set_xform(cam, (0.24, 0, 0.02), r=(90, 0, -90))
    cam.CreateFocalLengthAttr(FOCAL)
    cam.CreateHorizontalApertureAttr(H_APERTURE)
    cam.CreateVerticalApertureAttr(V_APERTURE)
    cam.CreateClippingRangeAttr(Gf.Vec2f(0.05, 300.0))
    for side in (-1, 1):
        lamp = UsdLux.SphereLight.Define(stage, f"{root}/lamp_{'l' if side < 0 else 'r'}")
        lamp.CreateRadiusAttr(0.05)
        lamp.CreateIntensityAttr(LAMP_INTENSITY)
        lamp.CreateColorAttr(Gf.Vec3f(1.0, 0.97, 0.9))
        shp = UsdLux.ShapingAPI.Apply(lamp.GetPrim())
        shp.CreateShapingConeAngleAttr(35.0)
        shp.CreateShapingConeSoftnessAttr(0.4)
        set_xform(lamp, (0.24, side * 0.13, -0.05), r=(90, 0, -90))
    return root + "/cam"


# ----------------------------------------------------------------------------- coverage plan
hfov = 2 * math.atan(H_APERTURE / (2 * FOCAL))
vfov = 2 * math.atan(V_APERTURE / (2 * FOCAL))
SECTOR = 2 * math.pi / N_AUV
CENTRE_R = max(0.05, args.centre_radius)   # on the axis exactly, the standoff would equal the pen radius
# In centre survey the vehicle sits on a small circle and looks outward, so the net is between
# CAGE_R - CENTRE_R (straight ahead) and a little more at the edges of its sweep. Taking the near
# value keeps the footprint estimate conservative.
VIEW_DIST = (CAGE_R - CENTRE_R) if args.survey == "centre" else STANDOFF
FOOT_W = 2 * VIEW_DIST * math.tan(hfov / 2)   # footprint on net [m]
FOOT_H = 2 * VIEW_DIST * math.tan(vfov / 2)
R_PATH = CAGE_R - STANDOFF                     # orbit survey only

if args.full_coverage:
    z_top, z_bot = -max(0.6, FOOT_H / 2), -CAGE_DEPTH + FOOT_H / 2
    n_bands = max(1, math.ceil((z_top - z_bot) / (FOOT_H * (1 - OVERLAP))) + 1)
else:
    z_top, z_bot, n_bands = -1.2, -CAGE_DEPTH + 1.2, max(1, args.bands)
BANDS = np.linspace(z_top, z_bot, n_bands) if n_bands > 1 else np.array([z_top])
N_PER_BAND = max(1, math.ceil(SECTOR * CAGE_R / (FOOT_W * (1 - OVERLAP))))


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def plan(k):
    """Waypoints for vehicle k.

    centre survey: hold one point per depth band near the pen axis and yaw across the sector.
    The vehicle barely translates, so a whole band is a rotation rather than a lap of the net.
    That is the far, cheap first pass: the station is the same, only the heading changes.

    orbit survey: the original lap along the net at --standoff, which is what a re-inspection
    of a flagged zone should fly.
    """
    wps = []
    th0, dth = k * SECTOR, SECTOR / N_PER_BAND
    mid = th0 + SECTOR / 2
    for b, z in enumerate(BANDS):
        cols = range(N_PER_BAND) if b % 2 == 0 else reversed(range(N_PER_BAND))
        for i in cols:
            th = th0 + (i + 0.5) * dth
            if args.survey == "centre":
                # One station per band on the sector midline; only the heading changes shot to shot.
                # The station is off the axis, so pointing the camera radially (yaw = th) would look
                # up to ~9 deg away from th at the sector edges and label the photo with the wrong
                # cell. plan_mode.waypoint aims the camera at the net point at th and records the
                # true distance (look_dist), which label() uses for the ground-truth footprint.
                wps.append(pm.waypoint(th, mid, -z / CAGE_DEPTH, CAGE_R - CENTRE_R, CAGE_R, CAGE_DEPTH, band=b))
            else:
                pos = np.array([R_PATH * math.cos(th), R_PATH * math.sin(th), z])
                wps.append({"pos": pos, "yaw": th, "theta": th, "z": float(z), "band": b})
    return wps


def ui_cell(theta, z):
    """Index of this view on the operator UI's cell grid: row * UI_SECTORS + col.

    Row 0 is the surface band and col 0 starts at 0 deg, matching cellRow/cellCol in
    web/src/data/model.ts. Depth is taken as a fraction of CAGE_DEPTH, so a demo-sized pen
    addresses the same cells as a full-size one.
    """
    col = int((theta % (2 * math.pi)) // (2 * math.pi / UI_SECTORS))
    row = int(min(UI_WALL_ROWS - 1, max(0.0, -z) / CAGE_DEPTH * UI_WALL_ROWS))
    return row * UI_SECTORS + col


def label(theta, z, dist=STANDOFF):
    """Ground truth for a camera `dist` m from the net, looking at (theta, z).

    The footprint shrinks with the distance, so a close-up sees only the defects right in front of it.
    """
    foot_w, foot_h = 2 * dist * math.tan(hfov / 2), 2 * dist * math.tan(vfov / 2)
    col = int((theta % (2 * math.pi)) // DTH_PANEL)
    row = int(min(N_ROWS - 1, max(0.0, -z) // PANEL_H))
    # `cell` is required by the decision layer's capture contract (contracts/capture.schema.json).
    holes = [{"panel": f"r{r}_c{c:02d}", "cell": ui_cell(hu / CAGE_R, hv), "theta": hu / CAGE_R, "z": hv,
              "radius": hr}
             for (r, c, hu, hv, hr) in HOLES
             if abs(wrap(hu / CAGE_R - theta)) * CAGE_R < foot_w / 2 and abs(hv - z) < foot_h / 2]
    # How much of what this camera sees is affected, sampled over the footprint. The classifier
    # is scored against these, so they are fractions rather than a panel-wide yes/no.
    uc = theta * CAGE_R
    pts = [((uc + (i / 3.0 - 0.5) * foot_w) % U_MAX, z + (j / 3.0 - 0.5) * foot_h)
           for i in range(4) for j in range(4)]
    foul_frac = sum(1 for (pu, pv) in pts if foul_at(pu, pv) > 0.12) / len(pts)
    thin_frac = sum(1 for (pu, pv) in pts if thin_at(pu, pv) > 0.25) / len(pts)
    return {"panel": f"r{row}_c{col:02d}", "cell": ui_cell(theta, z),
            "fouled": foul_frac > 0.05, "fouling_frac": round(foul_frac, 3),
            "thinning_frac": round(thin_frac, 3), "holes_in_view": holes}


cam_paths, plans, homes = [], [], []
for k in range(N_AUV):
    mid = (k + 0.5) * SECTOR
    home_r = CENTRE_R if args.survey == "centre" else 3.0
    home = np.array([home_r * math.cos(mid), home_r * math.sin(mid), -1.5])
    homes.append(home)
    cam_paths.append(build_auv(k, home, mid))
    plans.append(plan(k))

OBSTACLES = np.zeros((0, 3))     # (x, y, r) vertical ropes / hoses hanging through the pen


def make_obstacles(n, seed=3):
    """Placeholder obstacles, placed where they force avoidance:
    1-6:  on each sector's inspection path (mid) and across each home -> first-shot transit
    7-12: two more per sector just beside the inspection path (1/4 and 3/4 of the sector)
    13+:  random inside the pen (kept clear of the start positions and of each other)."""
    orng = np.random.default_rng(seed)
    pick_r = lambda: float(orng.choice([0.08, 0.12, 0.12, 0.2]))   # thin rope ... feed hose
    paths, transits = [], []
    for k in range(N_AUV):
        a = (k + 0.5) * SECTOR
        paths.append(("path", (R_PATH * math.cos(a), R_PATH * math.sin(a))))
        start, first = np.asarray(homes[k][:2], float), np.asarray(plans[k][0]["pos"][:2], float)
        # A transit rope goes halfway between the start and the first photo spot. In the centre
        # survey the start IS the photo spot (the ROV only turns), so halfway would be on top of the
        # station: every shot gets dropped as blocked and the ROV starts inside the rope. No transit
        # there means no transit rope; the slot goes to a random rope kept clear of the stations.
        if np.linalg.norm(first - start) > 1.0:
            mid_xy = (start + first) / 2
            transits.append(("transit", (mid_xy[0], mid_xy[1])))
    if len(transits) == N_AUV == 3:
        tiered = [paths[0], transits[1], paths[2], transits[0], paths[1], transits[2]]   # as before
    else:
        tiered = paths + transits
    for frac, dr in ((0.25, -0.45), (0.75, +0.45)):      # just beside the path: forces a swerve,
        for k in range(N_AUV):                              # costs at most one photo per pass
            a = (k + frac) * SECTOR
            tiered.append(("path", ((R_PATH + dr) * math.cos(a), (R_PATH + dr) * math.sin(a))))
    out = [(x, y, pick_r(), kind) for kind, (x, y) in tiered[:n]]
    tries = 0
    while len(out) < n and tries < 2000:
        tries += 1
        rr, aa = orng.uniform(1.2, 5.0), orng.uniform(0, 2 * math.pi)
        x, y = rr * math.cos(aa), rr * math.sin(aa)
        if all(math.hypot(x - h[0], y - h[1]) > 1.6 for h in homes) and \
           all(math.hypot(x - o[0], y - o[1]) > 1.4 for o in out):
            out.append((x, y, pick_r(), "random"))
    return out


if NAV and args.obstacles > 0:
    chosen = make_obstacles(args.obstacles)
    OBSTACLES = np.array([(x, y, r) for (x, y, r, _) in chosen])
    hose_mat = make_mat("hose", (0.12, 0.13, 0.14), rough=0.5)
    for i, (x, y, r) in enumerate(OBSTACLES):
        rope = UsdGeom.Cylinder.Define(stage, f"/World/Obstacles/rope_{i}")
        rope.CreateRadiusAttr(float(r))
        rope.CreateHeightAttr(CAGE_DEPTH + 0.5)
        rope.CreateAxisAttr("Z")
        set_xform(rope, (x, y, -CAGE_DEPTH / 2 + 0.25))
        bind(rope, hose_mat if r >= 0.18 else M["rope"])
        UsdPhysics.CollisionAPI.Apply(rope.GetPrim())
        buoy = UsdGeom.Sphere.Define(stage, f"/World/Obstacles/buoy_{i}")
        buoy.CreateRadiusAttr(0.25)
        set_xform(buoy, (x, y, 0.2))
        bind(buoy, M["auv"])
    keep_out = NCFG["inflation"] + 0.2       # only drop photo spots the HOCBF won't let the ROV reach
    for k in range(N_AUV):
        if args.plan:                        # plan waypoints are checked below, with their own margins
            break
        n0 = len(plans[k])
        plans[k] = [w for w in plans[k]
                    if all(math.hypot(w["pos"][0] - x, w["pos"][1] - y) > r + keep_out for x, y, r in OBSTACLES)]
        if len(plans[k]) < n0:
            print(f"[nav] auv_{k}: skipped {n0 - len(plans[k])} shot(s) blocked by a rope")
    kinds = [c[3] for c in chosen]
    print(f"[nav] {len(chosen)} obstacles: {kinds.count('path')} on inspection paths, "
          f"{kinds.count('transit')} across transits, {kinds.count('random')} random")

# ----------------------------------------------------------------------------- plan mode
# The ropes above were placed from the coverage sweep, so a plan run has the same scene as the
# sweep that produced the plan. Only now are the robots' waypoints swapped for the plan's.
PLAN, PLAN_STATUS = None, {}
if args.plan:
    import plan_mode as pm
    PLAN = pm.load_plan(args.plan, UI_SECTORS, UI_WALL_ROWS)
    plans = pm.build_waypoints(PLAN, N_AUV, CAGE_R, CAGE_DEPTH, coverage_standoff=STANDOFF,
                               base_margin=NCFG["inflation"] if NAV else 0.6,
                               revisits=args.plan_revisits, coverage_limit=args.plan_coverage)
    PLAN_STATUS = {t["target_id"]: {"cell": t["cell"], "robots": t["robots"], "photos": {}, "timeouts": 0,
                                    "blocked": []} for t in PLAN["targets"]}
    for k in range(N_AUV):
        plans[k], blocked = pm.drop_blocked(plans[k], OBSTACLES)
        for w in blocked:                    # reported, so the decision layer can re-plan the target
            if w["target_id"]:
                PLAN_STATUS[w["target_id"]]["blocked"].append({"auv": k, "viewpoint": w["viewpoint"]})
                print(f"[plan] auv_{k}: target {w['target_id']} viewpoint {w['viewpoint']} blocked by a rope")
    print(f"[plan] {PLAN['plan_id']}: {len(PLAN['targets'])} targets, "
          f"waypoints per AUV {[len(p) for p in plans]} (revisits {args.plan_revisits}, coverage {args.plan_coverage})")

diver_ops = None
if NAV and args.diver:
    dv = UsdGeom.Xform.Define(stage, "/World/Diver")
    body = UsdGeom.Capsule.Define(stage, "/World/Diver/body")
    body.CreateRadiusAttr(0.2)
    body.CreateHeightAttr(1.1)
    body.CreateAxisAttr("X")
    bind(body, make_mat("wetsuit", (0.03, 0.03, 0.04), rough=0.6))
    tank = UsdGeom.Cylinder.Define(stage, "/World/Diver/tank")
    tank.CreateRadiusAttr(0.09)
    tank.CreateHeightAttr(0.6)
    tank.CreateAxisAttr("X")
    set_xform(tank, (0.05, 0, 0.22))
    bind(tank, M["auv"])
    for side in (-1, 1):
        fin = UsdGeom.Cube.Define(stage, f"/World/Diver/fin_{'l' if side < 0 else 'r'}")
        fin.CreateSizeAttr(1.0)
        set_xform(fin, (-0.85, side * 0.1, 0), s=(0.35, 0.12, 0.02))
        bind(fin, M["thruster"])
    xd = UsdGeom.Xformable(dv.GetPrim())
    diver_ops = (xd.AddTranslateOp(), xd.AddRotateZOp())
    print("[nav] diver enabled (moving obstacle, HOCBF uses its velocity)")

# ----------------------------------------------------------------------------- demo camera
demo_cam = UsdGeom.Camera.Define(stage, "/World/DemoCam")
demo_cam.CreateFocalLengthAttr(14.0)
demo_cam.CreateClippingRangeAttr(Gf.Vec2f(0.05, 500.0))
demo_op = UsdGeom.Xformable(demo_cam.GetPrim()).AddTransformOp()


DEMO_FOCAL, DEMO_TARGET = 14.0, (0.0, 0.0, -4.5)
demo_eye = [0.0, 0.0, 0.0]


def update_demo_cam(t):
    a = 0.05 * t
    eye = Gf.Vec3d(14.0 * math.cos(a), 14.0 * math.sin(a), -3.5 + 2.0 * math.sin(0.15 * t))
    m = Gf.Matrix4d()
    m.SetLookAt(eye, Gf.Vec3d(*DEMO_TARGET), Gf.Vec3d(0, 0, 1))
    demo_op.Set(m.GetInverse())
    demo_eye[:] = [eye[0], eye[1], eye[2]]


# cutaway / cross-section camera: slow counter-orbit; its NEAR CLIP PLANE slices off the
# near wall of the net so the inside of the pen (ROVs at work, ropes) is visible.
SECTION_DIST, SECTION_FOCAL, SECTION_TARGET = 17.0, 18.0, (0.0, 0.0, -4.0)
SECTION_NEAR = SECTION_DIST - CAGE_R * math.cos(math.radians(32))     # ~10.2 m: cuts the net, keeps ROVs (r <= 6.5)
section_cam = UsdGeom.Camera.Define(stage, "/World/SectionCam")
section_cam.CreateFocalLengthAttr(SECTION_FOCAL)
section_cam.CreateClippingRangeAttr(Gf.Vec2f(float(SECTION_NEAR), 500.0))
section_op = UsdGeom.Xformable(section_cam.GetPrim()).AddTransformOp()
section_eye = [0.0, 0.0, 0.0]


def update_section_cam(t):
    a = 0.9 - 0.03 * t
    eye = Gf.Vec3d(SECTION_DIST * math.cos(a), SECTION_DIST * math.sin(a), -2.6)
    m = Gf.Matrix4d()
    m.SetLookAt(eye, Gf.Vec3d(*SECTION_TARGET), Gf.Vec3d(0, 0, 1))
    section_op.Set(m.GetInverse())
    section_eye[:] = [eye[0], eye[1], eye[2]]


update_demo_cam(0.0)
update_section_cam(0.0)
if not args.headless:
    from omni.kit.viewport.utility import get_active_viewport
    vp = get_active_viewport()
    vp.camera_path = {"orbit": "/World/DemoCam", "section": "/World/SectionCam"}.get(
        args.view, cam_paths[int(args.view[-1])] if args.view.startswith("auv") else "/World/DemoCam")

# ----------------------------------------------------------------------------- preview / save
if args.save_usd:
    out_usd = os.path.abspath(args.save_usd)
    stage.GetRootLayer().Export(out_usd)
    print(f"[demo] scene saved to {out_usd}  ->  open it in Isaac Sim with File > Open")
    simulation_app.close()
    raise SystemExit(0)
if args.preview:
    print("[demo] preview mode: scene only, no physics. Orbit with right-drag / scroll. Close the window to exit.")
    while simulation_app.is_running():
        simulation_app.update()
    simulation_app.close()
    raise SystemExit(0)

# ----------------------------------------------------------------------------- capture
annots, uw_cams, rps = [], [], []


def set_cam_rendering(k, on):
    """Vehicle cameras only render while a photo is being taken (saves most of the GPU load)."""
    if k < len(rps) and rps[k] is not None:
        try:
            rps[k].hydra_texture.set_updates_enabled(on)
        except Exception:
            pass


for k, p in enumerate(cam_paths):
    if UW_Camera is not None:
        uw_cams.append(UW_Camera(prim_path=p, name=f"uw_cam_{k}", resolution=RES))
        annots.append(None)
    else:
        rp = rep.create.render_product(p, RES)
        ann = rep.AnnotatorRegistry.get_annotator("rgb")
        ann.attach([rp])
        annots.append(ann)
        rps.append(rp)
        set_cam_rendering(k, False)
os.makedirs(args.out, exist_ok=True)
for k in range(N_AUV):
    os.makedirs(os.path.join(args.out, f"auv_{k}"), exist_ok=True)
meta_file = open(os.path.join(args.out, "captures.jsonl"), "w")
with open(os.path.join(args.out, "ground_truth.json"), "w") as f:
    json.dump({"run_id": RUN_ID, "defect_seed": args.defect_seed,
               "grid": {"ui_sectors": UI_SECTORS, "ui_wall_rows": UI_WALL_ROWS,
                        "cage_radius_m": CAGE_R, "cage_depth_m": CAGE_DEPTH},
               "holes": [{"panel": f"r{r}_c{c:02d}", "cell": ui_cell(hu / CAGE_R, hv),
                          "theta": hu / CAGE_R, "z": hv, "radius": hr}
                         for (r, c, hu, hv, hr) in HOLES],
               "thin_patches": [{"cell": ui_cell(pu / CAGE_R, pv), "theta": pu / CAGE_R,
                                 "z": pv, "radius": pr} for (pu, pv, pr) in THIN],
               "foul_patches": [{"cell": ui_cell(pu / CAGE_R, pv), "theta": pu / CAGE_R,
                                 "z": pv, "radius": pr} for (pu, pv, pr) in FOUL],
               "thin_cells": sorted({ui_cell(pu / CAGE_R, pv) for (pu, pv, _) in THIN}),
               "fouled_cells": sorted({ui_cell(pu / CAGE_R, pv) for (pu, pv, _) in FOUL}),
               "defect_area_fraction": round(DEFECT_FRAC, 4)}, f, indent=2)

SQ = None
if NAV and args.perception:
    from omni.physx import get_physx_scene_query_interface
    SQ = get_physx_scene_query_interface()
    print(f"[nav] perception mode: {SONAR_N}-beam sonar via PhysX sphere-casts, no map / no analytic net barrier")


def _xy(vec):
    try:
        return float(vec[0]), float(vec[1])
    except TypeError:
        return float(vec.x), float(vec.y)


def sonar_points(p3):
    """Horizontal sonar ring: sphere-casts from just outside the hull; returns hit points (k,3) [x,y,0].
    ROVs are ignored here (they come from tracking with their velocity), so only the static world remains."""
    pts = []
    for i in range(SONAR_N):
        a = 2 * math.pi * i / SONAR_N
        d = (math.cos(a), math.sin(a), 0.0)
        o = (p3[0] + 0.45 * d[0], p3[1] + 0.45 * d[1], p3[2])
        hit = SQ.sweep_sphere_closest(SONAR_SPHERE, carb.Float3(*o), carb.Float3(*d), float(NCFG["detect_radius"]))
        if hit and hit.get("hit") and not str(hit.get("collision", "")).startswith("/World/auv_"):
            x, y = _xy(hit["position"])
            pts.append((x, y, 0.0))
    return np.array(pts, float).reshape(-1, 3)


DRAW = None
if NAV and not args.no_viz and not args.headless:
    try:
        from isaacsim.core.utils.extensions import enable_extension
        enable_extension("isaacsim.util.debug_draw")
        simulation_app.update()
        from isaacsim.util.debug_draw import _debug_draw
        DRAW = _debug_draw.acquire_debug_draw_interface()
    except Exception as exc:
        print(f"[nav] debug draw unavailable ({exc}); continuing without arrows")

# ----------------------------------------------------------------------------- physics
auvs = RigidPrim(prim_paths_expr="/World/auv_.*", name="auvs")
world.scene.add(auvs)

state = [{"wp": 0, "settle": 0, "t_wp": 0.0, "pending": False, "timeout": False, "done": False,
          "shot": 0, "wait": False, "hold": None, "lock": None} for _ in range(N_AUV)]
LOCKS = {}   # plan target_id -> the AUV on it now; robots sharing a target take turns


def enter_waypoint(k, t, pos_k):
    """AUV k moves on to its current waypoint: it hands over the target it leaves, then takes the
    lock of the target it goes to, or holds where it is until the other robot has finished there."""
    if PLAN is None:                          # the coverage sweep has no shared targets
        return
    s = state[k]
    tid = None if s["done"] else plans[k][s["wp"]].get("target_id")
    go, s["lock"] = pm.take_turn(LOCKS, k, s["lock"], tid)
    if go:
        if s["wait"]:
            print(f"[plan] auv_{k}: target {tid} is free, going in")
        s.update(wait=False, t_wp=t)
    elif not s["wait"]:
        s.update(wait=True, hold=np.asarray(pos_k, dtype=float).copy())
        print(f"[plan] auv_{k}: waiting for auv_{LOCKS[tid]} to finish target {tid}")
prev_q = [None] * N_AUV
sim_t = [0.0]
for k in range(N_AUV):
    if not plans[k]:
        state[k]["done"] = True
nav = [{"tick": 0, "u": np.zeros(2), "interv": False, "n_interv": 0, "n_steps": 0, "min_clr": np.inf,
        "contacts": 0, "in_contact": False, "u_nom": np.zeros(2), "u_safe": np.zeros(2),
        "sonar": np.zeros((0, 3))} for _ in range(N_AUV)]
POLICY_EVERY = max(1, int(round(NCFG["dt"] * 60))) if NAV else 1   # policy at 10 Hz, filter at 60 Hz


def qmul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2])


def rotm(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def target(k):
    s = state[k]
    if s["done"]:
        return homes[k], (k + 0.5) * SECTOR
    wp = plans[k][s["wp"]]
    if s["wait"]:
        return s["hold"], wp["yaw"]
    return wp["pos"], wp["yaw"]


def physics_step(dt):
    sim_t[0] += dt
    pos, quat = auvs.get_world_poses()
    vel = auvs.get_linear_velocities()
    F = np.zeros((N_AUV, 3))
    T = np.zeros((N_AUV, 3))
    for k in range(N_AUV):
        q = np.asarray(quat[k], dtype=float)
        # angular velocity from quaternion difference (unit-agnostic)
        if prev_q[k] is None:
            omega = np.zeros(3)
        else:
            dq = qmul(q, prev_q[k] * np.array([1, -1, -1, -1]))
            if dq[0] < 0:
                dq = -dq
            omega = 2.0 * dq[1:] / dt
        prev_q[k] = q
        R = rotm(q)
        v = np.asarray(vel[k], dtype=float)

        # hydrodynamics: buoyancy + restoring moment + drag relative to current
        Fb = np.array([0.0, 0.0, MASS * G * BUOYANCY_RATIO])
        tau = np.cross(R @ np.array([0.0, 0.0, COB_HEIGHT]), Fb) - ANG_DAMP * omega
        vrel = v - CURRENT
        Fd = -(LIN_DAMP + QUAD_DAMP * np.linalg.norm(vrel)) * vrel

        # PD position + yaw control
        p_ref, yaw_ref = target(k)
        e = p_ref - np.asarray(pos[k], dtype=float)
        Fc = KP * e - KD * v
        n = np.linalg.norm(Fc)
        if n > F_MAX:
            Fc *= F_MAX / n

        if NAV:
            # planar navigation: (learned policy | PD) -> HOCBF filter -> acceleration command.
            # Horizontal hydrodynamic drag is cancelled so the vehicle follows exactly the point-mass
            # model the policy and the HOCBF were designed on (v_dot = a_max*u - drag*v, p_dot = v + current).
            ns = nav[k]
            p2 = np.asarray(pos[k], float)[:2]
            v2 = v[:2] - CURRENT[:2]                                  # velocity relative to water
            g = p_ref[:2]
            # dynamic agents (other ROVs, diver) with velocity -> moving-obstacle HOCBF
            dyn = [(pos[j][0], pos[j][1], NCFG["vehicle_radius"], vel[j][0], vel[j][1])
                   for j in range(N_AUV) if j != k]
            if diver_ops is not None:
                dxy, dvel = diver_state(sim_t[0])
                dyn.append((dxy[0], dxy[1], DIVER_R, dvel[0], dvel[1]))
            dyn = np.array(dyn, float).reshape(-1, 5)
            if SQ is not None:                                        # static world from sonar
                if ns["tick"] % SONAR_EVERY == 0:
                    ns["sonar"] = sonar_points(np.asarray(pos[k], float))
                static = rows5(ns["sonar"])
            else:                                                     # static world from the map
                static = rows5(OBSTACLES)
            circles = np.vstack([static, dyn])
            truth = np.vstack([rows5(OBSTACLES), dyn])               # for logging true clearance
            far = np.linalg.norm(g - p2) > NAV_SWITCH
            if POLICY is not None and far:
                if ns["tick"] % POLICY_EVERY == 0:
                    ns["u"] = POLICY(sn.build_obs(p2, v2, g, truth, CAGE_R, NCFG["n_rays"], NCFG["ray_max"]))
                u_nom = ns["u"]
            else:
                a_des = HOVER_KP * (g - p2) - HOVER_KD * v[:2]
                u_nom = np.clip((a_des + NCFG["drag"] * v2) / NCFG["a_max"], -1, 1)
            ns["tick"] += 1
            if SAFETY is not None:
                if PLAN is not None:                                  # this target's margin, raised only as the ROV clears it
                    sk = state[k]
                    want = NCFG["inflation"] if sk["done"] or sk["wait"] else \
                        plans[k][sk["wp"]].get("margin", NCFG["inflation"])
                    SAFETY[k].inflation = pm.ramp_margin(SAFETY[k].inflation, want,
                                                         sn.clearance(p2, circles, CAGE_R, 0.0))
                u, info = SAFETY[k].filter(p2, v2, u_nom, circles, escape=ESCAPE)
                ns["interv"] = info["intervened"]
            else:
                u = u_nom
            ns["u_nom"], ns["u_safe"] = np.asarray(u_nom, float), np.asarray(u, float)
            a_h = NCFG["a_max"] * u - NCFG["drag"] * v2
            Fc[0] = MASS * a_h[0] - Fd[0]
            Fc[1] = MASS * a_h[1] - Fd[1]
            Fc[2] = float(np.clip(KP * e[2] - KD * v[2], -F_MAX, F_MAX))
            if far and np.linalg.norm(g - p2) > 1.5:                   # face the direction of travel
                yaw_ref = math.atan2(g[1] - p2[1], g[0] - p2[0])
            clr = sn.clearance(p2, truth, CAGE_R, NCFG["vehicle_radius"])
            ns["min_clr"] = min(ns["min_clr"], clr)
            ns["clr"] = clr
            ns["n_steps"] += 1
            ns["n_interv"] += int(ns["interv"])
            if clr < 0 and not ns["in_contact"]:
                ns["contacts"] += 1
            ns["in_contact"] = clr < 0
        yaw = math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2))
        ey = wrap(yaw_ref - yaw)
        tz = float(np.clip(KP_YAW * ey - KD_YAW * omega[2], -TZ_MAX, TZ_MAX))

        F[k] = Fb + Fd + Fc
        T[k] = tau + np.array([0.0, 0.0, tz])

        # waypoint logic
        s = state[k]
        if not s["done"] and not s["pending"] and not s["wait"]:
            ok = np.linalg.norm(e) < SETTLE_POS and abs(ey) < SETTLE_YAW and np.linalg.norm(v) < SETTLE_SPEED
            s["settle"] = s["settle"] + 1 if ok else 0
            if s["settle"] >= SETTLE_FRAMES or sim_t[0] - s["t_wp"] > WP_TIMEOUT:
                s["pending"], s["timeout"] = True, s["settle"] < SETTLE_FRAMES
    auvs.apply_forces_and_torques_at_pos(forces=F, torques=T, is_global=True)


world.add_physics_callback("hydro_and_control", callback_fn=physics_step)

# ----------------------------------------------------------------------------- recording
REC = None
if args.record:
    if args.pathtrace > 0:
        for key, val in {"/rtx/rendermode": "PathTracing", "/rtx/pathtracing/spp": args.pathtrace,
                         "/rtx/pathtracing/totalSpp": args.pathtrace,
                         "/rtx/pathtracing/optixDenoiser/enabled": True}.items():
            settings.set(key, val)
    W, H = (int(v) for v in args.record_res.lower().split("x"))
    from concurrent.futures import ThreadPoolExecutor
    REC = {"dir": args.record, "cams": {}, "frame": 0, "shots": [], "pool": ThreadPoolExecutor(max_workers=6)}
    for name in [c.strip() for c in args.record_cams.split(",") if c.strip()]:
        path = {"demo": "/World/DemoCam", "section": "/World/SectionCam"}.get(name) or cam_paths[int(name[-1])]
        res = (W, H) if name in ("demo", "section") else RES
        rp = rep.create.render_product(path, res)
        ann = rep.AnnotatorRegistry.get_annotator("rgb")
        ann.attach([rp])
        REC["cams"][name] = ann
        os.makedirs(os.path.join(args.record, name), exist_ok=True)
    with open(os.path.join(args.record, "meta.json"), "w") as f:
        json.dump({"views": {"demo": {"focal": DEMO_FOCAL, "h_aperture": 20.955, "target": DEMO_TARGET,
                                      "near": 0.05},
                             "section": {"focal": SECTION_FOCAL, "h_aperture": 20.955, "target": SECTION_TARGET,
                                         "near": SECTION_NEAR}},
                   "demo_res": [W, H], "demo_focal": DEMO_FOCAL, "demo_h_aperture": 20.955,
                   "demo_target": DEMO_TARGET, "cage_r": CAGE_R, "cage_depth": CAGE_DEPTH,
                   "inflation": NCFG["inflation"] if NAV else 0.6, "auv_res": list(RES),
                   "obstacles": OBSTACLES.tolist(), "diver_r": DIVER_R if diver_ops is not None else None,
                   "hocbf": bool(NAV and SAFETY is not None), "nav": NAV,
                   "policy": args.nav_policy, "perception": bool(args.perception),
                   "fps": 60.0 / args.record_every, "cams": list(REC["cams"].keys())}, f, indent=2)
    REC["tel"] = open(os.path.join(args.record, "telemetry.jsonl"), "w")
    print(f"[rec] recording {list(REC['cams'])} to {os.path.abspath(args.record)} at {60 / args.record_every:.0f} fps")


def _save_png(frame, path):
    Image.fromarray(frame).save(path, compress_level=1)          # fast PNG; written off the sim thread


def record_frame(t, pos):
    REC["frame"] += 1
    if REC["frame"] % args.record_every:
        return
    idx = REC["frame"] // args.record_every
    for name, ann in REC["cams"].items():
        data = ann.get_data()
        if data is None or getattr(data, "size", 0) == 0:
            return
        frame = np.array(np.asarray(data)[:, :, :3], copy=True)   # copy: the buffer is reused next frame
        REC["pool"].submit(_save_png, frame, os.path.join(REC["dir"], name, f"{idx:05d}.png"))
    rov = []
    for k in range(N_AUV):
        q = np.asarray(quat[k], float)
        rov.append({"pos": np.round(np.asarray(pos[k], float), 3).tolist(),
                    "yaw": round(math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)), 3),
                    "u_nom": np.round(nav[k]["u_nom"], 3).tolist(), "u_safe": np.round(nav[k]["u_safe"], 3).tolist(),
                    "filter": bool(nav[k]["interv"]), "clr": round(float(nav[k].get("clr", 9.0)), 3),
                    "min_clr": round(float(min(nav[k]["min_clr"], 9.0)), 3), "contacts": nav[k]["contacts"],
                    "shots": counts[k], "done": bool(state[k]["done"])})
    rec = {"i": idx, "t": round(t, 3), "eye": [round(v, 4) for v in demo_eye],
           "eyes": {"demo": [round(v, 4) for v in demo_eye], "section": [round(v, 4) for v in section_eye]},
           "rov": rov, "shot": REC["shots"]}
    if diver_ops is not None:
        dxy, _ = diver_state(t)
        rec["diver"] = [round(float(dxy[0]), 3), round(float(dxy[1]), 3), DIVER_Z]
    REC["tel"].write(json.dumps(rec) + "\n")
    REC["shots"] = []


# ----------------------------------------------------------------------------- run
world.reset()
for cam in uw_cams:
    # UW_param: [backscatter RGB, attenuation RGB, backscatter-attenuation RGB] (see OceanSim docs);
    # greener/murkier values suit a fish farm. Optional: UW_yaml_path="water.yaml"
    cam.initialize(UW_param=np.array([0.0, 0.31, 0.24, 0.05, 0.05, 0.2, 0.05, 0.05, 0.05]),
                   max_range=20.0, viewport=False)
world.play()


def grab(k):
    """Return an HxWx3 uint8 image from vehicle k's camera, or None if not ready."""
    if uw_cams:
        cam = uw_cams[k]
        cam.render()
        frame = getattr(cam, "_uw_frame", None)
        if frame is None:
            return None
        frame = frame.numpy() if hasattr(frame, "numpy") else np.asarray(frame)
    else:
        frame = annots[k].get_data()
        if frame is None or getattr(frame, "size", 0) == 0:
            return None
        frame = np.asarray(frame)
    if frame.size == 0:
        return None
    if frame.dtype != np.uint8:
        frame = np.clip(frame * (255.0 if frame.max() <= 1.0 else 1.0), 0, 255).astype(np.uint8)
    return frame[:, :, :3]
print(f"[demo] footprint {FOOT_W:.2f} x {FOOT_H:.2f} m, {len(BANDS)} bands x {N_PER_BAND} shots per vehicle")
print(f"[demo] ground truth: {len(HOLES)} holes (radii {[round(h[4], 2) for h in HOLES]} m), "
      f"{len(THIN)} thinning patches, {len(FOUL)} fouling patches; "
      f"{DEFECT_FRAC:.1%} of the net wall affected")
counts = [0] * N_AUV
finished_reported = False
finish_t = None
for k in range(N_AUV):
    enter_waypoint(k, 0.0, homes[k])

while simulation_app.is_running():
    world.step(render=True)
    if not world.is_playing():
        continue
    t = sim_t[0]
    if (args.record or args.headless) and finish_t is not None and t - finish_t > 8.0:
        break                                   # headless / recording: stop 8 s after the inspection ends
    update_fish(t)
    update_demo_cam(t)
    update_section_cam(t)
    pos, quat = auvs.get_world_poses()
    if REC is not None:
        record_frame(t, pos)
        if REC["frame"] % 300 == 0:
            print(f"[rec] sim t = {t:6.1f} s, {REC['frame'] // args.record_every} frames recorded, "
                  f"photos so far {sum(counts)}")
    if diver_ops is not None:
        dxy, dvel = diver_state(t)
        diver_ops[0].Set(Gf.Vec3d(float(dxy[0]), float(dxy[1]), DIVER_Z))
        diver_ops[1].Set(math.degrees(math.atan2(dvel[1], dvel[0])))
    if DRAW is not None:
        DRAW.clear_lines()
        S, E, Cl, W = [], [], [], []
        for k in range(N_AUV):
            p3 = np.asarray(pos[k], float)
            for u_vec, col in ((nav[k]["u_nom"], (1.0, 0.85, 0.1, 1.0)),
                               (nav[k]["u_safe"], (1.0, 0.15, 0.1, 1.0) if nav[k]["interv"] else (0.1, 1.0, 0.4, 1.0))):
                tip = p3 + 1.5 * np.array([u_vec[0], u_vec[1], 0.0])
                S.append(tuple(p3 + [0, 0, 0.3]))
                E.append(tuple(tip + [0, 0, 0.3]))
                Cl.append(col)
                W.append(4.0)
            for pt in nav[k]["sonar"]:                               # sonar returns (perception mode)
                S.append((pt[0], pt[1], p3[2] - 0.05))
                E.append((pt[0], pt[1], p3[2] + 0.05))
                Cl.append((0.2, 0.8, 1.0, 1.0))
                W.append(6.0)
        rings = [(x, y, r, z) for (x, y, r) in OBSTACLES for z in BANDS]
        if diver_ops is not None:
            dxy, _ = diver_state(t)
            rings.append((dxy[0], dxy[1], DIVER_R, DIVER_Z))
        for (x, y, r, z) in rings:                                   # safety boundary the HOCBF keeps
            R_s = r + NCFG["inflation"]
            for i in range(24):
                a0, a1 = 2 * math.pi * i / 24, 2 * math.pi * (i + 1) / 24
                S.append((x + R_s * math.cos(a0), y + R_s * math.sin(a0), z))
                E.append((x + R_s * math.cos(a1), y + R_s * math.sin(a1), z))
                Cl.append((1.0, 0.4, 0.1, 0.8))
                W.append(2.0)
        DRAW.draw_lines(S, E, Cl, W)
    if NAV:
        for k in range(N_AUV):
            red = nav[k]["interv"]
            if red != nav[k].get("led_red"):
                LED_EMISSIVE[k].Set(Gf.Vec3f(4.0, 0.2, 0.1) if red else Gf.Vec3f(0.2, 2.0, 3.0))
                nav[k]["led_red"] = red
    for k in range(N_AUV):
        s = state[k]
        if s["wait"]:
            enter_waypoint(k, t, pos[k])
        if not s["pending"]:
            continue
        if not s.get("cam_on"):                      # switch this camera on, give it a few frames
            set_cam_rendering(k, True)
            s["cam_on"], s["cam_wait"] = True, 4
            continue
        if s["cam_wait"] > 0:
            s["cam_wait"] -= 1
            continue
        data = grab(k)
        if data is None:
            continue
        set_cam_rendering(k, False)
        s["cam_on"] = False
        wp = plans[k][s["wp"]]
        # fname keeps forward slashes: it is a relative path recorded in captures.jsonl and
        # read back on any platform. The path we actually write is built with os.path.join,
        # because mixing separators ("...\\auv_1/img.png") is rejected on Windows.
        fname = f"auv_{k}/img_{counts[k]:04d}.png"
        out_png = os.path.join(args.out, f"auv_{k}", f"img_{counts[k]:04d}.png")
        os.makedirs(os.path.dirname(out_png), exist_ok=True)
        Image.fromarray(data).save(out_png)
        lab = label(wp["theta"], wp["z"], wp.get("look_dist", STANDOFF))
        # The heading the photo was really taken with (the plan's yaw if the robot got there), so the
        # image pipeline can put each detection on its own cell (tools/run_vision.py).
        q = np.asarray(quat[k], float)
        yaw_now = math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2))
        rec = {"image": fname, "run_id": RUN_ID, "auv": k, "sim_time": round(t, 3), "band": wp["band"],
               "theta_deg": round(math.degrees(wp["theta"]) % 360, 2), "depth": wp["z"],
               "position": np.round(np.asarray(pos[k], dtype=float), 3).tolist(),
               "yaw_deg": round(math.degrees(yaw_now), 2),
               "look_dist": round(float(wp.get("look_dist", STANDOFF)), 3),
               "timeout": s["timeout"], **lab}
        if PLAN is not None:
            # The plan's cell, not ui_cell(theta): an offset viewpoint can sit over the next cell.
            rec.update(cell=wp["cell"], plan_id=PLAN["plan_id"], viewpoint=wp["viewpoint"], visit=wp["visit"])
            if wp["target_id"]:
                rec["target_id"] = wp["target_id"]       # closes the mission in the decision layer
                st = PLAN_STATUS[wp["target_id"]]
                st["photos"][str(k)] = st["photos"].get(str(k), 0) + 1
                st["timeouts"] += int(s["timeout"])
        meta_file.write(json.dumps(rec) + "\n")
        meta_file.flush()
        tag = " <-- HOLE IN VIEW" if lab["holes_in_view"] else (" (fouled)" if lab["fouled"] else "")
        print(f"[auv_{k}] {fname}  panel {lab['panel']}{tag}")
        counts[k] += 1
        if REC is not None:
            REC["shots"].append(k)
        if s["shot"] + 1 < wp.get("shots", 1):           # more photos from this spot: stay pending
            s["shot"] += 1
            continue
        s.update(wp=s["wp"] + 1, settle=0, t_wp=t, pending=False, shot=0)
        if s["wp"] >= len(plans[k]):
            s["done"] = True
        enter_waypoint(k, t, pos[k])
    if not finished_reported and all(s["done"] for s in state):
        finished_reported = True
        print(f"[demo] inspection complete: {sum(counts)} images in {os.path.abspath(args.out)}")
        finish_t = t
        if PLAN is not None:
            with open(os.path.join(args.out, "plan_status.json"), "w") as f:
                json.dump({"plan_id": PLAN["plan_id"], "run_id": RUN_ID, "targets": PLAN_STATUS}, f, indent=2)
            for tid, st in PLAN_STATUS.items():
                print(f"[plan] {tid} (cell {st['cell']}): photos by AUV {st['photos']}, "
                      f"{st['timeouts']} timed out, {len(st['blocked'])} viewpoint(s) blocked")
        if NAV:
            summary = {f"auv_{k}": {"min_clearance_m": round(float(nav[k]["min_clr"]), 3),
                                    "contacts": nav[k]["contacts"],
                                    "filter_intervention_rate": round(nav[k]["n_interv"] / max(nav[k]["n_steps"], 1), 3)}
                       for k in range(N_AUV)}
            summary["config"] = {"policy": args.nav_policy, "hocbf": SAFETY is not None,
                                 "perception": bool(args.perception), "diver": bool(args.diver),
                                 "obstacles": OBSTACLES.tolist(), "current": CURRENT.tolist()}
            with open(os.path.join(args.out, "nav_summary.json"), "w") as f:
                json.dump(summary, f, indent=2)
            for k in range(N_AUV):
                print(f"[nav] auv_{k}: min clearance {nav[k]['min_clr']:+.2f} m, contacts {nav[k]['contacts']}, "
                      f"filter active {100 * nav[k]['n_interv'] / max(nav[k]['n_steps'], 1):.0f}% of steps")

meta_file.close()
if REC is not None:
    REC["tel"].close()
    print("[rec] finishing frame writes...")
    REC["pool"].shutdown(wait=True)
    print(f"[rec] done: {os.path.abspath(args.record)}  ->  run tools/make_video.py on it")
simulation_app.close()
