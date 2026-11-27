/**
 * Colours for the natural surroundings of the 3D site (water, land, haze, current), kept apart from
 * the paper-and-ink interface colours so the scene can have life while red stays reserved for risk.
 * Several palettes are offered for comparison.
 */
export interface Environment {
  id: 'gray' | 'fjord' | 'cyan' | 'evening';
  name: string;
  shallow: string;
  deep: string;
  landLow: string;
  landHigh: string;
  contour: string;
  /** Haze in the distance and the stage background behind the scene. */
  haze: string;
  current: string;
  surfaceOpacity: number;
}

export const ENVIRONMENTS: Environment[] = [
  { id: 'gray', name: 'Gray', shallow: '#ebeeee', deep: '#dde3e4', landLow: '#dcd9cf', landHigh: '#f2f1ec', contour: '#9a9995', haze: '#f4f4f2', current: '#1d1d1b', surfaceOpacity: 0.28 },
  { id: 'fjord', name: 'Fjord', shallow: '#dcecee', deep: '#8fb3bd', landLow: '#e9e5d6', landHigh: '#c9d1b8', contour: '#6d8c93', haze: '#eef3f3', current: '#24525d', surfaceOpacity: 0.22 },
  { id: 'cyan', name: 'Chart cyan', shallow: '#cdf2f4', deep: '#63cbd9', landLow: '#f3f1e9', landHigh: '#e2ddcd', contour: '#3f9aab', haze: '#f1f8f8', current: '#156978', surfaceOpacity: 0.18 },
  { id: 'evening', name: 'Evening', shallow: '#e1e6ef', deep: '#97a6c2', landLow: '#ebe4dc', landHigh: '#d3c8ba', contour: '#7a849f', haze: '#eceff4', current: '#34446c', surfaceOpacity: 0.22 },
];

export const environmentById = (id: string | null): Environment => ENVIRONMENTS.find((e) => e.id === id) ?? ENVIRONMENTS[1];
