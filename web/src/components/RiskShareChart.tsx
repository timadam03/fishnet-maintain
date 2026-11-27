import { useState, type MouseEvent } from 'react';
import { TODAY, dayLabel } from '../data/model';
import { riskColor } from '../lib/layers';
import type { RiskShare } from '../lib/summary';
import { color } from '../lib/tokens';

interface Props {
  share: RiskShare;
  day: number;
}

/** Read at render time so the colours follow the active theme. */
const series = () =>
  [
    { key: 'critical', label: 'Critical', fill: riskColor(0.8) },
    { key: 'high', label: 'High', fill: riskColor(0.58) },
    { key: 'elevated', label: 'Elevated', fill: riskColor(0.36) },
  ] as const;

const pct = (v: number): string => `${(v * 100).toFixed(v < 0.01 && v > 0 ? 1 : 0)}%`;

/** Stacked area: how much of the net sits at each risk level, day by day, forecast dashed. */
export function RiskShareChart({ share, day }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const n = share.high.length;
  const w = 320;
  const h = 96;
  const totals = Array.from({ length: n }, (_, i) => share.elevated[i] + share.high[i] + share.critical[i]);
  const top = Math.max(0.05, ...totals) * 1.1;
  const x = (i: number): number => (i / (n - 1)) * w;
  const y = (v: number): number => h - (v / top) * h;

  // Stack from the bottom: critical, then high, then elevated.
  let base = new Float32Array(n);
  const SERIES = series();
  const areas = [...SERIES].map((s) => {
    const values = share[s.key];
    const upper = base.map((b, i) => b + values[i]);
    let d = `M${x(0)},${y(upper[0])}`;
    for (let i = 1; i < n; i++) d += `L${x(i).toFixed(1)},${y(upper[i]).toFixed(1)}`;
    for (let i = n - 1; i >= 0; i--) d += `L${x(i).toFixed(1)},${y(base[i]).toFixed(1)}`;
    base = upper;
    return { ...s, d: `${d}Z` };
  });

  const shown = hover ?? day;
  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left) / rect.width) * (n - 1)))));
  };

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: 'block', overflow: 'visible' }} role="img" aria-label="Share of net area at each risk level over time">
        {areas.map((a) => (
          <path key={a.key} d={a.d} fill={a.fill} stroke={color.paper} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
        ))}
        <rect x={x(TODAY)} y={0} width={w - x(TODAY)} height={h} fill={color.paper} opacity={0.45} />
        <line x1={x(TODAY)} x2={x(TODAY)} y1={0} y2={h} stroke={color.ink3} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={w} y1={h} y2={h} stroke={color.lineStrong} vectorEffect="non-scaling-stroke" />
        <line x1={x(shown)} x2={x(shown)} y1={0} y2={h} stroke={color.ink} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="chart-caption num">
        <span>{dayLabel(shown)}{shown > TODAY ? ', predicted' : ''}</span>
        {SERIES.map((s) => (
          <span key={s.key} className="key">
            <span className="swatch" style={{ background: s.fill }} />
            {s.label} {pct(share[s.key][shown])}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
