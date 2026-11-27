import type { LayerDef } from '../lib/layers';

/**
 * Slim, always-visible legend for the active layer: one gradient bar with its end values, sitting
 * lightly on the stage instead of a boxed card. The data source is in the tooltip.
 */
export function Legend({ layer }: { layer: LayerDef }) {
  const steps = 16;
  const stops = Array.from({ length: steps }, (_, i) => layer.color(layer.min + ((layer.max - layer.min) * i) / (steps - 1)));
  const first = layer.legend[0];
  const last = layer.legend[layer.legend.length - 1];
  return (
    <div className="legend-slim" title={`Source: ${layer.source}`}>
      <span className="legend-name">{layer.label}</span>
      <span className="legend-end">{first.label}</span>
      <span className="legend-bar" style={{ background: `linear-gradient(90deg, ${stops.join(', ')})` }} aria-hidden="true" />
      <span className="legend-end">{last.label}</span>
      {layer.hatchStale && (
        <span className="legend-end">
          <span className="legend-hatch" aria-hidden="true" /> stale
        </span>
      )}
    </div>
  );
}
