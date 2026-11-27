import { useEffect, useMemo, useRef } from 'react';
import { CELLS, DAYS, SECTOR_DEG, TODAY, WALL_DEPTH_M, WALL_ROWS, CONE_TIP_M, cellCol, cellRow, rowDepth, type Finding, type LayerId, type World } from '../data/model';
import { riskScore } from '../data/risk';
import { colorField, sample } from '../lib/heat';
import { LAYERS, computeLayerGrid, fitLayer, layerById, riskColor } from '../lib/layers';
import { color } from '../lib/tokens';
import type { Action } from '../lib/state';
import { Legend } from './Legend';

interface Props {
  world: World;
  day: number;
  layerId: LayerId;
  open: Finding[];
  dispatch: (a: Action) => void;
}

/** Depth (m) → fractional row, the inverse of the net's depth bands. */
function rowAtDepth(d: number): number {
  return d <= WALL_DEPTH_M ? (d / WALL_DEPTH_M) * WALL_ROWS : WALL_ROWS + ((d - WALL_DEPTH_M) / (CONE_TIP_M - WALL_DEPTH_M)) * 3;
}

/** Disc radius (0 centre, 1 rim) for a depth: the surface is the rim, the cone tip the centre. */
const radiusForDepth = (d: number): number => 1 - d / CONE_TIP_M;

/** Worst risk per day for each pen, computed once. */
const seriesCache = new WeakMap<World, Float32Array[]>();
function worstRiskSeries(world: World): Float32Array[] {
  const hit = seriesCache.get(world);
  if (hit) return hit;
  const out = world.sims.map((sim) => {
    const s = new Float32Array(DAYS);
    for (let d = 0; d < DAYS; d++) {
      let m = 0;
      for (let c = 0; c < CELLS; c++) m = Math.max(m, riskScore(sim, c, d));
      s[d] = m;
    }
    return s;
  });
  seriesCache.set(world, out);
  return out;
}

function Disc({ world, penIndex, day, layerId, findings, size }: { world: World; penIndex: number; day: number; layerId: LayerId; findings: Finding[]; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const grid = useMemo(() => computeLayerGrid(world, penIndex, day, layerId), [world, penIndex, day, layerId]);
  const layer = useMemo(() => fitLayer(layerById(layerId), grid.values), [layerId, grid]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const n = Math.round(size * Math.min(2, window.devicePixelRatio || 1));
    canvas.width = n;
    canvas.height = n;
    const field = colorField(grid, layer);
    const img = ctx.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5) / n - 0.5;
        const dy = (y + 0.5) / n - 0.5;
        const r = Math.hypot(dx, dy) * 2;
        if (r > 1) continue;
        const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
        sample(field, rowAtDepth((1 - r) * CONE_TIP_M), deg / SECTOR_DEG, img.data, (y * n + x) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    // Stale areas are hatched, never shown as calm.
    if (layer.hatchStale) {
      ctx.save();
      ctx.strokeStyle = color.hatch;
      ctx.lineWidth = 1;
      for (let c = 0; c < CELLS; c++) {
        if (!grid.stale[c]) continue;
        const [d0, d1] = rowDepth(cellRow(c));
        const a0 = ((cellCol(c) * SECTOR_DEG - 90) * Math.PI) / 180;
        const a1 = a0 + (SECTOR_DEG * Math.PI) / 180;
        ctx.beginPath();
        ctx.arc(n / 2, n / 2, (radiusForDepth(d0) * n) / 2, a0, a1);
        ctx.arc(n / 2, n / 2, (radiusForDepth(d1) * n) / 2, a1, a0, true);
        ctx.closePath();
        ctx.save();
        ctx.clip();
        for (let o = -n; o < n; o += 5) {
          ctx.beginPath();
          ctx.moveTo(o, n);
          ctx.lineTo(o + n, 0);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.restore();
    }
  }, [grid, layer, size]);

  const upstream = (world.env.currentDir[day] + 180) % 360;
  const pt = (deg: number, r: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [size / 2 + (r * size) / 2 * Math.sin(a), size / 2 - (r * size) / 2 * Math.cos(a)];
  };
  const [ux, uy] = pt(upstream, 1.08);
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <canvas ref={ref} style={{ width: size, height: size, borderRadius: '50%', display: 'block' }} />
      <svg width={size} height={size} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={size / 2} fill="none" stroke={color.ink2} strokeWidth={1.25} />
        <circle cx={size / 2} cy={size / 2} r={(radiusForDepth(10) * size) / 2} fill="none" stroke={color.ink} strokeOpacity={0.18} strokeDasharray="2 3" />
        <circle cx={size / 2} cy={size / 2} r={(radiusForDepth(WALL_DEPTH_M) * size) / 2} fill="none" stroke={color.ink} strokeOpacity={0.3} strokeDasharray="3 3" />
        <path d={`M${ux},${uy}L${pt(upstream, 1.0)[0]},${pt(upstream, 1.0)[1]}`} stroke={color.signal} strokeWidth={3} strokeLinecap="round" />
        {findings.map((f) => {
          const [d0, d1] = rowDepth(cellRow(f.cell));
          const [x, y] = pt(cellCol(f.cell) * SECTOR_DEG + SECTOR_DEG / 2, radiusForDepth((d0 + d1) / 2));
          return f.kind === 'hole' ? (
            <g key={f.id}>
              <circle cx={x} cy={y} r={9} fill="none" stroke={color.riskCritical} strokeWidth={1.5} strokeDasharray="2 2" />
              <circle cx={x} cy={y} r={4.5} fill={color.riskCritical} stroke={color.paper} strokeWidth={1.5} />
            </g>
          ) : (
            <circle key={f.id} cx={x} cy={y} r={4} fill={color.paper} stroke={color.ink} strokeWidth={2} />
          );
        })}
      </svg>
    </div>
  );
}

function Trend({ values, day }: { values: Float32Array; day: number }) {
  const w = 120;
  const h = 26;
  const d = Array.from(values, (v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - v * h).toFixed(1)}`).join('');
  const x = (day / (values.length - 1)) * w;
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
      <line x1={0} x2={w} y1={h - 0.5 * h} y2={h - 0.5 * h} stroke={color.lineStrong} strokeDasharray="2 3" />
      <path d={d} fill="none" stroke={color.ink2} strokeWidth={1.25} />
      <circle cx={x} cy={h - values[day] * h} r={3} fill={riskColor(values[day])} stroke={color.ink} strokeWidth={1} />
    </svg>
  );
}

/**
 * Site version 3: every pen's whole net as a disc, seen from below. The rim is the surface, the
 * dashed rings mark 10 m and the 20 m bottom of the wall, and the centre is the cone tip. The blue tick
 * marks the side facing the current. Pens sit side by side so their nets can be compared directly.
 */
export function NetAtlas({ world, day, layerId, open, dispatch }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const series = useMemo(() => worstRiskSeries(world), [world]);
  const layer = layerById(layerId);
  const size = 172;
  return (
    <div className="atlas" ref={wrap}>
      <div className="stage-controls top-left">
        <div className="segmented" role="group" aria-label="Map layer">
          {LAYERS.map((l) => (
            <button key={l.id} data-text={l.label} aria-pressed={l.id === layerId} onClick={() => dispatch({ type: 'layer', layer: l.id })}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="atlas-grid">
        {world.pens.map((pen, i) => {
          const penFindings = open.filter((f) => f.penId === pen.id);
          const worst = series[i][day];
          return (
            <button key={pen.id} className="atlas-item" onClick={() => dispatch({ type: 'pen', penIndex: i })} aria-label={`${pen.name}, worst risk ${Math.round(worst * 100)}. Open pen.`}>
              <Disc world={world} penIndex={i} day={day} layerId={layerId} findings={penFindings} size={size} />
              <span className="atlas-caption">
                <span className="atlas-name">{pen.name}</span>
                <span className="score" style={{ background: riskColor(worst), color: worst >= 0.7 ? color.onDark : color.ink }}>
                  {Math.round(worst * 100)}
                </span>
              </span>
              <Trend values={series[i]} day={day} />
              <span className="atlas-meta">{penFindings.length ? `${penFindings.length} open finding${penFindings.length > 1 ? 's' : ''}` : 'No open findings'}</span>
            </button>
          );
        })}
      </div>
      <p className="stage-hint">Each disc is a whole net seen from below: surface at the rim, bottom cone in the middle. Blue tick: current-facing side.{day > TODAY ? ' Forecast, predicted.' : ''}</p>
      <div className="stage-controls bottom-right">
        <Legend layer={layer} />
      </div>
    </div>
  );
}
