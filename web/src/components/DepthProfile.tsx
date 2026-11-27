import { dayLabel } from '../data/model';
import type { SensorReading } from '../data/water';

interface ChartProps {
  readings: SensorReading[];
  pick: (r: SensorReading) => number;
  min: number;
  max: number;
  unit: string;
  title: string;
}

/** One vertical profile: value on x, depth on y (surface at the top). */
function ProfileChart({ readings, pick, min, max, unit, title }: ChartProps) {
  const w = 160;
  const h = 150;
  const left = 26;
  const top = 8;
  const bottom = 18;
  const maxDepth = 20;
  const x = (v: number): number => left + ((v - min) / (max - min)) * (w - left - 8);
  const y = (d: number): number => top + (d / maxDepth) * (h - top - bottom);
  const live = readings.filter((r) => !r.stale);
  const path = live.map((r, i) => `${i ? 'L' : 'M'}${x(pick(r)).toFixed(1)},${y(r.depth).toFixed(1)}`).join('');
  return (
    <div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginBottom: 2 }}>{title}</div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block' }}>
        {[0, 5, 10, 15, 20].map((d) => (
          <g key={d}>
            <line x1={left} x2={w - 8} y1={y(d)} y2={y(d)} stroke="var(--line)" />
            <text x={left - 4} y={y(d) + 3} fill="var(--ink-3)" fontSize={9} textAnchor="end">
              {d} m
            </text>
          </g>
        ))}
        {[min, (min + max) / 2, max].map((v) => (
          <text key={v} x={x(v)} y={h - 4} fill="var(--ink-3)" fontSize={9} textAnchor="middle">
            {v}
            {unit}
          </text>
        ))}
        <path d={path} fill="none" stroke="var(--ink)" strokeWidth={1.5} strokeLinejoin="round" />
        {readings.map((r) => (
          <g key={r.depth}>
            <circle
              cx={x(pick(r))}
              cy={y(r.depth)}
              r={4}
              fill={r.stale ? 'var(--paper)' : 'var(--ink)'}
              stroke={r.stale ? 'var(--ink-3)' : 'var(--paper)'}
              strokeWidth={r.stale ? 1.5 : 2}
              strokeDasharray={r.stale ? '2 1.5' : undefined}
            >
              <title>
                {r.depth} m: {pick(r).toFixed(1)}
                {unit} {r.stale ? `(sensor frozen since ${dayLabel(r.readingDay)})` : ''}
              </title>
            </circle>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Oxygen and temperature from surface to bottom: two separate charts, never one dual-axis chart. */
export function DepthProfile({ readings }: { readings: SensorReading[] }) {
  const stale = readings.filter((r) => r.stale);
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <ProfileChart readings={readings} pick={(r) => r.oxygen} min={50} max={110} unit="%" title="Oxygen (% saturation)" />
        <ProfileChart readings={readings} pick={(r) => r.temperature} min={6} max={16} unit="°" title="Temperature (°C)" />
      </div>
      {stale.map((r) => (
        <p key={r.depth} className="note">
          The {r.depth}&nbsp;m sensor has sent the same value since {dayLabel(r.readingDay)}. It is drawn hollow and left out of the line until someone checks it.
        </p>
      ))}
    </div>
  );
}
