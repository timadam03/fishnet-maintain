import { memo } from 'react';
import { DAYS, TODAY, dayLabel, type Finding, type Operation } from '../data/model';
import type { Action } from '../lib/state';
import { color } from '../lib/tokens';

interface Props {
  day: number;
  playing: boolean;
  operations: Operation[];
  findings: Finding[];
  /** When a pen is open, its cleanings are shown as ticks too. */
  penId: number | null;
  dispatch: (a: Action) => void;
}

const x = (d: number): string => `${(d / (DAYS - 1)) * 100}%`;

/** Global time control: 90 days of history, now, and a 7-day forecast marked as predicted. */
export const TimeBar = memo(function TimeBar({ day, playing, operations, findings, penId, dispatch }: Props) {
  const mode = day === TODAY ? 'Live' : day > TODAY ? 'Forecast, predicted' : 'History';
  const ops = operations.filter((o) => o.kind !== 'cleaning' || o.penId === penId);
  const holes = findings.filter((f) => f.kind === 'hole');

  return (
    <div className="timebar-inner">
      <button className="icon-btn" onClick={() => dispatch({ type: 'play', playing: !playing })} aria-label={playing ? 'Pause replay' : 'Replay history'} title="Replay (space)">
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2" y="1" width="3" height="10" fill="currentColor" />
            <rect x="7" y="1" width="3" height="10" fill="currentColor" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 1L11 6L3 11Z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="time-readout">
        <div className="date">{dayLabel(day)} 2026</div>
        <div className="mode">
          {day === TODAY && <span style={{ width: 7, height: 7, borderRadius: '50%', background: color.live }} aria-hidden="true" />}
          {mode}
        </div>
      </div>
      <div className="track">
        <svg aria-hidden="true">
          <rect x={x(TODAY)} y="10" width={`${((DAYS - 1 - TODAY) / (DAYS - 1)) * 100}%`} height="24" fill={color.page} stroke={color.lineStrong} strokeDasharray="3 3" />
          <line x1="0" x2={x(TODAY)} y1="22" y2="22" stroke={color.lineStrong} strokeWidth="2" />
          <line x1="0" x2={x(Math.min(day, TODAY))} y1="22" y2="22" stroke={color.ink} strokeWidth="2" />
          {Array.from({ length: DAYS }, (_, d) => d)
            .filter((d) => d % 14 === TODAY % 14 && d !== TODAY)
            .map((d) => (
              <text key={d} className="tick-label" x={x(d)} y="44" fill={color.ink3} fontSize="11" textAnchor="middle">
                {dayLabel(d)}
              </text>
            ))}
          <text x={x(TODAY)} y="44" fill={color.ink} fontSize="11" fontWeight={500} textAnchor="middle">
            Now
          </text>
          {ops.map((o, i) => (
            <line
              key={i}
              x1={x(o.day)}
              x2={x(o.day)}
              y1={o.kind === 'cleaning' ? 18 : 13}
              y2={o.kind === 'cleaning' ? 26 : 31}
              stroke={o.kind === 'storm' ? color.signal : color.ink3}
              strokeWidth={o.kind === 'storm' ? 3 : 1.25}
            >
              <title>{`${dayLabel(o.day)}: ${o.label}`}</title>
            </line>
          ))}
          {holes.map((f) => (
            <circle key={f.id} cx={x(f.detectedDay)} cy="22" r="4" fill={color.riskCritical}>
              <title>{`${dayLabel(f.detectedDay)}: hole #${f.id} found`}</title>
            </circle>
          ))}
          <circle className="thumb" cx={x(day)} cy="22" r="7" fill={color.paper} stroke={color.ink} strokeWidth="2" />
        </svg>
        <input type="range" min={0} max={DAYS - 1} step={1} value={day} onChange={(e) => dispatch({ type: 'day', day: Number(e.target.value) })} aria-label="Date" aria-valuetext={`${dayLabel(day)}, ${mode}`} />
      </div>
      <button className="btn" onClick={() => dispatch({ type: 'day', day: TODAY })} disabled={day === TODAY}>
        Back to now
      </button>
    </div>
  );
});
