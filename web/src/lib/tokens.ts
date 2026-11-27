/**
 * Design tokens: the single source for every colour ("paper and ink" theme).
 *
 * CSS reads the colours as custom properties on :root (set in main.tsx); canvas, SVG and three.js
 * code imports them directly. The palette is nearly monochrome: warm warning colours (amber, orange,
 * burnt red) appear only where hole risk rises, so danger stands out without reading as blood.
 */
export interface Palette {
  page: string;
  paper: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  lineStrong: string;
  sea: string;
  seaDeep: string;
  land: string;
  coast: string;
  /** Accent for selection and the swarm drones. */
  signal: string;
  signalSoft: string;
  /** Text and marks on the accent or on critical red. */
  onDark: string;
  live: string;
  riskLow0: string;
  riskLow1: string;
  riskElevated: string;
  riskHigh: string;
  riskCritical: string;
  hatch: string;
  /** Placeholder "camera frame" for findings: murky water and twine. */
  cameraWater: string;
  cameraTwine: string;
  cameraTwineWorn: string;
  unknown: string;
}

export const color: Palette = {
  page: '#f4f4f2',
  paper: '#ffffff',
  ink: '#1d1d1b',
  ink2: '#3e3e3b',
  ink3: '#62615d',
  line: 'rgba(29, 29, 27, 0.10)',
  lineStrong: 'rgba(29, 29, 27, 0.20)',
  sea: '#ebeeee',
  seaDeep: '#dde3e4',
  land: '#dcd9cf',
  coast: '#9a9995',
  signal: '#1d1d1b',
  signalSoft: 'rgba(29, 29, 27, 0.06)',
  onDark: '#ffffff',
  live: '#3c7a3c',
  riskLow0: '#f2f2f0',
  riskLow1: '#dcdbd7',
  riskElevated: '#f0c56e',
  riskHigh: '#ec9a3c',
  riskCritical: '#c2421f',
  hatch: 'rgba(29, 29, 27, 0.45)',
  cameraWater: '#4b5356',
  cameraTwine: '#c7d3dc',
  cameraTwineWorn: '#f1f4f6',
  unknown: '#f7f7f5',
};

/** Light-to-dark ramps by family: water (oxygen, temperature), damage drivers, biology, data age. */
export const waterRamp = ['#f1f1ef', '#e0e3e4', '#cdd3d6', '#b4bcc0', '#98a3a9', '#7b878e', '#5c6970', '#434e55', '#2b3439'];
export const damageRamp = ['#f1f1ef', '#dcdbd8', '#c2c1bd', '#a5a4a0', '#878682', '#6a6966', '#4d4c4a', '#2f2f2d'];
export const bioRamp = ['#f1f2ef', '#dde1d8', '#c3cabb', '#a6b09c', '#89957f', '#6d7a64', '#53604c'];
export const ageRamp = ['#f4f4f2', '#e3e3e0', '#cbcbc7', '#aeada9', '#8f8e8a', '#706f6b'];
/** Hole risk as a continuous scale of [score, colour] stops; levels at 0.25 / 0.5 / 0.7. */
export const riskStops: Array<[number, string]> = [
  [0, '#f2f2f0'],
  [0.2, '#efe6cf'],
  [0.35, '#f0c56e'],
  [0.5, '#ec9a3c'],
  [0.7, '#d9652a'],
  [1, '#a8371f'],
];

/** Kebab-case CSS custom properties for every colour token. */
export function cssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(color)) out[`--${k.replace(/[A-Z0-9]/g, (m) => `-${m.toLowerCase()}`)}`] = v;
  return out;
}
