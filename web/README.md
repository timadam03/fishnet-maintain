# Shoal Net Risk (operator UI demo)

A clean, fast demo of the operator interface for preventive net monitoring on Nordic salmon farms.
It shows **where holes are likely to form**, not only where they already are, by combining robot
inspections, sensors and farm logs into one risk score per area of the net.

All data is **synthetic** (a seeded simulation), and the top bar says "Demo data".

## What's in it

- **One continuous view.** The site is drawn like a sea chart. Each pen is a ring coloured by the worst
  hole risk on each side of its net. Click a pen and the chart zooms into it, then the pen's net opens
  in 3D in its place. Esc or the breadcrumb zooms back out. The time bar floats at the bottom.
- **The net as a heatmap.** On the 3D net and on the "Unrolled" view (angle across, depth down, cone
  as a disc), values are interpolated smoothly between net areas and drawn in soft contour bands over
  a fine net-mesh texture.
  - Holes show as torn openings with a pulsing label.
  - When a pen opens, the camera turns to face the hole or the riskiest area.
- **Layers, each with its own colour family:**
  - Hole risk uses a magma-style scale: calm off-white through amber and coral to magenta and plum.
  - Wear, weight contact and cleaning are red.
  - Fouling is teal.
  - Oxygen and temperature are blue.
  - "Last seen" is grey.
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
- **History, Pen 4 (`#pen=4&cell=105&day=51`):** chafe from a weight rope was flagged at high risk and
  fixed before a twine broke.
- **History, Pen 3 (`#pen=3&day=70&layer=oxygen`):** crowding for delousing dropped oxygen across the pen.

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
- robots moving on the map, and live robot operations
- planning calendar and work-order board
- reports and compliance export
- diver mode for tablets, with offline sync
- comparing two inspections
- global search
- dark and high-contrast themes
- connectors for real data

Oxygen and temperature are shown per pen, not yet as a layer on the farm map.
