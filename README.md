# fishnet-maintain

Preventive net maintenance for Nordic fish farms: a swarm of inspection drones, a decision layer that
turns their data into risk per area of the net, and an operator interface.

- [`web/`](web/): operator UI demo (Vite, React, TypeScript, three.js) with simulated data. See its
  README for setup, tests and the demo storyline.
- [`abyss-sim/`](abyss-sim/): Isaac Sim net pen with three ROVs and HOCBF safe navigation. With
  `--plan` the ROVs fly the decision layer's ranked targets. See its README.
- [`abyss-sim/perception/`](abyss-sim/perception/) and
  [`abyss-sim/tools/run_vision.py`](abyss-sim/tools/run_vision.py): the net detector, run on every
  photo of a sim run to write `vision.jsonl`.
- [`decision-layer/`](decision-layer/): rules, memory, learning and agents, served as a JSON API on
  port 8787. See its README.
- [`docs/`](docs/): research and design notes. For the sim and the closed loop, start with
  [`docs/sim-plan-mode-handoff.md`](docs/sim-plan-mode-handoff.md) and
  [`docs/closed-loop.md`](docs/closed-loop.md).

The whole loop (sweep, detect, decide, plan run) in one command, on the Windows GPU machine:

```powershell
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\loop1
```

To let the d1 decision model grade the net instead of the rules (`decision-layer/src/grade-d1.ts`;
needs `AI_GATEWAY_API_KEY` in `.env`), rerun on the same sweep and compare the scores:

```powershell
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\loop1 -SkipSweep -Grader d1
```

For the final demo, the whole loop as one video (sweep, classifier, decisions, the robots acting,
results), see [`docs/demo-runthrough.md`](docs/demo-runthrough.md):

```powershell
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\demo -Record -Runthrough
```

Quick start for the UI:

```bash
cd web && npm install && npm run dev
```
