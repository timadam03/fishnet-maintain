/**
 * Colours for the natural surroundings in 3D: a Nordic fjord in late autumn. Kept apart from the
 * paper-and-ink interface colours so the scene has character while red stays reserved for risk.
 */
export const environment = {
  shallow: '#cfe4e6',
  deep: '#7ea5b0',
  sand: '#d9d2bb',
  meadow: '#93a87e',
  forest: '#5a7456',
  rock: '#9c9a91',
  snow: '#f3f5f5',
  contour: '#55767e',
  /** Haze at the horizon (fog colour) and the sky above it. */
  haze: '#dfe9ee',
  sky: '#cfe0ea',
  current: '#24525d',
  /**
   * Fjord water as it looks around the pens from the site view (seabed through the surface), and a
   * lighter tone further off. The pen view uses the same colours, so flying in keeps the water.
   */
  water: '#8ea7b0',
  waterFar: '#a6bcc1',
  seabed: '#86a0a8',
  surfaceOpacity: 0.2,
  /** HDPE floating collars are dark grey-black on real farms. */
  collar: '#3a4144',
  collarHover: '#55767e',
};

export type Environment = typeof environment;

/** How opaque the nets are in 3D: enough to read the heatmap, light enough to see inside. */
export const NET_OPACITY = 0.78;
