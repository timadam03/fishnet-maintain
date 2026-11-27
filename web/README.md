# Shoal Net Risk (operator UI demo)

A clean, fast demo of the operator interface for preventive net monitoring on Nordic salmon farms.
It shows **where holes are likely to form**, not only where they already are, by combining robot
inspections, sensors and farm logs into one risk score per area of the net.

All data is **synthetic** (a seeded simulation), and the top bar says "Demo data".

## What's in it

- **One view.** A 3D stage of the whole farm, plus a sidebar with the breadcrumb, details and charts:
  - every net hangs in the water painted with hole risk, with the barge and seabed around them;
  - click a pen and the camera flies down into it, then hands over to the detailed pen view at the
    same angle; Esc or the breadcrumb flies back out;
  - the time bar floats at the bottom of the stage.
- **Robot view.** Click any drone to see what it sees. `src/components/RobotView.tsx` is a
  **placeholder**: a drawn camera feed with detections boxed, plus telemetry and a slot for net-life
  prediction. The real robot view is being built separately; replace the component and keep its props
  (`world`, `day`, `drone`, `onClose`).
- **The net as a heatmap.** On the 3D net and on the "Unrolled" view (angle across, depth down, cone
  as a disc), values are interpolated smoothly between net areas and drawn in soft contour bands over
  a fine net-mesh texture.
  - Holes show as torn openings with a pulsing label.
  - When a pen opens, the camera turns to face the hole or the riskiest area.
- **Layers, each with its own colour family:**
  - The palette is "paper and ink", almost monochrome: colour appears only where hole risk is high
    (coral to deep red), so danger stands out.
  - Other layers use quiet grey, slate and sage ramps.
- **The swarm.** 20 drones work inside the nets, two to four per pen (moving in live mode). Every pen
  keeps a crew, and spare drones go to the pens with the most urgent areas. Drones follow the decision
  layer's plan rules (`docs/contracts.md`): they sweep for coverage 4 m off the net, stalest and
  riskiest areas first, and switch to a targeted look where one is needed: two drones from either side
  for a likely opening (P1), closer for an unsure detection (P2), two angles through heavy fouling
  (P4), closer for wear (P5) or high risk (P6). A confirmed hole leaves the plan; it needs the repair
  crew. Click a drone for its view, rule, distance off the net, partner, battery, health and queue.
  Drone D21 is docked for repair, which is why Pen 8's cone goes stale. Logic: `src/data/swarm.ts`.
- **Current.** In the pen view, faint streamlines bend around the pen, and particles drift along
  them at the day's current speed.
- **Feed barge, swarm dock.** Drones docked for repair or charging rest in cradles on the barge's
  pontoon, next to the pens.
- **Water inside the pen.** On the oxygen and temperature layers, a horizontal slice through the pen
  at a depth you choose shows how values change across the pen, such as oxygen dropping where water
  leaves the pen.
- **Charts in the side panel:**
  - net area at each risk level over time, as a stacked area, for the site and per pen;
  - water by depth over time, a depth × day heatmap for oxygen and temperature (the delousing drop and
    the autumn turnover are visible);
  - the pen's sensor string by depth.
- **Every score is explained.** Selecting an area shows Risk = Condition × Exposure × Consequence,
  the factors behind it, a likely range, a recommended action and the trend.
- **Findings.** Each finding has a before-and-now image (drawn placeholders) and one-tap review
  (`C` or `R`). Its lifecycle runs from detected to verified.
- **The URL holds the view.** Pen, area, finding, day and layer are kept in the URL, so reload, Back
  and shared links work.
- **Data trust.** Areas not seen for 14 or more days are hatched and always get "sample more"; Pen 8's
  cone drone is docked. A frozen oxygen sensor (Pen 7, 15 m) is drawn hollow and flagged.

### Demo cases

- **Today, Pen 2 (`#pen=2`):** a seal bite yesterday left a hole at 5–7.5 m, 255–270°. It is
  confirmed and a repair is ordered.
- **Today, Pen 7 (`#pen=7`):** the old net has sagged onto the sinker tube since 18 Nov. Risk is high
  at 17.5–20 m, 300–315°, a fresh detection is waiting for review, and the storm forecast for 1 Dec
  (`#day=93`) raises it further.
- **Today, Pen 1 (`#pen=1`):** a small opening at 12.5–15 m, confirmed and sent to the crew. Also a
  heavy fouling patch near the surface and a thin spot at 15–17.5 m.
- **Today, Pen 6 (`#pen=6`):** a likely opening (76 %) seen once; two drones confirm it from either side (P1).
- **Today, Pen 5 (`#pen=5`):** an unsure possible opening (55 %) gets a closer look (P2), next to a thin spot.
- **Today, fouling and thin spots:** fouling patches the cleaner misses in Pens 1, 2, 4, 6 and 8 (Fouling
  layer), thin twine in Pens 1, 3, 5 and 8 (Condition and Hole risk layers).
- **History, Pen 4 (`#pen=4&cell=105&day=51`):** chafe from a weight rope was flagged at high risk and
  fixed before a twine broke.
- **History, Pen 3 (`#pen=3&day=70&layer=oxygen`):** crowding for delousing dropped oxygen across the pen.

The problem areas of today are scripted in `SEEDS` in `src/data/simulate.ts`. How the dashboard will
show the real pipeline (Isaac run, image pipeline, decision layer) is planned in [`INTEGRATION.md`](INTEGRATION.md).

The model is in `src/data/risk.ts` and follows the preventive net-damage concept. Its weights are
examples and have not been calibrated against real farms.

## Setup and run

You need Node 20 or later and npm.

```bash
npm install
npm run dev      # http://localhost:5174
```

The page loads IBM Plex Sans from Google Fonts. Offline, it falls back to the system font.

## Test, type-check and build

```bash
npm test         # vitest: simulator, risk model, water, layer scales, URL state
npm run typecheck
npm run build    # production bundle in dist/
```

No linter is configured yet.

## Structure

```
src/
  data/        model types and grid, seeded simulator, risk model, oxygen and temperature
  lib/         colour tokens, layers and scales, UI state and URL, per-pen summaries
  lib/heat.ts  smooth (bicubic, banded) heatmap painting shared by the net map and the 3D texture
  components/  SiteMap (SVG, zooms into a pen), PenView (stage), Pen3D (three.js, lazy-loaded),
               NetMap (canvas), SidePanel, RiskShareChart, DepthTimeChart, DepthProfile,
               TimeBar, Legend, Sparkline, MeshImage
```

### Design

- **Look:** light and minimal, borrowed from nautical charts. The palette is white paper, pale sea,
  buff land, navy ink and one signal blue for selection.
- **Colour tokens:** they live in `src/lib/tokens.ts`. CSS reads them as custom properties; canvas,
  SVG and three.js import them directly.

### Performance

- The simulation runs once on load (about 0.1–0.2 s). After that, views only read precomputed arrays.
- The main bundle is about 90 KB gzipped.
- The 3D chunk is about 140 KB gzipped. It loads only when a pen is opened and renders only when
  something changes.

### Dependencies

- Runtime: `react`, `react-dom`, `three`.
- Development: `vite`, `@vitejs/plugin-react`, `typescript`, `vitest` and type packages.

Charts and heatmaps are drawn by hand with SVG and canvas, so no chart library is needed.

## Not built yet

These parts of the UI concept are left out on purpose:

- company level with several sites
- live robot video and manual control
- planning calendar and work-order board
- reports and compliance export
- diver mode for tablets, with offline sync
- comparing two inspections
- global search
- dark and high-contrast themes
- connectors for real data

Oxygen and temperature are shown per pen, not yet as a layer on the farm map.
