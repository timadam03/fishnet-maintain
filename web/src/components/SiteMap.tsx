import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { bathymetryImage, riskFieldImage } from '../lib/fieldImages';
import { ANGLE_SECTORS, SECTOR_DEG, TODAY, cellCol, type Finding, type World } from '../data/model';
import { riskColor } from '../lib/layers';
import type { PenSummary } from '../lib/summary';
import type { Drone } from '../data/swarm';
import { color } from '../lib/tokens';

interface Props {
  world: World;
  day: number;
  summaries: PenSummary[];
  open: Finding[];
  onOpenPen: (penIndex: number) => void;
  /** Pen the view is zoomed into, or null for the whole site. */
  focusPen: number | null;
  drones: Drone[];
  selectedDrone: string | null;
  /** "chart": risk as rings on the pens. "heat": a bathymetric chart with risk as a field over the water. */
  variant: 'chart' | 'heat';
  onSelectDrone: (id: string) => void;
}

/** Framed tightly around the pens and barge; the chart itself extends beyond it. */
const SITE_BOX: Box = [30, 110, 900, 450];
type Box = [number, number, number, number];
const ZOOM_MS = 520;

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Tweens the SVG viewBox between the whole site and one pen (instant under reduced motion). */
/** Stable box for a focus key ('site' or 'cx,cy'), so the tween only runs when the focus changes. */
const boxCache = new Map<string, Box>();
function useMemoBox(key: string): Box {
  let box = boxCache.get(key);
  if (!box) {
    if (key === 'site') box = SITE_BOX;
    else {
      const [cx, cy] = key.split(',').map(Number);
      box = [cx - 150, cy - 75, 300, 150];
    }
    boxCache.set(key, box);
  }
  return box;
}

function useViewBoxTween(ref: RefObject<SVGSVGElement | null>, target: Box): void {
  const current = useRef<Box>(target);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const from = current.current;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const start = performance.now();
    const step = (now: number): void => {
      const t = reduce ? 1 : Math.min(1, (now - start) / ZOOM_MS);
      const k = easeOut(t);
      const box = from.map((v, i) => v + (target[i] - v) * k) as Box;
      current.current = box;
      svg.setAttribute('viewBox', box.join(' '));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ref, target]);
}
const R = 42; // pen radius on the map
const toMap = (x: number, y: number): [number, number] => [190 + (x - 230) * 1.55, 190 + (y - 150) * 1.6];

/** Point at `deg` (0 = north, clockwise) on a circle. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M${x0},${y0}A${r1},${r1} 0 0 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 0 0 ${x3},${y3}Z`;
}

const BARGE: [number, number] = [84, 520];
// Sea and land run far past the viewBox so the chart fills any pane shape without letterboxing.
const COAST = 'M-3000,-3000H4000V40H1000C900,66 820,30 700,56C590,80 520,44 420,70C320,96 250,58 170,92C110,118 50,156 0,196H-3000Z';

/** Top-down farm view drawn like a sea chart; each pen is a ring coloured by the worst hole risk on each side of its net. */
export const SiteMap = memo(function SiteMap({ world, day, summaries, open, onOpenPen, focusPen, drones, selectedDrone, onSelectDrone, variant }: Props) {
  const speed = world.env.currentSpeed[day];
  const dir = world.env.currentDir[day];
  const live = day === TODAY;
  const centers = world.pens.map((p) => toMap(p.x, p.y));
  const svgRef = useRef<SVGSVGElement>(null);
  const droneEls = useRef<Record<string, SVGGElement | null>>({});
  const clockStart = useRef(performance.now());

  /** Where a drone is drawn after `elapsed` seconds: circling its pen, or parked at the barge. */
  const dronePosition = (d: Drone, elapsed: number): [number, number] => {
    if (d.penIndex === null) return [BARGE[0] - 20, BARGE[1] - 30];
    const [cx, cy] = centers[d.penIndex];
    const start = d.cell === null ? 0 : cellCol(d.cell) * SECTOR_DEG;
    const period = 30 + (d.id.charCodeAt(1) % 7) * 5;
    return polar(cx, cy, R + 13, start + (elapsed / period) * 360);
  };

  // Live mode: move the drones round their pens. Positions are set directly, without re-rendering.
  useEffect(() => {
    if (!live || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const tick = (now: number): void => {
      const elapsed = (now - clockStart.current) / 1000;
      for (const d of drones) {
        const el = droneEls.current[d.id];
        if (el) el.setAttribute('transform', `translate(${dronePosition(d, elapsed).join(' ')})`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // dronePosition only reads constants of this render (pen centres).
  }, [live, drones]);
  const focusKey = focusPen === null ? 'site' : `${centers[focusPen][0]},${centers[focusPen][1]}`;
  const target = useMemoBox(focusKey);
  const heat = variant === 'heat';
  const bathymetry = useMemo(() => (heat ? bathymetryImage() : null), [heat]);
  const riskField = useMemo(
    () =>
      heat
        ? riskFieldImage(
            summaries.map((s, i) => ({ cx: centers[i][0], cy: centers[i][1], radius: R, sectorRisk: s.sectorRisk })),
            { x: 0, y: 80, width: 960, height: 500 },
          )
        : null,
    // The pen centres are fixed for a given world, so only the risk and the variant matter.
    [heat, summaries],
  );
  useViewBoxTween(svgRef, target);

  return (
    <svg ref={svgRef} className={`site-svg${focusPen !== null ? ' focused' : ''}`} viewBox={SITE_BOX.join(' ')} preserveAspectRatio="xMidYMid meet" role="group" aria-label="Site map. Pens are coloured by hole risk.">
      <defs>
        <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill={color.unknown} />
          <line x1="0" y1="0" x2="0" y2="5" stroke={color.hatch} strokeWidth="1.2" />
        </pattern>
        <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,1L9,5L0,9" fill="none" stroke={color.signal} strokeWidth="1.5" />
        </marker>
      </defs>

      <rect x={-3000} y={-3000} width={7000} height={7000} fill={color.sea} />
      {bathymetry && <image href={bathymetry.href} x={bathymetry.x} y={bathymetry.y} width={bathymetry.width} height={bathymetry.height} preserveAspectRatio="none" />}
      <path d={COAST} fill={color.land} stroke={color.coast} strokeWidth={1.2} />

      {/* North arrow */}
      <g transform="translate(905 150)" aria-hidden="true">
        <path d="M0,-18L6,6L0,1L-6,6Z" fill={color.ink2} />
        <text y={22} textAnchor="middle" fill={color.ink2} fontSize={11} fontWeight={600}>
          N
        </text>
      </g>

      {/* Current field: length follows speed */}
      {Array.from({ length: 5 }, (_, i) =>
        Array.from({ length: 2 }, (_, j) => {
          const cx = 130 + i * 190 + j * 80;
          const cy = 290 + j * 235;
          const len = 12 + Math.min(44, speed * 0.75);
          const [x0, y0] = polar(cx, cy, -len / 2, dir);
          const [x1, y1] = polar(cx, cy, len / 2, dir);
          return <line key={`${i}-${j}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke={color.signal} strokeOpacity={0.45} strokeWidth={1.2} markerEnd="url(#arrowhead)" />;
        }),
      )}

      {riskField && <image href={riskField.href} x={riskField.x} y={riskField.y} width={riskField.width} height={riskField.height} preserveAspectRatio="none" style={{ mixBlendMode: 'multiply' }} />}

      {/* Feed lines and moorings */}
      {centers.map(([cx, cy], i) => (
        <g key={`m${i}`} fill="none" stroke={color.ink} strokeOpacity={0.12}>
          <path d={`M${BARGE[0] + 34},${BARGE[1]}Q${(BARGE[0] + cx) / 2},${BARGE[1] - 30} ${cx},${cy + R}`} />
          <rect x={cx - R - 22} y={cy - R - 22} width={2 * R + 44} height={2 * R + 44} />
          {[
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ].map(([sx, sy]) => (
            <circle key={`${sx}${sy}`} cx={cx + sx * (R + 22)} cy={cy + sy * (R + 22)} r={2.5} fill={color.paper} stroke={color.ink} strokeOpacity={0.5} />
          ))}
        </g>
      ))}

      <g>
        <rect x={BARGE[0] - 34} y={BARGE[1] - 16} width={68} height={32} rx={3} fill={color.paper} stroke={color.ink2} />
        <text x={BARGE[0]} y={BARGE[1] + 34} textAnchor="middle" fill={color.ink2} fontSize={12}>
          Feed barge
        </text>
      </g>

      {world.pens.map((pen, i) => {
        const [cx, cy] = centers[i];
        const s = summaries[i];
        const penOpen = open.filter((f) => f.penId === pen.id);
        return (
          <g
            key={pen.id}
            className="pen-glyph"
            tabIndex={0}
            role="button"
            aria-label={`${pen.name}: worst hole risk ${Math.round(s.maxRisk * 100)}, ${penOpen.length} open findings. Open pen.`}
            onClick={() => onOpenPen(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenPen(i);
              }
            }}
          >
            <circle className="focus-ring" cx={cx} cy={cy} r={R + 8} fill="none" stroke="transparent" strokeWidth={2} />
            {heat ? (
              <circle cx={cx} cy={cy} r={R} fill={color.paper} fillOpacity={0.25} />
            ) : (
              <circle cx={cx} cy={cy} r={R} fill={color.paper} />
            )}
            {Array.from({ length: ANGLE_SECTORS }, (_, k) => {
              const d = arc(cx, cy, R - 13, R, k * SECTOR_DEG + 0.6, (k + 1) * SECTOR_DEG - 0.6);
              return (
                <g key={k}>
                  {/* In the heat version the field carries the risk; stale sides stay hatched either way. */}
                  {!heat && <path d={d} fill={riskColor(s.sectorRisk[k])} />}
                  {s.sectorStale[k] === 1 && <path d={d} fill="url(#hatch)" />}
                </g>
              );
            })}
            <circle cx={cx} cy={cy} r={R + 1.5} fill="none" stroke={color.ink2} strokeWidth={1.5} />
            <text x={cx} y={cy + 6} textAnchor="middle" fill={color.ink} fontSize={17} fontWeight={600}>
              {pen.id}
            </text>
            {penOpen.map((f) => {
              const [fx, fy] = polar(cx, cy, R + 1.5, cellCol(f.cell) * SECTOR_DEG + SECTOR_DEG / 2);
              return f.kind === 'hole' ? (
                <g key={f.id}>
                  <circle cx={fx} cy={fy} r={6} fill={color.riskCritical} stroke={color.paper} strokeWidth={1.5} />
                  <path d={`M${fx - 2.5},${fy - 2.5}L${fx + 2.5},${fy + 2.5}M${fx + 2.5},${fy - 2.5}L${fx - 2.5},${fy + 2.5}`} stroke={color.paper} strokeWidth={1.5} />
                </g>
              ) : (
                <circle key={f.id} cx={fx} cy={fy} r={4.5} fill={color.paper} stroke={color.ink} strokeWidth={2.5} />
              );
            })}
            {penOpen.length > 0 && (
              <text x={cx} y={cy + R + 22} textAnchor="middle" fill={color.ink2} fontSize={12}>
                {penOpen.length} open finding{penOpen.length > 1 ? 's' : ''}
              </text>
            )}
          </g>
        );
      })}

      {/* Swarm drones: each circles the pen it is assigned to (moving in live mode only); click for details. */}
      {drones.map((d) => {
        const selected = d.id === selectedDrone;
        const docked = d.penIndex === null;
        return (
          <g
            key={d.id}
            ref={(el) => {
              droneEls.current[d.id] = el;
            }}
            className="drone"
            transform={`translate(${dronePosition(d, 0).join(' ')})`}
            role="button"
            tabIndex={0}
            aria-label={`${d.name}: ${d.task}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelectDrone(d.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectDrone(d.id);
              }
            }}
          >
            <circle r={11} fill="transparent" />
            {selected && <circle r={8} fill="none" stroke={color.signal} strokeWidth={1.5} />}
            <circle className="body" r={4} fill={docked ? color.ink3 : color.signal} stroke={color.paper} strokeWidth={1.5} />
            <text x={7} y={-6} fontSize={10} fill={color.ink2}>
              {d.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
});
