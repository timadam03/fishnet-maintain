# fishnet-maintain

Preventive net maintenance for Nordic fish farms: a swarm of inspection drones, a decision layer that
turns their data into risk per area of the net, and an operator interface.

- [`web/`](web/): operator UI demo (Vite, React, TypeScript, three.js) with simulated data. See its
  README for setup, tests and the demo storyline.
- [`decision-layer/`](decision-layer/): rules, memory, learning and agents on top of the UI's simulated
  world, served as a JSON API on port 8787. See its README.
- [`docs/`](docs/): research and design notes for the decision layer.

Quick start:

```bash
cd web && npm install && npm run dev
```
