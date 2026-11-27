#!/usr/bin/env bash
# Headless cluster run: records the HOCBF demo (filter ON and OFF) and renders the videos.
#
#   ISAACSIM_ROOT=~/isaacsim OUT=~/abyss_out ./scripts/run_cluster.sh
#
# Options (environment variables):
#   ISAACSIM_ROOT  Isaac Sim 5.1 install (folder with python.sh)      default ~/isaacsim
#   OUT            output folder                                      default ~/abyss_out
#   OBST           number of obstacles                                default 12
#   BANDS          depth bands per ROV                                default 2
#   RES            resolution of the overview / cutaway videos        default 1920x1080
#   PATHTRACE      path-traced samples per pixel (0 = real-time RTX)  default 0
#   RUNS           which runs: "hero nocbf" (filter ON / OFF), "plan"  default "hero nocbf"
#   EXTRA          extra flags passed to fishfarm_demo.py             default "--hq"
#   PLAN           plan.json from the decision layer, for RUNS=plan   (required for "plan")
#   PLAN_FLAGS     extra plan-mode flags, e.g. "--plan-revisits 1 --plan-coverage 24"
#
# The closed loop: run "hero" (the sweep), bring run_hero/ back to the decision layer, make a plan,
# copy plan.json here, then RUNS=plan PLAN=~/plan.json with the same OBST, BANDS and EXTRA, so the
# ropes and net defects are where the plan expects them.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ISAACSIM_ROOT="${ISAACSIM_ROOT:-$HOME/isaacsim}"
OUT="${OUT:-$HOME/abyss_out}"
OBST="${OBST:-12}"; BANDS="${BANDS:-2}"; RES="${RES:-1920x1080}"; PATHTRACE="${PATHTRACE:-0}"
RUNS="${RUNS:-hero nocbf}"; EXTRA="${EXTRA:---hq}"; PLAN="${PLAN:-}"; PLAN_FLAGS="${PLAN_FLAGS:-}"
PY="$ISAACSIM_ROOT/python.sh"
[ -x "$PY" ] || { echo "python.sh not found in $ISAACSIM_ROOT (set ISAACSIM_ROOT)"; exit 1; }

# a sourced ROS 2 Humble (python 3.10) environment clashes with Isaac Sim's python 3.11
unset ROS_DISTRO ROS_VERSION AMENT_PREFIX_PATH COLCON_PREFIX_PATH PYTHONPATH LD_LIBRARY_PATH || true
export ACCEPT_EULA=Y PRIVACY_CONSENT=Y OMNI_KIT_ACCEPT_EULA=YES

# ffmpeg for the videos: system one, else a pip wheel inside Isaac Sim's python
if ! command -v ffmpeg >/dev/null 2>&1; then
  "$PY" -c "import imageio_ffmpeg" 2>/dev/null || "$PY" -m pip install --quiet imageio-ffmpeg || true
fi

mkdir -p "$OUT"
for run in $RUNS; do
  flags=""
  [ "$run" = "nocbf" ] && flags="--no-cbf"
  if [ "$run" = "plan" ]; then
    [ -f "$PLAN" ] || { echo "RUNS=plan needs PLAN=<plan.json> (got '$PLAN')"; exit 1; }
    flags="--plan $PLAN $PLAN_FLAGS"
  fi
  echo "=== recording $run ==="
  "$PY" "$HERE/sim/fishfarm_demo.py" --headless --safe-nav --obstacles "$OBST" --bands "$BANDS" \
      --record "$OUT/rec_$run" --record-cams demo,section,auv0,auv1,auv2 --record-res "$RES" \
      --pathtrace "$PATHTRACE" --out "$OUT/run_$run" $flags $EXTRA
  echo "=== rendering videos for $run ==="
  "$PY" "$HERE/tools/make_video.py" "$OUT/rec_$run"
done

echo
echo "Done. Videos:"
ls -1 "$OUT"/rec_*/abyss_*.mp4 2>/dev/null || true
echo "Summaries:"
ls -1 "$OUT"/run_*/nav_summary.json 2>/dev/null || true
