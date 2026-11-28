<#
run_loop.ps1 -- the closed loop on the Windows GPU machine, in one command.

  1. sweep    Isaac Sim: centre survey of the whole net           -> <Out>\run_sweep
  2. detect   net detector on every sweep photo                    -> run_sweep\vision.jsonl
  3. decide   decision layer: grade every cell, write the plan     -> run_sweep\plan_<grader>.json
  4. act      Isaac Sim: fly the plan (closer, other angles)       -> <Out>\run_plan_<grader>
  5. learn    detect the new photos and import them: missions close with results
  6. score    the plan and the mission results against the sim's ground truth

  powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\loop2

-Runthrough renders the whole loop as one demo video at the end: <Out>\runthrough_<grader>.mp4
(sweep, classifier, decision layer, the robots acting, results; tools\make_runthrough.py). With
-Record it shows the recordings, without it the photos.

-Grader d1 grades the cells with the d1 decision model instead of the rules (needs
AI_GATEWAY_API_KEY in the repo's .env). To compare both on the same sweep, run the rules loop
first, then the same -Out with -SkipSweep -Grader d1: the score shows both plans side by side.

Needs Isaac Sim 5.1, Node 24+ for the decision layer, and a Python with opencv-python and numpy
(a normal Python, or Isaac's own if it has OpenCV). The sweep and the plan run share the same scene
flags, so the ropes and net defects are where the plan expects them: keep -Seed and -Obstacles the
same when you rerun a step.
#>
param(
  [string]$Isaac = "C:\isaacsim51",   # Isaac Sim install (the folder with python.bat)
  [string]$Out = "C:\abyss_out\loop", # one folder per loop
  [int]$Obstacles = 12,               # ropes / hoses hanging in the pen
  [int]$Seed = 7,                     # --defect-seed: which net (holes, thinning, fouling)
  [switch]$Lite,                      # 640x360, faster: for checking the loop works
  [switch]$Record,                    # also record videos of both runs (slower)
  [switch]$KeepMemory,                # don't reset the decision layer first
  [switch]$SkipSweep,                 # reuse <Out>\run_sweep and start from the detect step
  [switch]$Runthrough,                # render the demo video of the whole loop at the end
  [ValidateSet("rules", "d1")]
  [string]$Grader = "rules"           # who grades the cells: the plan rules, or the d1 model
)

# Every step is checked explicitly below. Not "Stop": in Windows PowerShell 5.1 that turns any
# stderr output of a native program (Python warnings, Isaac Sim logs) into a script-ending error.
$SimRoot = Split-Path -Parent $PSScriptRoot          # ...\abyss-sim
$Repo = Split-Path -Parent $SimRoot                  # repo root
$Demo = Join-Path $SimRoot "sim\fishfarm_demo.py"
$Vision = Join-Path $SimRoot "tools\run_vision.py"
$MakeVideo = Join-Path $SimRoot "tools\make_video.py"
$DecisionLayer = Join-Path $Repo "decision-layer"
$IsaacPy = Join-Path $Isaac "python.bat"
$Sweep = Join-Path $Out "run_sweep"
$PlanRun = Join-Path $Out "run_plan_$Grader"
$PlanFile = Join-Path $Sweep "plan_$Grader.json"
$Score = Join-Path $SimRoot "tools\score_loop.py"
$MakeRunthrough = Join-Path $SimRoot "tools\make_runthrough.py"
$Db = Join-Path $Repo "shoal.db"

function Step($text) { Write-Host ""; Write-Host "=== $text ===" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "STOPPED: $text" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------ checks before anything runs
if (-not (Test-Path $IsaacPy)) { Fail "no python.bat in $Isaac (pass -Isaac <your Isaac Sim folder>)" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node 24+ is needed for the decision layer (https://nodejs.org)" }
$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 24) { Fail "Node $nodeMajor found; the decision layer needs Node 24 or newer" }

# The detector runs outside Isaac Sim. Use the first Python that can import OpenCV.
$Py = $null
foreach ($cand in @("python", "py", $IsaacPy)) {
  if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
  & $cand -c "import cv2, numpy" 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $Py = $cand; break }
}
if (-not $Py) { Fail "no Python with OpenCV found. Run: pip install opencv-python numpy  (or: $IsaacPy -m pip install opencv-python)" }

if (-not (Test-Path (Join-Path $DecisionLayer "node_modules"))) {
  Step "installing the decision layer (first run only)"
  Push-Location $DecisionLayer
  try { & npm ci; if ($LASTEXITCODE -ne 0) { Fail "npm ci failed in $DecisionLayer" } } finally { Pop-Location }
}

if ($Grader -eq "d1") {
  $envFile = Join-Path $Repo ".env"
  $hasKey = (Test-Path $envFile) -and (Select-String -Path $envFile -Pattern "^\s*AI_GATEWAY_API_KEY\s*=\s*\S" -Quiet)
  if (-not $hasKey -and -not $env:AI_GATEWAY_API_KEY) { Fail "-Grader d1 needs AI_GATEWAY_API_KEY=... in $envFile" }
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
Write-Host "Isaac Sim: $Isaac | detector Python: $Py | Node $nodeMajor | grader: $Grader | output: $Out"

# Same scene for the sweep and the plan run: these flags place the ropes and the net defects.
$Scene = @("--headless", "--safe-nav", "--obstacles", "$Obstacles", "--defect-seed", "$Seed", "--full-coverage")
if ($Lite) { $Scene += "--lite" }

function Run-Sim([string]$name, [string]$outDir, [string[]]$extra = @()) {
  $simArgs = @($Demo) + $Scene + $extra + @("--out", $outDir)
  if ($Record) {
    $simArgs += @("--record", (Join-Path $Out "rec_$name"), "--record-cams", "demo,section,auv0,auv1,auv2")
  }
  & $IsaacPy @simArgs
  # Isaac Sim can crash on shutdown after a good run, so judge by the files it wrote, not its exit code.
  $caps = Join-Path $outDir "captures.jsonl"
  if (-not (Test-Path $caps) -or (Get-Item $caps).Length -eq 0) { Fail "the $name run wrote no photos ($caps)" }
  $n = (Get-Content $caps | Where-Object { $_.Trim() }).Count
  Write-Host "[$name] $n photos in $outDir"
  if ($Record) { & $IsaacPy $MakeVideo (Join-Path $Out "rec_$name") }
}

function Run-Vision($runDir) {
  & $Py $Vision $runDir --overlays
  if ($LASTEXITCODE -ne 0) { Fail "the detector failed on $runDir" }
}

function Decision([string[]]$cliArgs) {
  Push-Location $DecisionLayer
  try {
    & npm run --silent cli -- @cliArgs
    if ($LASTEXITCODE -ne 0) { Fail "decision layer: 'cli $($cliArgs -join ' ')' failed" }
  } finally { Pop-Location }
}

# ------------------------------------------------------------------ 1. sweep
if ($SkipSweep) {
  if (-not (Test-Path (Join-Path $Sweep "captures.jsonl"))) { Fail "-SkipSweep, but there is no sweep in $Sweep" }
  Write-Host "reusing the sweep in $Sweep"
} else {
  Step "1/6 sweep: centre survey of the whole net"
  Run-Sim "sweep" $Sweep
}

# ------------------------------------------------------------------ 2. detect
Step "2/6 detect: net detector on the sweep photos"
Run-Vision $Sweep

# ------------------------------------------------------------------ 3. decide
Step "3/6 decide: grade the net ($Grader) and plan the close-ups"
if (-not $KeepMemory) { Decision @("reset") }
Decision @("import", $Sweep)
Decision @("plan", "--grader", $Grader, "--out", $PlanFile)
$plan = Get-Content $PlanFile -Raw | ConvertFrom-Json
if ($plan.targets.Count -eq 0) {
  Write-Host ""
  Write-Host "The decision layer found nothing worth a closer look, so there is no plan run." -ForegroundColor Yellow
  exit 0
}

# ------------------------------------------------------------------ 4. act
Step "4/6 act: the ROVs fly the plan ($($plan.targets.Count) targets)"
Run-Sim "plan_$Grader" $PlanRun @("--plan", $PlanFile)

# ------------------------------------------------------------------ 5. learn
Step "5/6 learn: detect the close-ups and close the missions"
Run-Vision $PlanRun
Decision @("import", $PlanRun, "--grader", $Grader)
Decision @("missions")
Decision @("plan", "--grader", $Grader, "--out", (Join-Path $PlanRun "next_plan.json"))
# The next loop's reset clears the missions: keep this loop's results next to its photos.
Copy-Item $Db (Join-Path $PlanRun "shoal.db") -Force

# ------------------------------------------------------------------ 6. score
Step "6/6 score: plans and mission results vs ground truth"
& $Py $Score $Out --db $Db

# ------------------------------------------------------------------ summary
Step "done"
foreach ($run in @($Sweep, $PlanRun)) {
  $nav = Join-Path $run "nav_summary.json"
  if (Test-Path $nav) {
    $s = Get-Content $nav -Raw | ConvertFrom-Json
    $contacts = 0
    foreach ($p in $s.PSObject.Properties) { if ($p.Name -like "auv_*") { $contacts += [int]$p.Value.contacts } }
    Write-Host ("{0}: net/obstacle contacts {1}" -f (Split-Path -Leaf $run), $contacts)
  }
}
Write-Host "Plan:      $PlanFile"
Write-Host "Overlays:  $(Join-Path $Sweep 'overlays')  and  $(Join-Path $PlanRun 'overlays')"
if ($Record) { Write-Host "Videos:    $Out\rec_sweep, $Out\rec_plan_$Grader (the .mp4 files in each)" }
if ($Runthrough) {
  Step "runthrough: the whole loop as one demo video"
  & $IsaacPy $MakeRunthrough $Out --grader $Grader
  if ($LASTEXITCODE -ne 0) { Write-Host "the runthrough video failed (the loop itself is done)" -ForegroundColor Yellow }
}
