import { useState, type MouseEvent } from 'react';
import { TODAY, dayLabel } from '../data/model';

interface Props {
  values: ArrayLike<number>;
  /** Optional uncertainty band per day (drawn for forecast days). */
  band?: Array<[number, number]>;
  day: number;
  min?: number;
  max?: number;
  height?: number;
  format: (v: number) => string;
  color?: string;
  /** Horizontal reference lines, e.g. risk thresholds. */
  refs?: Array<{ value: number; label: string }>;
}

/** Small trend chart: history solid, forecast dashed with its range, crosshair + tooltip on hover. */
export function Sparkline({ values, band, day, min = 0, max = 1, height = 56, format, color = 'var(--ink)', refs = [] }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const w = 340;
  const h = height;
  const pad = 4;
  const x = (i: number): number => (i / (n - 1)) * w;
  const y = (v: number): number => pad + (1 - (Math.min(max, Math.max(min, v)) - min) / (max - min)) * (h - 2 * pad);

  const path = (from: number, to: number): string => {
    let d = '';
    for (let i = from; i <= to; i++) d += `${i === from ? 'M' : 'L'}${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`;
    return d;
  };

  let bandPath = '';
  if (band && n > TODAY + 1) {
    const upper: string[] = [];
    const lower: string[] = [];
    for (let i = TODAY; i < n; i++) {
      upper.push(`${x(i).toFixed(1)},${y(band[i][1]).toFixed(1)}`);
      lower.unshift(`${x(i).toFixed(1)},${y(band[i][0]).toFixed(1)}`);
    }
    bandPath = `M${upper.join('L')}L${lower.join('L')}Z`;
  }

  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left) / rect.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const shown = hover ?? day;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: 'block', overflow: 'visible' }}>
        <rect x={x(TODAY)} y={0} width={w - x(TODAY)} height={h} fill="var(--page)" />
        {refs.map((r) => (
          <line key={r.label} x1={0} x2={w} y1={y(r.value)} y2={y(r.value)} stroke="var(--line-strong)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        ))}
        {bandPath && <path d={bandPath} fill={color} opacity={0.12} />}
        <path d={path(0, Math.min(TODAY, n - 1))} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {n > TODAY + 1 && <path d={path(TODAY, n - 1)} fill="none" stroke={color} strokeWidth={2} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
        <line x1={x(shown)} x2={x(shown)} y1={0} y2={h} stroke="var(--ink-3)" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="num" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 4, color: 'var(--ink-3)' }}>
        <span>{dayLabel(0)}</span>
        <span>
          {dayLabel(shown)}: <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{format(values[shown])}</b>
          {shown > TODAY ? ' (predicted)' : ''}
        </span>
        <span>{dayLabel(n - 1)}</span>
      </div>
    </div>
  );
}
