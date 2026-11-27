/**
 * Colours for the natural surroundings in 3D (water, land, haze, current): the "fjord" palette.
 * Kept apart from the paper-and-ink interface colours so the scene has life while red stays
 * reserved for risk.
 */
export const environment = {
  shallow: '#dcecee',
  deep: '#8fb3bd',
  landLow: '#e9e5d6',
  landHigh: '#c9d1b8',
  contour: '#6d8c93',
  /** Haze in the distance and the stage background. */
  haze: '#eef3f3',
  current: '#24525d',
  surfaceOpacity: 0.22,
};

export type Environment = typeof environment;

/** How opaque the nets are in 3D: enough to read the heatmap, light enough to see inside. */
export const NET_OPACITY = 0.78;
