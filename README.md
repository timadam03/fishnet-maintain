# fishnet-maintain

Preventive net maintenance for Nordic fish farms: a swarm of inspection drones, a decision layer that
turns their data into risk per area of the net, and an operator interface.

- [`web/`](web/): operator UI demo (Vite, React, TypeScript, three.js) with simulated data. See its
  README for setup, tests and the demo storyline.
- [`abyss-sim/`](abyss-sim/): Isaac Sim net pen with three ROVs and HOCBF safe navigation. With
  `--plan` the ROVs fly the decision layer's ranked targets. See its README.
- [`docs/`](docs/): research and design notes. For the sim and the closed loop, start with
  [`docs/sim-plan-mode-handoff.md`](docs/sim-plan-mode-handoff.md) and
  [`docs/closed-loop.md`](docs/closed-loop.md).

Quick start:

```bash
cd web && npm install && npm run dev
```
