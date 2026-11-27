import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  ANGLE_SECTORS,
  CONE_ROWS,
  SECTOR_DEG,
  WALL_ROWS,
  cellCol,
  cellIndex,
  cellLabel,
  cellRow,
  rowDepth,
  type Finding,
} from '../data/model';
import { colorField, drawHole, drawMesh, hatchPattern, sample } from '../lib/heat';
import type { LayerDef, LayerGrid } from '../lib/layers';
import { color } from '../lib/tokens';

interface Props {
  grid: LayerGrid;
  layer: LayerDef;
  selectedCell: number | null;
  findings: Finding[];
  /** Angle the current comes from (the most loaded side). */
  upstreamAngle: number;
  boatSideAngle: number;
  onSelect: (cell: number) => void;
}

interface Layout {
  left: number;
  top: number;
  gw: number;
  gh: number;
  coneCx: number;
  coneCy: number;
  coneR: number;
}

const FONT = "'IBM Plex Sans', system-ui, sans-serif";

/** Wall as a wide band on top, cone as a disc below on the left (the legend takes the bottom right). */
function computeLayout(w: number, h: number): Layout {
  const left = 52;
  const right = 20;
  const top = 44;
  const gw = Math.max(200, w - left - right);
  const gh = Math.max(120, Math.min((h - top) * 0.52, gw * 0.45));
  const coneR = Math.max(36, Math.min((h - top - gh - 56) / 2, gw / 5));
  return { left, top, gw, gh, coneCx: left + coneR + 24, coneCy: top + gh + 40 + coneR, coneR };
}

/** Which cell is under (x, y), or null. */
function hitTest(l: Layout, x: number, y: number): number | null {
  if (x >= l.left && x < l.left + l.gw && y >= l.top && y < l.top + l.gh) {
    return cellIndex(Math.floor(((y - l.top) / l.gh) * WALL_ROWS), Math.floor(((x - l.left) / l.gw) * ANGLE_SECTORS));
  }
  const dx = x - l.coneCx;
  const dy = y - l.coneCy;
  const r = Math.hypot(dx, dy);
  if (r <= l.coneR) {
    const ring = Math.min(CONE_ROWS - 1, Math.floor((1 - r / l.coneR) * CONE_ROWS));
    const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    return cellIndex(WALL_ROWS + ring, Math.floor(deg / SECTOR_DEG) % ANGLE_SECTORS);
  }
  return null;
}

function cellPath(ctx: CanvasRenderingContext2D, l: Layout, cell: number): void {
  const row = cellRow(cell);
  const col = cellCol(cell);
  ctx.beginPath();
  if (row < WALL_ROWS) {
    const cw = l.gw / ANGLE_SECTORS;
    const ch = l.gh / WALL_ROWS;
    ctx.rect(l.left + col * cw, l.top + row * ch, cw, ch);
    return;
  }
  const ring = row - WALL_ROWS;
  const r1 = l.coneR * (1 - ring / CONE_ROWS);
  const r0 = l.coneR * (1 - (ring + 1) / CONE_ROWS);
  // Canvas angles start at 3 o'clock; ours start at 12 o'clock, clockwise.
  const a0 = ((col * SECTOR_DEG - 90) * Math.PI) / 180;
  const a1 = (((col + 1) * SECTOR_DEG - 90) * Math.PI) / 180;
  ctx.arc(l.coneCx, l.coneCy, r1, a0, a1);
  ctx.arc(l.coneCx, l.coneCy, r0, a1, a0, true);
  ctx.closePath();
}

function cellCentre(l: Layout, cell: number): [number, number] {
  const row = cellRow(cell);
  const col = cellCol(cell);
  if (row < WALL_ROWS) {
    return [l.left + ((col + 0.5) * l.gw) / ANGLE_SECTORS, l.top + ((row + 0.5) * l.gh) / WALL_ROWS];
  }
  const r = l.coneR * (1 - (row - WALL_ROWS + 0.5) / CONE_ROWS);
  const a = (((col + 0.5) * SECTOR_DEG - 90) * Math.PI) / 180;
  return [l.coneCx + r * Math.cos(a), l.coneCy + r * Math.sin(a)];
}

function blit(ctx: CanvasRenderingContext2D, img: ImageData, x: number, y: number, w: number, h: number): void {
  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  off.getContext('2d')?.putImageData(img, 0, 0);
  ctx.drawImage(off, x, y, w, h);
}

/**
 * The net "unrolled": angle around the pen across, depth down, bottom cone as a disc below.
 * Values are drawn as a smooth heat surface over a faint net mesh.
 */
export function NetMap({ grid, layer, selectedCell, findings, upstreamAngle, boatSideAngle, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 600, h: 500 });
  const [hover, setHover] = useState<{ cell: number; x: number; y: number } | null>(null);
  // Canvas text does not re-render when the web font arrives, so redraw once it has loaded.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    document.fonts.ready.then(() => alive && setFontsReady(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => computeLayout(size.w, size.h), [size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const l = layout;
    const field = colorField(grid, layer);

    // Wall: smooth heat, painted at CSS-pixel resolution.
    const wallW = Math.max(1, Math.round(l.gw));
    const wallH = Math.max(1, Math.round(l.gh));
    const wall = ctx.createImageData(wallW, wallH);
    for (let y = 0; y < wallH; y++) {
      const row = ((y + 0.5) / wallH) * WALL_ROWS;
      for (let x = 0; x < wallW; x++) sample(field, row, ((x + 0.5) / wallW) * ANGLE_SECTORS, wall.data, (y * wallW + x) * 4);
    }
    // Cone: polar; its outer edge meets the bottom of the wall.
    const coneD = Math.max(1, Math.round(l.coneR * 2));
    const cone = ctx.createImageData(coneD, coneD);
    for (let y = 0; y < coneD; y++) {
      for (let x = 0; x < coneD; x++) {
        const dx = x + 0.5 - coneD / 2;
        const dy = y + 0.5 - coneD / 2;
        const r = Math.hypot(dx, dy) / (coneD / 2);
        if (r > 1) continue;
        const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
        sample(field, WALL_ROWS + (1 - r) * CONE_ROWS, deg / SECTOR_DEG, cone.data, (y * coneD + x) * 4);
      }
    }
    blit(ctx, wall, l.left, l.top, l.gw, l.gh);
    blit(ctx, cone, l.coneCx - l.coneR, l.coneCy - l.coneR, l.coneR * 2, l.coneR * 2);

    // Net texture
    drawMesh(ctx, l.left, l.top, l.gw, l.gh, 9);
    ctx.save();
    ctx.beginPath();
    ctx.arc(l.coneCx, l.coneCy, l.coneR, 0, Math.PI * 2);
    ctx.clip();
    drawMesh(ctx, l.coneCx - l.coneR, l.coneCy - l.coneR, l.coneR * 2, l.coneR * 2, 9);
    ctx.restore();

    // Stale data is hatched, never shown as calm.
    const pattern = hatchPattern(ctx);
    if (layer.hatchStale && pattern) {
      ctx.fillStyle = pattern;
      for (let c = 0; c < grid.stale.length; c++) {
        if (!grid.stale[c]) continue;
        cellPath(ctx, l, c);
        ctx.fill();
      }
    }

    ctx.strokeStyle = color.lineStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(l.left, l.top, l.gw, l.gh);
    ctx.beginPath();
    ctx.arc(l.coneCx, l.coneCy, l.coneR, 0, Math.PI * 2);
    ctx.stroke();

    // Axes
    ctx.fillStyle = color.ink3;
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let r = 0; r <= WALL_ROWS; r += 2) {
      const depth = r < WALL_ROWS ? rowDepth(r)[0] : rowDepth(WALL_ROWS - 1)[1];
      ctx.fillText(`${depth} m`, l.left - 8, l.top + (r / WALL_ROWS) * l.gh);
    }
    ctx.textBaseline = 'bottom';
    const compass: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let a = 0; a <= 360; a += 45) {
      ctx.textAlign = a === 0 ? 'left' : a === 360 ? 'right' : 'center';
      ctx.fillText(`${a}°${compass[a] && a < 360 ? ` ${compass[a]}` : ''}`, l.left + (a / 360) * l.gw, l.top - 6);
    }

    // Side annotations under the wall: a ±45° band, wrapping around 0°/360°.
    const band = (deg: number, stroke: string, label: string, y: number): void => {
      const centre = (((deg % 360) + 360) % 360) / 360;
      const half = (45 / 360) * l.gw;
      ctx.save();
      ctx.beginPath();
      ctx.rect(l.left, y - 2, l.gw, 6);
      ctx.clip();
      ctx.fillStyle = stroke;
      for (const shift of [-1, 0, 1]) ctx.fillRect(l.left + (centre + shift) * l.gw - half, y, 2 * half, 2);
      ctx.restore();
      ctx.fillStyle = color.ink2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, Math.min(Math.max(l.left + centre * l.gw, l.left + 60), l.left + l.gw - 60), y + 5);
    };
    band(upstreamAngle, color.signal, 'Current-facing side', l.top + l.gh + 6);
    // Skip the boat-side label when it would collide with the current label.
    const apart = Math.abs(((boatSideAngle - upstreamAngle + 540) % 360) - 180);
    if (apart > 60) band(boatSideAngle, color.ink3, 'Boat side', l.top + l.gh + 6);

    ctx.fillStyle = color.ink3;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Bottom cone, 20–30 m', l.coneCx + l.coneR + 14, l.coneCy);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('0° N', l.coneCx, l.coneCy - l.coneR - 4);

    // Findings: holes as torn openings with a dashed ring, wear as small rings.
    const cellSize = Math.min(l.gw / ANGLE_SECTORS, l.gh / WALL_ROWS);
    for (const f of findings) {
      const [x, y] = cellCentre(l, f.cell);
      if (f.kind === 'hole') {
        drawHole(ctx, x, y, Math.max(6, cellSize * 0.35));
        ctx.beginPath();
        ctx.arc(x, y, Math.max(12, cellSize * 0.75), 0, Math.PI * 2);
        ctx.strokeStyle = color.riskCritical;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = color.paper;
        ctx.fill();
        ctx.strokeStyle = color.ink;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    if (selectedCell !== null) {
      cellPath(ctx, l, selectedCell);
      ctx.strokeStyle = color.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [grid, layer, selectedCell, findings, size, layout, upstreamAngle, boatSideAngle, fontsReady]);

  const pos = (e: MouseEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const hoverValue = hover ? grid.values[hover.cell] : NaN;
  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: hover ? 'pointer' : 'default' }}
        onMouseMove={(e) => {
          const [x, y] = pos(e);
          const cell = hitTest(layout, x, y);
          setHover(cell === null ? null : { cell, x, y });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const [x, y] = pos(e);
          const cell = hitTest(layout, x, y);
          if (cell !== null) onSelect(cell);
        }}
      />
      {hover && (
        <div className="tooltip" style={{ left: Math.min(hover.x + 14, size.w - 220), top: hover.y + 14 }}>
          <div className="t">{cellLabel(hover.cell)}</div>
          <div className="m">
            {layer.label}: {Number.isNaN(hoverValue) ? 'no data' : layer.format(hoverValue)}
            {layer.hatchStale && grid.stale[hover.cell] ? ', not seen for 14+ days' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
