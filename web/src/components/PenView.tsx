import { Suspense, lazy, useCallback, useMemo, type Dispatch } from 'react';
import { CELLS, TODAY, type Finding, type LayerId, type World } from '../data/model';
import { riskScore } from '../data/risk';
import type { Drone } from '../data/swarm';
import { waterAtPoint } from '../data/water';
import { MAP_LAYERS, computeLayerGrid, fitLayer, layerById, oxygenDeficit, type LayerDef } from '../lib/layers';
import { isConfirmedHole, statusAt, type Action, type PenViewMode, type Review } from '../lib/state';
import { Legend } from './Legend';
import { NetMap } from './NetMap';

const Pen3D = lazy(() => import('./Pen3D'));

interface Props {
  world: World;
  penIndex: number;
  day: number;
  layerId: LayerId;
  cell: number | null;
  view: PenViewMode;
  findings: Finding[];
  reviews: Record<number, Review>;
  drones: Drone[];
  selectedDrone: string | null;
  dispatch: Dispatch<Action>;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (deg: number): string => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const KIND: Record<Finding['kind'], string> = { hole: 'Hole', chafe: 'Chafe', fraying: 'Fraying', distortion: 'Distortion' };

function parseRgb(c: string): [number, number, number] {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/\d+/g) ?? ['0', '0', '0'];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

/** Depths of the see-through oxygen layers inside the pen (m). */
const OXYGEN_DEPTHS = [2, 6, 10, 14, 18];

/**
 * Paints oxygen across a horizontal disc inside the pen (north up). Water with plenty of oxygen is
 * left almost clear; the lower the oxygen, the stronger the colour, so the layers stacked through the
 * depth show where in the pen the water is poor without hiding the rest.
 */
function paintOxygenLayer(canvas: HTMLCanvasElement, world: World, penId: number, depth: number, day: number, layer: LayerDef): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const n = canvas.width;
  const img = ctx.createImageData(n, n);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const x = ((px + 0.5) / n) * 2 - 1;
      const y = 1 - ((py + 0.5) / n) * 2;
      const r2 = x * x + y * y;
      if (r2 > 1) continue;
      const v = waterAtPoint(world, penId, depth, x, y, day).oxygen;
      const deficit = oxygenDeficit(v);
      const [r, g, b] = parseRgb(layer.color(v));
      const at = (py * n + px) * 4;
      img.data[at] = r;
      img.data[at + 1] = g;
      img.data[at + 2] = b;
      // Soft edge towards the net, so the layers read as water rather than discs.
      img.data[at + 3] = Math.round(255 * (0.04 + 0.75 * deficit) * Math.min(1, (1 - r2) * 6));
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Pen level inside the one-view stage: layer chips, 3D or unrolled net, legend, and a oxygen layers inside the pen. */
export function PenView({ world, penIndex, day, layerId, cell, view, findings, reviews, drones, selectedDrone, dispatch }: Props) {
  const penDrones = useMemo(() => drones.filter((d) => d.penIndex === penIndex), [drones, penIndex]);
  const selectDrone = useCallback((id: string): void => dispatch({ type: 'drone', id }), [dispatch]);
  const grid = useMemo(() => computeLayerGrid(world, penIndex, day, layerId), [world, penIndex, day, layerId]);
  // Heavy fouling is drawn on the net as growth, except on the fouling layer, which shows it as data.
  const growth = useMemo(() => (layerId === 'fouling' ? undefined : computeLayerGrid(world, penIndex, day, 'fouling').values), [world, penIndex, day, layerId]);
  const layer = useMemo(() => fitLayer(layerById(layerId), grid.values), [layerId, grid]);
  const pen = world.pens[penIndex];
  const currentDir = world.env.currentDir[day];
  const upstream = (currentDir + 180) % 360;
  const select = useCallback((c: number): void => dispatch({ type: 'cell', penIndex, cell: c }), [dispatch, penIndex]);
  const selectFinding = useCallback((f: Finding): void => dispatch({ type: 'finding', penIndex, cell: f.cell, findingId: f.id }), [dispatch, penIndex]);
  const holeIds = useMemo(() => new Set(findings.filter((f) => isConfirmedHole(f, day, reviews)).map((f) => f.id)), [findings, day, reviews]);
  const labelFor = useCallback(
    (f: Finding): string => {
      const s = statusAt(f, day, reviews);
      const note = s === 'unreviewed' ? 'needs review' : s === 'work-order' ? 'repair ordered' : s === 'confirmed' ? 'confirmed' : s === 'repaired' ? 'repaired' : '';
      const kind = f.kind === 'hole' && s === 'unreviewed' ? 'Possible opening' : KIND[f.kind];
      return `${kind} #${f.id}${note ? `, ${note}` : ''}`;
    },
    [day, reviews],
  );

  // On opening, face the open hole, else the riskiest area; afterwards follow the selection.
  const defaultFocus = useMemo(() => {
    const hole = findings.find((f) => f.kind === 'hole');
    if (hole) return hole.cell;
    let best = 0;
    let bestScore = -1;
    for (let c = 0; c < CELLS; c++) {
      const r = riskScore(world.sims[penIndex], c, day);
      if (r > bestScore) {
        bestScore = r;
        best = c;
      }
    }
    return best;
    // Only when the pen opens; time scrubbing should not swing the camera around.
  }, [penIndex]);
  const focusCell = cell ?? defaultFocus;

  // Oxygen is about the water in the pen, so it is also shown as see-through layers through the depth.
  const water = useMemo(() => {
    if (layerId !== 'oxygen' || view !== '3d') return null;
    return { depths: OXYGEN_DEPTHS, paint: (canvas: HTMLCanvasElement, depth: number) => paintOxygenLayer(canvas, world, pen.id, depth, day, layer) };
  }, [layerId, view, world, pen.id, day, layer]);

  return (
    <div className="pen-stage">
      <div className="stage-controls top-left">
        <div className="segmented" role="group" aria-label="Map layer">
          {MAP_LAYERS.map(layerById).map((l) => (
            <button key={l.id} data-text={l.label} aria-pressed={l.id === layerId} onClick={() => dispatch({ type: 'layer', layer: l.id })}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="stage-controls top-right">
        <div className="segmented" role="group" aria-label="View">
          <button data-text="3D" aria-pressed={view === '3d'} onClick={() => dispatch({ type: 'view', view: '3d' })}>
            3D
          </button>
          <button data-text="Unrolled" aria-pressed={view === 'unrolled'} onClick={() => dispatch({ type: 'view', view: 'unrolled' })}>
            Unrolled
          </button>
        </div>
      </div>

      <div className="stage-canvas">
        {view === '3d' ? (
          <Suspense fallback={<p className="empty" style={{ padding: 96, textAlign: 'center' }}>Loading 3D model…</p>}>
            <Pen3D
              grid={grid}
              layer={layer}
              selectedCell={cell}
              findings={findings}
              holeIds={holeIds}
              growth={growth}
              currentDir={currentDir}
              currentSpeed={world.env.currentSpeed[day]}
              drones={penDrones}
              selectedDrone={selectedDrone}
              onSelectDrone={selectDrone}
              live={day === TODAY}
              onSelect={select}
              onSelectFinding={selectFinding}
              labelFor={labelFor}
              water={water}
              focusCell={focusCell}
            />
          </Suspense>
        ) : (
          <div className="unrolled">
            <NetMap grid={grid} layer={layer} selectedCell={cell} findings={findings} holeIds={holeIds} upstreamAngle={upstream} boatSideAngle={pen.boatSideAngle} onSelect={select} />
          </div>
        )}
      </div>

      <div className="stage-controls bottom-left">
        <Legend layer={layer} />
      </div>
      {view === '3d' && (
        <p className="stage-hint centred">
          Current {Math.round(world.env.currentSpeed[day])}&nbsp;cm/s towards {compass(currentDir)}. Drag to turn, scroll to zoom.
          {day > TODAY ? ' Forecast values are predicted.' : ''}
        </p>
      )}
    </div>
  );
}
