import type { LayerDef } from '../lib/layers';

/** Always-visible legend for the active layer, including how stale data is drawn. */
export function Legend({ layer }: { layer: LayerDef }) {
  const steps = 12;
  const swatches = Array.from({ length: steps }, (_, i) => layer.color(layer.min + ((layer.max - layer.min) * i) / (steps - 1)));
  return (
    <div className="floating legend">
      <div className="name">
        {layer.label}
        {layer.unit && <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}> ({layer.unit})</span>}
      </div>
      {layer.id === 'risk' ? (
        <div className="keys">
          {layer.legend.map((l) => (
            <span key={l.label} className="key">
              <span className="swatch" style={{ background: layer.color(l.value) }} />
              {l.label}
            </span>
          ))}
        </div>
      ) : (
        <>
          <div className="scale">
            {swatches.map((c, i) => (
              <span key={i} style={{ background: c }} />
            ))}
          </div>
          <div className="ticks num">
            {layer.legend.map((l) => (
              <span key={l.label}>{l.label}</span>
            ))}
          </div>
        </>
      )}
      {layer.hatchStale && (
        <div className="keys">
          <span className="key">
            <span className="swatch hatch-swatch" />
            Not seen for 14+ days, value uncertain
          </span>
        </div>
      )}
      <div className="source">{layer.source}</div>
    </div>
  );
}
