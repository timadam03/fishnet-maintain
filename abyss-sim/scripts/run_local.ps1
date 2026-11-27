# Local Windows run (Isaac Sim 5.1 GUI). Close the Isaac Sim app first.
#   powershell -ExecutionPolicy Bypass -File scripts\run_local.ps1
param([string]$Isaac = "C:\isaacsim", [string]$Out = "C:\abyss_out", [int]$Obstacles = 12)
$Here = Split-Path -Parent $PSScriptRoot
& "$Isaac\python.bat" "$Here\sim\fishfarm_demo.py" --safe-nav --obstacles $Obstacles --bands 2 --lite --out "$Out\run_local"
