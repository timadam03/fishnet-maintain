import type { ReactElement } from 'react';
import type { FindingKind } from '../data/model';
import { hashNoise } from '../data/rng';
import { color } from '../lib/tokens';

interface Props {
  kind: FindingKind;
  /** 0 = clean net, 1 = the state at detection. Lets the "earlier inspection" view show less wear. */
  severity: number;
  seed: number;
  outlined: boolean;
}

/**
 * Stand-in for the robot's camera frame: a drawn net patch showing the defect type.
 * Real inspection footage would replace this.
 */
export function MeshImage({ kind, severity, seed, outlined }: Props) {
  const size = 160;
  const step = 16;
  const lines: ReactElement[] = [];
  const cx = size / 2;
  const cy = size / 2;
  const s = Math.max(0, Math.min(1, severity));

  const warp = (x: number, y: number): [number, number] => {
    if (kind !== 'distortion' && kind !== 'chafe') return [x, y];
    const d = Math.hypot(x - cx, y - cy);
    const k = Math.max(0, 1 - d / 60) * s * (kind === 'distortion' ? 9 : 4);
    return [x + k * Math.sign(x - cx), y + k * 0.6];
  };

  for (let i = -size; i < size * 2; i += step) {
    for (let j = 0; j < size + step; j += step) {
      // Diamond mesh: two diagonal bars per knot.
      for (const dir of [1, -1]) {
        const a = warp(i + j, j);
        const b = warp(i + j + step * dir, j + step);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const dist = Math.hypot(mid[0] - cx, mid[1] - cy);
        const n = hashNoise(seed, i * 7 + j, dir + 2);
        if (kind === 'hole' && dist < 26 * s) continue; // broken bars
        let stroke: string = color.cameraTwine;
        let width = 1.6;
        let dash: string | undefined;
        if ((kind === 'fraying' || kind === 'chafe') && dist < 40) {
          const wear = s * (1 - dist / 40);
          width = 1.6 - wear * 0.9;
          stroke = wear > 0.3 ? color.cameraTwineWorn : stroke;
          if (n < wear * 0.7) dash = '2 1.5';
        }
        lines.push(<line key={`${i}-${j}-${dir}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={stroke} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" opacity={0.85} />);
      }
    }
  }

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ display: 'block', borderRadius: 6, background: color.cameraWater }}>
      <defs>
        <clipPath id={`clip-${seed}`}>
          <rect width={size} height={size} />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip-${seed})`}>
        {kind === 'chafe' && <ellipse cx={cx} cy={cy + 6} rx={46} ry={20} fill="rgba(255,255,255,0.10)" opacity={s} />}
        {lines}
      </g>
      {outlined && s > 0.2 && (
        <ellipse cx={cx} cy={cy} rx={kind === 'hole' ? 34 : 50} ry={kind === 'hole' ? 30 : 34} fill="none" stroke={color.riskElevated} strokeWidth={2} strokeDasharray="5 3" />
      )}
    </svg>
  );
}
