/**
 * Design tokens: the single source for every colour, in switchable themes.
 *
 * CSS reads the colours as custom properties on :root; canvas, SVG and three.js code reads `color`,
 * the ramps and `riskStops` directly. `applyTheme` swaps the values in place, and the app remounts its
 * views so canvases and the 3D scene repaint. In every theme, warm colours are kept for hole risk and
 * alarms only.
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

export type ThemeId = 'current' | 'stone' | 'fjord' | 'paper';

export interface Theme {
  id: ThemeId;
  name: string;
  short: string;
  palette: Palette;
  /** Light-to-dark ramps by family: water (oxygen, temperature), damage drivers, biology, data age. */
  water: string[];
  damage: string[];
  bio: string[];
  age: string[];
  /** Hole risk as a continuous scale of [score, colour] stops; levels at 0.25 / 0.5 / 0.7. */
  risk: Array<[number, string]>;
}

const camera = { cameraWater: '#2f5d6b', cameraTwine: '#c7d3dc', cameraTwineWorn: '#f1f4f6', onDark: '#ffffff' };

export const THEMES: Theme[] = [
  {
    id: 'current',
    name: 'Chart blue and magma',
    short: 'Current',
    palette: {
      ...camera,
      page: '#f5f7f9',
      paper: '#ffffff',
      ink: '#13202d',
      ink2: '#3f4d5b',
      ink3: '#5f6c79',
      line: 'rgba(19, 32, 45, 0.10)',
      lineStrong: 'rgba(19, 32, 45, 0.20)',
      sea: '#e3edf4',
      seaDeep: '#d2e2ed',
      land: '#ebe7dc',
      coast: '#9a9a8f',
      signal: '#1d5fa6',
      signalSoft: 'rgba(29, 95, 166, 0.08)',
      live: '#1a7f37',
      riskLow0: '#eef1f3',
      riskLow1: '#f3e3c3',
      riskElevated: '#f6a85f',
      riskHigh: '#ec6a5c',
      riskCritical: '#c0305f',
      hatch: 'rgba(19, 32, 45, 0.45)',
      unknown: '#f7f8fa',
    },
    water: ['#eaf2fb', '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281'],
    damage: ['#fbeeea', '#f7d9d0', '#f1bfae', '#eaa38c', '#e2866b', '#d76a4e', '#c95238', '#b43f2a', '#9a3022', '#7d241b'],
    bio: ['#e9f5f3', '#cfeae5', '#b0dcd4', '#8ecbc0', '#6bb8aa', '#4ba394', '#358b7d', '#277366', '#1c5c52'],
    age: ['#f1f3f5', '#dfe3e7', '#c9cfd5', '#b0b8c0', '#959fa9', '#7a8590', '#606b76'],
    risk: [
      [0, '#f4f3ef'],
      [0.15, '#fbefcf'],
      [0.3, '#fdc98b'],
      [0.5, '#f8875f'],
      [0.7, '#d9466b'],
      [0.85, '#9c2a7d'],
      [1, '#4f1270'],
    ],
  },
  {
    id: 'stone',
    name: 'Stone and ember',
    short: 'A',
    palette: {
      ...camera,
      cameraWater: '#4a5a52',
      page: '#f3f1ec',
      paper: '#fdfcf9',
      ink: '#26231f',
      ink2: '#4a453e',
      ink3: '#6b655b',
      line: 'rgba(38, 35, 31, 0.10)',
      lineStrong: 'rgba(38, 35, 31, 0.20)',
      sea: '#ebe8e1',
      seaDeep: '#e2ded5',
      land: '#dcd5c5',
      coast: '#a39a88',
      signal: '#26231f',
      signalSoft: 'rgba(38, 35, 31, 0.06)',
      live: '#4f7a3a',
      riskLow0: '#f4efe6',
      riskLow1: '#f1e3c6',
      riskElevated: '#f0b665',
      riskHigh: '#e07b3c',
      riskCritical: '#b23a22',
      hatch: 'rgba(38, 35, 31, 0.45)',
      unknown: '#f6f4ef',
    },
    water: ['#eef0ee', '#dfe5e3', '#c9d2cf', '#afbdb9', '#94a6a3', '#7a8f8c', '#5f7774', '#4a6261', '#34494a'],
    damage: ['#f7efe6', '#f1dcc4', '#e9c19c', '#dea173', '#cf814f', '#b8623a', '#97492b', '#723420'],
    bio: ['#f0f1e6', '#dde0c6', '#c3c9a0', '#a5ae7b', '#86925d', '#6a7746', '#525e36'],
    age: ['#f3f1ec', '#e2dfd8', '#cbc6bc', '#aea89c', '#8f897d', '#706a60'],
    risk: [
      [0, '#f4efe6'],
      [0.15, '#f3e6cc'],
      [0.3, '#f3c98b'],
      [0.5, '#e8823f'],
      [0.7, '#c4502a'],
      [0.85, '#9c3320'],
      [1, '#6e1f14'],
    ],
  },
  {
    id: 'fjord',
    name: 'Fjord slate',
    short: 'B',
    palette: {
      ...camera,
      page: '#eef2f4',
      paper: '#ffffff',
      ink: '#1f2a31',
      ink2: '#3d4a52',
      ink3: '#5d6b74',
      line: 'rgba(31, 42, 49, 0.10)',
      lineStrong: 'rgba(31, 42, 49, 0.20)',
      sea: '#e6ecef',
      seaDeep: '#dbe3e7',
      land: '#dfe2dc',
      coast: '#95a09f',
      signal: '#2a6f86',
      signalSoft: 'rgba(42, 111, 134, 0.08)',
      live: '#2f7d5b',
      riskLow0: '#f2f3f2',
      riskLow1: '#f1ece7',
      riskElevated: '#f2a585',
      riskHigh: '#e7735a',
      riskCritical: '#b5332e',
      hatch: 'rgba(31, 42, 49, 0.45)',
      unknown: '#f5f7f8',
    },
    water: ['#eaf1f3', '#d3e3e8', '#bcd3da', '#9dbfca', '#7fa9b7', '#5b91a4', '#3c7d93', '#2a6f86', '#1f5a6d', '#17434f'],
    damage: ['#fbefea', '#f6d9cd', '#efbfab', '#e6a088', '#da8068', '#c8624f', '#ad4a3c', '#8a372f'],
    bio: ['#ecf3f0', '#d4e6de', '#b7d5c8', '#97c1b0', '#77ab97', '#5a917e', '#437766'],
    age: ['#f1f3f4', '#dde2e5', '#c5ccd1', '#a9b3ba', '#8c98a1', '#6f7c86'],
    risk: [
      [0, '#f2f3f2'],
      [0.15, '#f1ece7'],
      [0.3, '#f2c0a6'],
      [0.5, '#e7735a'],
      [0.7, '#c8433a'],
      [0.85, '#9a2a2a'],
      [1, '#6a1c1f'],
    ],
  },
  {
    id: 'paper',
    name: 'Paper and ink',
    short: 'C',
    palette: {
      ...camera,
      cameraWater: '#4b5356',
      page: '#f4f4f2',
      paper: '#ffffff',
      ink: '#1d1d1b',
      ink2: '#3e3e3b',
      ink3: '#62615d',
      line: 'rgba(29, 29, 27, 0.10)',
      lineStrong: 'rgba(29, 29, 27, 0.20)',
      sea: '#efefec',
      seaDeep: '#e7e7e3',
      land: '#e2e1dc',
      coast: '#9a9995',
      signal: '#1d1d1b',
      signalSoft: 'rgba(29, 29, 27, 0.06)',
      live: '#3c7a3c',
      riskLow0: '#f2f2f0',
      riskLow1: '#dcdbd7',
      riskElevated: '#b3b1ac',
      riskHigh: '#e0634b',
      riskCritical: '#c32f1d',
      hatch: 'rgba(29, 29, 27, 0.45)',
      unknown: '#f7f7f5',
    },
    water: ['#f1f1ef', '#e0e3e4', '#cdd3d6', '#b4bcc0', '#98a3a9', '#7b878e', '#5c6970', '#434e55', '#2b3439'],
    damage: ['#f1f1ef', '#dcdbd8', '#c2c1bd', '#a5a4a0', '#878682', '#6a6966', '#4d4c4a', '#2f2f2d'],
    bio: ['#f1f2ef', '#dde1d8', '#c3cabb', '#a6b09c', '#89957f', '#6d7a64', '#53604c'],
    age: ['#f4f4f2', '#e3e3e0', '#cbcbc7', '#aeada9', '#8f8e8a', '#706f6b'],
    risk: [
      [0, '#f2f2f0'],
      [0.2, '#dcdbd7'],
      [0.35, '#b3b1ac'],
      [0.5, '#e0634b'],
      [0.7, '#c32f1d'],
      [1, '#7a160b'],
    ],
  },
];

const initial = THEMES[0];

/** Live values of the active theme (mutated in place by `applyTheme`). */
export const color: Palette = { ...initial.palette };
export const waterRamp: string[] = [...initial.water];
export const damageRamp: string[] = [...initial.damage];
export const bioRamp: string[] = [...initial.bio];
export const ageRamp: string[] = [...initial.age];
export const riskStops: Array<[number, string]> = initial.risk.map(([v, c]) => [v, c]);

function replace<T>(target: T[], source: T[]): void {
  target.splice(0, target.length, ...source);
}

/** Kebab-case CSS custom properties for every colour token. */
export function cssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(color)) out[`--${k.replace(/[A-Z0-9]/g, (m) => `-${m.toLowerCase()}`)}`] = v;
  return out;
}

export function themeById(id: string | null): Theme {
  return THEMES.find((t) => t.id === id) ?? initial;
}

/** Makes `id` the active theme: updates the shared colour values and the CSS custom properties. */
export function applyTheme(id: ThemeId): void {
  const theme = themeById(id);
  Object.assign(color, theme.palette);
  replace(waterRamp, theme.water);
  replace(damageRamp, theme.damage);
  replace(bioRamp, theme.bio);
  replace(ageRamp, theme.age);
  replace(
    riskStops,
    theme.risk.map(([v, c]): [number, string] => [v, c]),
  );
  for (const [name, value] of Object.entries(cssVariables())) document.documentElement.style.setProperty(name, value);
}
