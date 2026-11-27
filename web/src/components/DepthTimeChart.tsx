import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CONE_TIP_M, DAYS, TODAY, dayLabel, type World } from '../data/model';
import { waterAtPoint } from '../data/water';
import { fitLayer, layerById } from '../lib/layers';
import { color } from '../lib/tokens';

interface Props {
  world: World;
  penId: number;
  day: number;
  measure: 'oxygen' | 'temperature';
}

const DEPTHS = CONE_TIP_M + 1; // one row per metre
const BANDS = 14;

/**
 * Depth over time: days across, depth down, colour = mid-pen oxygen or temperature.
 * Shows events that a single wall heatmap hides, such as the delousing oxygen drop or the
 * autumn turnover where deep water ends up warmer than the surface.
 */
export function DepthTimeChart({ world, penId, day, measure }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ d: number; z: number } | null>(null);

  const values = useMemo(() => {
    const v = new Float32Array(DAYS * DEPTHS);
    for (let d = 0; d < DAYS; d++) for (let z = 0; z < DEPTHS; z++) v[d * DEPTHS + z] = waterAtPoint(world, penId, z, 0, 0, d)[measure];
    return v;
  }, [world, penId, measure]);
  // Oxygen keeps its fixed scale (welfare limits matter); temperature is fitted to the period shown.
  const layer = useMemo(() => (measure === 'oxygen' ? layerById('oxygen') : fitLayer(layerById('temperature'), values)), [measure, values]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = DAYS;
    canvas.height = DEPTHS;
    const img = ctx.createImageData(DAYS, DEPTHS);
    const span = layer.max - layer.min || 1;
    for (let d = 0; d < DAYS; d++) {
      for (let z = 0; z < DEPTHS; z++) {
        const t = Math.max(0, Math.min(1, (values[d * DEPTHS + z] - layer.min) / span));
        const banded = layer.min + (Math.min(BANDS - 1, Math.floor(t * BANDS)) / (BANDS - 1)) * span;
        const m = layer.color(banded).match(/\d+/g) ?? ['0', '0', '0'];
        const at = (z * DAYS + d) * 4;
        img.data[at] = Number(m[0]);
        img.data[at + 1] = Number(m[1]);
        img.data[at + 2] = Number(m[2]);
        img.data[at + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [values, layer]);

  const onMove = (e: MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const d = Math.max(0, Math.min(DAYS - 1, Math.round(((e.clientX - rect.left) / rect.width) * (DAYS - 1))));
    const z = Math.max(0, Math.min(DEPTHS - 1, Math.round(((e.clientY - rect.top) / rect.height) * (DEPTHS - 1))));
    setHover({ d, z });
  };

  const shown = hover ?? { d: day, z: 10 };
  const xPct = (d: number): string => `${(d / (DAYS - 1)) * 100}%`;
  return (
    <figure style={{ margin: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 10px', gap: 6 }}>
        <div className="axis-y num">
          <span>0 m</span>
          <span>15</span>
          <span>30</span>
        </div>
        <div style={{ position: 'relative', height: 120 }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block', borderRadius: 4 }} aria-label={`${layer.label} by depth over time`} role="img" />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: xPct(TODAY), right: 0, background: 'rgba(255,255,255,0.45)', borderLeft: `1px dashed ${color.ink3}` }} />
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: xPct(shown.d), width: 1, background: color.ink }} />
        </div>
        <div style={{ borderRadius: 3, background: `linear-gradient(${[...Array(8)].map((_, i) => layer.color(layer.max - ((layer.max - layer.min) * i) / 7)).join(',')})` }} title={`${layer.format(layer.max)} to ${layer.format(layer.min)}`} />
      </div>
      <figcaption className="chart-caption num">
        <span>
          {dayLabel(shown.d)}, {shown.z}&nbsp;m: <b>{layer.format(values[shown.d * DEPTHS + shown.z])}</b>
          {shown.d > TODAY ? ', predicted' : ''}
        </span>
        <span style={{ color: color.ink3 }}>
          scale {layer.format(layer.min)} to {layer.format(layer.max)}
        </span>
      </figcaption>
    </figure>
  );
}
