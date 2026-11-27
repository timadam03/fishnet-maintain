/**
 * Design tokens: the single source for every colour. CSS reads them as custom properties
 * (set on :root in main.tsx); canvas, SVG and three.js code imports them directly.
 *
 * The look borrows from a nautical chart: white paper, pale sea, buff land, navy ink and one
 * signal blue for selection. Red and amber are reserved for hole risk and alarms.
 */
export const color = {
  page: '#f5f7f9',
  paper: '#ffffff',
  ink: '#13202d',
  ink2: '#3f4d5b',
  ink3: '#5f6c79', // 5.3:1 on white
  line: 'rgba(19, 32, 45, 0.10)',
  lineStrong: 'rgba(19, 32, 45, 0.20)',
  sea: '#e3edf4',
  seaDeep: '#d2e2ed',
  land: '#ebe7dc',
  coast: '#9a9a8f',
  signal: '#1d5fa6',
  onDark: '#ffffff', // text and marks on signal blue or critical red
  signalSoft: 'rgba(29, 95, 166, 0.08)',
  live: '#1a7f37',
  // Risk scale (reserved): calm neutral, then sand, amber, orange, red.
  riskLow0: '#eef1f3',
  riskLow1: '#f3e3c3',
  riskElevated: '#f6a85f',
  riskHigh: '#ec6a5c',
  riskCritical: '#c0305f',
  hatch: 'rgba(19, 32, 45, 0.45)',
  // Placeholder "camera frame" for findings: murky water and twine.
  cameraWater: '#2f5d6b',
  cameraTwine: '#c7d3dc',
  cameraTwineWorn: '#f1f4f6',
  unknown: '#f7f8fa',
} as const;

/** Light-to-dark ramps, one hue each. Families: damage drivers are red, biology teal, water blue, data age grey. */
export const blueRamp = ['#eaf2fb', '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281'];
export const redRamp = ['#fbeeea', '#f7d9d0', '#f1bfae', '#eaa38c', '#e2866b', '#d76a4e', '#c95238', '#b43f2a', '#9a3022', '#7d241b'];
export const tealRamp = ['#e9f5f3', '#cfeae5', '#b0dcd4', '#8ecbc0', '#6bb8aa', '#4ba394', '#358b7d', '#277366', '#1c5c52'];
export const greyRamp = ['#f1f3f5', '#dfe3e7', '#c9cfd5', '#b0b8c0', '#959fa9', '#7a8590', '#606b76'];
/**
 * Hole risk as a continuous heat scale ([score, colour] stops), after the perceptually even "magma"
 * map: quiet off-white when calm, through amber and coral to deep magenta and plum.
 * Level thresholds 0.25 / 0.5 / 0.7 fall on amber, coral and magenta.
 */
export const riskStops: Array<[number, string]> = [
  [0, '#f4f3ef'],
  [0.15, '#fbefcf'],
  [0.3, '#fdc98b'],
  [0.5, '#f8875f'],
  [0.7, '#d9466b'],
  [0.85, '#9c2a7d'],
  [1, '#4f1270'],
];

/** Kebab-case CSS custom properties for every colour token. */
export function cssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(color)) out[`--${k.replace(/[A-Z0-9]/g, (m) => `-${m.toLowerCase()}`)}`] = v;
  return out;
}
