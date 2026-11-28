import { useMemo, useState, type Dispatch } from 'react';
import {
  ANGLE_SECTORS,
  CELLS,
  DAYS,
  STORM_FORECAST_DAY,
  TODAY,
  WALL_ROWS,
  cellIndex,
  cellLabel,
  cellRow,
  dayLabel,
  type Finding,
  type FindingStatus,
  type World,
} from '../data/model';
import { RISK_LEVELS, explainRisk, riskLevel, type RiskLevel } from '../data/risk';
import { CONE_DRONE_DOCKED_DAY } from '../data/simulate';
import { FROZEN_SENSOR, sensorProfile } from '../data/water';
import { riskColor } from '../lib/layers';
import { isConfirmedHole, statusAt, type Action, type Review } from '../lib/state';
import { riskShareSeries, topRiskAreas, type PenSummary, type RiskArea, type RiskShare } from '../lib/summary';
import { color } from '../lib/tokens';
import { DepthProfile } from './DepthProfile';
import { DepthTimeChart } from './DepthTimeChart';
import { RiskShareChart } from './RiskShareChart';
import { MeshImage } from './MeshImage';
import { Sparkline } from './Sparkline';

interface CommonProps {
  world: World;
  day: number;
  reviews: Record<number, Review>;
  dispatch: Dispatch<Action>;
}

const levelLabel = (l: RiskLevel): string => RISK_LEVELS.find((x) => x.level === l)?.label ?? l;
const score100 = (s: number): number => Math.round(s * 100);
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (deg: number): string => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function Score({ score }: { score: number }) {
  const level = riskLevel(score);
  return (
    <span className="score" style={{ background: riskColor(score), color: level === 'critical' ? color.onDark : color.ink }} title={`${levelLabel(level)} risk`}>
      {score100(score)}
    </span>
  );
}

type Severity = 'critical' | 'warning' | 'info';

/** Status shape + colour, never colour alone. */
function StatusIcon({ severity }: { severity: Severity }) {
  const label = severity === 'critical' ? 'Critical' : severity === 'warning' ? 'Warning' : 'Info';
  return (
    <svg className="status-icon" width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label}>
      {severity === 'critical' && (
        <>
          <circle cx="7" cy="7" r="6.5" fill={color.riskCritical} />
          <path d="M7 3.5v4.2M7 9.6v.6" stroke={color.onDark} strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
      {severity === 'warning' && (
        <>
          <path d="M7 1L13.3 12.5H.7Z" fill={color.riskElevated} />
          <path d="M7 5v3.6M7 10.3v.4" stroke={color.ink} strokeWidth="1.4" strokeLinecap="round" />
        </>
      )}
      {severity === 'info' && (
        <>
          <circle cx="7" cy="7" r="6" fill="none" stroke={color.ink3} strokeWidth="1.3" />
          <path d="M7 6.2v3.8M7 4v.4" stroke={color.ink3} strokeWidth="1.4" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

const KIND_LABEL: Record<Finding['kind'], string> = {
  hole: 'Hole',
  chafe: 'Chafe from weights',
  fraying: 'Fraying or thinning',
  distortion: 'Mesh distortion',
};

/** A hole finding nobody has confirmed yet is a possible opening, not a hole. */
const kindLabel = (f: Finding, status: FindingStatus): string => (f.kind === 'hole' && status === 'unreviewed' ? 'Possible opening' : KIND_LABEL[f.kind]);

const STATUS_LABEL: Record<FindingStatus, string> = {
  unreviewed: 'Needs review',
  confirmed: 'Confirmed',
  rejected: 'Rejected as false alarm',
  'work-order': 'Repair ordered',
  repaired: 'Repaired, waiting for re-inspection',
  verified: 'Fixed and verified',
};

/* ---------------- Site ---------------- */

interface SiteProps extends CommonProps {
  summaries: PenSummary[];
  open: Finding[];
  stormPeak: RiskArea[];
  siteShare: RiskShare;
}

interface Alert {
  severity: Severity;
  title: string;
  meta: string;
  onClick: () => void;
}

export function SitePanel({ world, day, summaries, open, stormPeak, siteShare, reviews, dispatch }: SiteProps) {
  const top = useMemo(() => topRiskAreas(summaries, 5), [summaries]);
  const seen = summaries.reduce((a, s) => a + s.seenWeekPct, 0) / summaries.length;
  const holes = open.filter((f) => isConfirmedHole(f, day, reviews));
  const unreviewed = open.filter((f) => statusAt(f, day, reviews) === 'unreviewed');
  const penIndexOf = (penId: number): number => world.pens.findIndex((p) => p.id === penId);

  const alerts: Alert[] = [];
  for (const f of holes) {
    alerts.push({
      severity: 'critical',
      title: `Hole in ${world.pens[penIndexOf(f.penId)].name}`,
      meta: `${cellLabel(f.cell)}. ${STATUS_LABEL[statusAt(f, day, reviews)]}.`,
      onClick: () => dispatch({ type: 'finding', penIndex: penIndexOf(f.penId), cell: f.cell, findingId: f.id }),
    });
  }
  if (unreviewed.length > 0) {
    const f = unreviewed[0];
    alerts.push({
      severity: 'warning',
      title: unreviewed.length === 1 ? `New detection to review in ${world.pens[penIndexOf(f.penId)].name}` : `${unreviewed.length} new detections to review`,
      meta: unreviewed.map((x) => `${kindLabel(x, 'unreviewed')} (#${x.id})`).join(', '),
      onClick: () => dispatch({ type: 'finding', penIndex: penIndexOf(f.penId), cell: f.cell, findingId: f.id }),
    });
  }
  if (day >= STORM_FORECAST_DAY - 7 && day < STORM_FORECAST_DAY && stormPeak.length > 0) {
    const a = stormPeak[0];
    alerts.push({
      severity: 'warning',
      title: `Storm expected ${dayLabel(STORM_FORECAST_DAY)}`,
      meta: `Current up to about 60 cm/s. ${stormPeak.length} areas are predicted to reach high risk, worst in ${world.pens[a.penIndex].name}.`,
      onClick: () => {
        dispatch({ type: 'cell', penIndex: a.penIndex, cell: a.cell });
        dispatch({ type: 'layer', layer: 'risk' });
        dispatch({ type: 'day', day: STORM_FORECAST_DAY });
      },
    });
  }
  if (day >= CONE_DRONE_DOCKED_DAY + 14) {
    alerts.push({
      severity: 'warning',
      title: 'Pen 8 bottom cone not inspected',
      meta: `No images for ${day - CONE_DRONE_DOCKED_DAY} days while its drone is in repair.`,
      onClick: () => {
        dispatch({ type: 'cell', penIndex: 7, cell: cellIndex(WALL_ROWS, 0) });
        dispatch({ type: 'layer', layer: 'risk' }); // stale areas are hatched on the risk layer
      },
    });
  }
  if (day > FROZEN_SENSOR.sinceDay) {
    alerts.push({
      severity: 'info',
      title: `Oxygen sensor frozen in Pen ${FROZEN_SENSOR.penId}`,
      meta: `The ${FROZEN_SENSOR.depth} m sensor has repeated one value since ${dayLabel(FROZEN_SENSOR.sinceDay)}.`,
      onClick: () => dispatch({ type: 'pen', penIndex: penIndexOf(FROZEN_SENSOR.penId) }),
    });
  }

  const summary =
    holes.length > 0
      ? `${holes.length} hole${holes.length > 1 ? 's' : ''} open.`
      : top[0] && top[0].score >= 0.5
        ? `No holes. Highest risk is ${levelLabel(riskLevel(top[0].score)).toLowerCase()} in ${world.pens[top[0].penIndex].name}.`
        : 'No holes, and no area above elevated risk.';

  return (
    <>
      <section className="section">
        <h2>{world.siteName}</h2>
        <p className="lede">
          {summary} {day > TODAY ? 'Values for this date are predicted.' : ''}
        </p>
      </section>
      <section className="section">
        <h3>Needs attention</h3>
        {alerts.length === 0 ? (
          <p className="empty">Nothing needs attention.</p>
        ) : (
          <div className="list">
            {alerts.map((a) => (
              <button key={a.title} className="row-btn" onClick={a.onClick}>
                <StatusIcon severity={a.severity} />
                <span className="body">
                  <span className="title" style={{ display: 'block' }}>
                    {a.title}
                  </span>
                  <span className="meta">{a.meta}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="section">
        <h3>Highest hole risk{day > TODAY ? ', predicted' : ''}</h3>
        <div className="list">
          {top.map((a) => {
            const r = explainRisk(world.sims[a.penIndex], a.cell, day);
            const main = [...r.factors].filter((f) => f.group !== 'consequence').sort((x, y) => y.weight - x.weight)[0];
            return (
              <button
                key={`${a.penIndex}-${a.cell}`}
                className="row-btn"
                onClick={() => {
                  dispatch({ type: 'cell', penIndex: a.penIndex, cell: a.cell });
                  dispatch({ type: 'layer', layer: 'risk' });
                }}
              >
                <Score score={a.score} />
                <span className="body">
                  <span className="title" style={{ display: 'block' }}>
                    {world.pens[a.penIndex].name}, {cellLabel(a.cell)}
                  </span>
                  <span className="meta">{main?.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="section">
        <h3>Net area at risk, all pens</h3>
        <RiskShareChart share={siteShare} day={day} />
      </section>
      <section className="section">
        <h3>Conditions</h3>
        <dl className="facts">
          <dt>Current</dt>
          <dd>
            {Math.round(world.env.currentSpeed[day])}&nbsp;cm/s towards {compass(world.env.currentDir[day])}
          </dd>
          <dt>Waves</dt>
          <dd>{world.env.waveHeight[day].toFixed(1)}&nbsp;m</dd>
          <dt>Surface water</dt>
          <dd>{world.env.surfaceTemp[day].toFixed(1)}&nbsp;°C</dd>
          <dt>Net inspected in the last 7 days</dt>
          <dd>{Math.round(seen * 100)}%</dd>
        </dl>
        <div style={{ marginTop: 16 }}>
          <Sparkline values={Array.from(world.env.currentSpeed)} day={day} min={0} max={65} format={(v) => `${Math.round(v)} cm/s`} />
        </div>
      </section>
    </>
  );
}

/* ---------------- Pen ---------------- */

interface PenProps extends CommonProps {
  penIndex: number;
  summary: PenSummary;
  penFindings: Finding[];
}

export function PenPanel({ world, day, penIndex, summary, penFindings, reviews, dispatch }: PenProps) {
  const pen = world.pens[penIndex];
  const share = useMemo(() => riskShareSeries(world, [penIndex], DAYS), [world, penIndex]);
  const [measure, setMeasure] = useState<'oxygen' | 'temperature'>('oxygen');
  const profile = sensorProfile(world, pen.id, day);
  const age = day - pen.netInstalledDay;
  const lastCleaning = [...world.operations].reverse().find((o) => o.kind === 'cleaning' && o.penId === pen.id && o.day <= day);
  const sim = world.sims[penIndex];
  const wallCells = WALL_ROWS * ANGLE_SECTORS;
  let fouling = 0;
  for (let c = 0; c < wallCells; c++) fouling += sim.fouling[day * CELLS + c];
  fouling /= wallCells;

  const visible = penFindings.filter((f) => f.detectedDay <= day).slice(-8).reverse();
  return (
    <>
      <section className="section">
        <h2>{pen.name}</h2>
        <p className="lede">
          {levelLabel(riskLevel(summary.maxRisk))} risk at worst, at {cellLabel(summary.maxCell)}. Select an area of the net to see why.
        </p>
      </section>
      <section className="section">
        <dl className="facts">
          <dt>Net</dt>
          <dd>{pen.netId}</dd>
          <dt>Material</dt>
          <dd>{pen.material}</dd>
          <dt>Days in the sea</dt>
          <dd>{age}</dd>
          <dt>Last cleaned</dt>
          <dd>{lastCleaning ? `${dayLabel(lastCleaning.day)}, ${day - lastCleaning.day} days ago` : 'Not in this period'}</dd>
          <dt>Fouling on the wall</dt>
          <dd>{Math.round(fouling * 100)}%</dd>
          <dt>Fish</dt>
          <dd>{new Intl.NumberFormat('en-GB').format(pen.fishCount)}</dd>
          <dt>Net inspected in the last 7 days</dt>
          <dd>{Math.round(summary.seenWeekPct * 100)}%</dd>
        </dl>
      </section>
      <section className="section">
        <h3>Net area at risk</h3>
        <RiskShareChart share={share} day={day} />
      </section>
      <section className="section">
        <h3 style={{ display: 'flex', alignItems: 'center' }}>
          Water by depth, 90 days and forecast
          <span className="tabs-inline" role="group" aria-label="Measure">
            <button aria-pressed={measure === 'oxygen'} onClick={() => setMeasure('oxygen')}>
              Oxygen
            </button>
            <button aria-pressed={measure === 'temperature'} onClick={() => setMeasure('temperature')}>
              Temperature
            </button>
          </span>
        </h3>
        <DepthTimeChart world={world} penId={pen.id} day={day} measure={measure} />
      </section>
      <section className="section">
        <h3>Sensor string, {dayLabel(day)}</h3>
        <DepthProfile readings={profile} />
      </section>
      <section className="section">
        <h3>Findings</h3>
        {visible.length === 0 ? <p className="empty">No findings in this period.</p> : <FindingList world={world} findings={visible} day={day} reviews={reviews} dispatch={dispatch} />}
      </section>
    </>
  );
}

function FindingList({ world, findings, day, reviews, dispatch }: CommonProps & { findings: Finding[] }) {
  return (
    <div className="list">
      {findings.map((f) => {
        const status = statusAt(f, day, reviews);
        const pi = world.pens.findIndex((p) => p.id === f.penId);
        const closed = status === 'verified' || status === 'rejected';
        return (
          <button key={f.id} className="row-btn" onClick={() => dispatch({ type: 'finding', penIndex: pi, cell: f.cell, findingId: f.id })}>
            <StatusIcon severity={closed ? 'info' : f.severity} />
            <span className="body">
              <span className="title" style={{ display: 'block' }}>
                {kindLabel(f, status)} <span style={{ color: color.ink3, fontWeight: 400 }}>#{f.id}</span>
              </span>
              <span className="meta">
                {dayLabel(f.detectedDay)}, {cellLabel(f.cell)}. {STATUS_LABEL[status]}.
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- Cell ---------------- */

interface CellProps extends CommonProps {
  penIndex: number;
  cell: number;
  cellFindings: Finding[];
}

export function CellPanel({ world, day, penIndex, cell, cellFindings, reviews, dispatch }: CellProps) {
  const sim = world.sims[penIndex];
  const r = explainRisk(sim, cell, day);
  const { series, band } = useMemo(() => {
    const s = new Float32Array(DAYS);
    const b: Array<[number, number]> = [];
    for (let d = 0; d < DAYS; d++) {
      const e = explainRisk(sim, cell, d);
      s[d] = e.score;
      b.push(e.range);
    }
    return { series: s, band: b };
  }, [sim, cell]);

  const groups = (['condition', 'exposure'] as const).map((g) => ({ g, items: r.factors.filter((f) => f.group === g).sort((a, b) => b.weight - a.weight) }));
  const pen = world.pens[penIndex];
  const seen = r.coverageAge === null ? 'never inspected' : r.coverageAge === 0 ? 'inspected today' : `inspected ${r.coverageAge} days ago`;
  return (
    <>
      <section className="section">
        <h2>{cellLabel(cell)}</h2>
        <p className="lede">
          {pen.name}, {cellRow(cell) >= WALL_ROWS ? 'bottom cone' : 'net wall'}
        </p>
        <div className="headline">
          <Score score={r.score} />
          <div>
            <div style={{ fontWeight: 600 }}>
              {r.knownHole ? 'Hole open' : `${levelLabel(r.level)} hole risk`}
              {r.predicted ? ', predicted' : ''}
            </div>
            <div className="num" style={{ color: color.ink3, fontSize: 13 }}>
              Likely between {score100(r.range[0])} and {score100(r.range[1])}, {seen}
            </div>
          </div>
        </div>
      </section>
      <section className="section">
        <h3>Recommended action</h3>
        <p className={`advice ${r.stale ? 'stale' : ''}`} style={{ margin: 0 }}>
          {r.recommendation}
        </p>
      </section>
      <section className="section">
        <h3>Why this score</h3>
        <div className="formula" aria-label={`Condition ${r.condition.toFixed(2)} times exposure ${r.exposure.toFixed(2)} times consequence ${r.consequence.toFixed(2)}`}>
          <span className="term" title="How worn the netting is, from the last inspection">
            <b>{r.condition.toFixed(2)}</b>
            <span>Condition</span>
          </span>
          <span className="op">×</span>
          <span className="term" title="Load, contact and handling the area gets, from live sensors and logs">
            <b>{r.exposure.toFixed(2)}</b>
            <span>Exposure</span>
          </span>
          <span className="op">×</span>
          <span className="term" title="How bad a hole here would be: depth and fish density">
            <b>{r.consequence.toFixed(2)}</b>
            <span>Consequence</span>
          </span>
        </div>
        {groups.map(({ g, items }) => (
          <div key={g} className="factor-group">
            <div className="group-label">{g === 'condition' ? 'Condition, from the robot camera at the last inspection' : 'Exposure, from sensors and logs'}</div>
            {items.map((f) => (
              <div key={f.label} className="factor">
                <span>{f.label}</span>
                <div className="bar" title={`${Math.round(f.weight * 100)}% of ${g}`}>
                  <span style={{ width: `${Math.round(f.weight * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        ))}
        <p className="note">The weights are examples until they are tuned on hole maps from net service stations and on repair logs.</p>
      </section>
      <section className="section">
        <h3>Risk over time</h3>
        <Sparkline values={series} band={band} day={day} format={(v) => `${score100(v)}`} color={color.riskHigh} refs={[{ value: 0.5, label: 'high' }]} />
      </section>
      <section className="section">
        <h3>Findings here</h3>
        {cellFindings.length === 0 ? <p className="empty">No findings in this area yet.</p> : <FindingList world={world} findings={cellFindings} day={day} reviews={reviews} dispatch={dispatch} />}
      </section>
    </>
  );
}

/* ---------------- Finding ---------------- */

interface FindingProps extends CommonProps {
  finding: Finding;
}

export function FindingPanel({ world, day, finding: f, reviews, dispatch }: FindingProps) {
  const status = statusAt(f, day, reviews);
  const pen = world.pens.find((p) => p.id === f.penId);
  const canReview = status === 'unreviewed' && day >= TODAY && !reviews[f.id];
  const steps = f.steps.filter((s) => s.day <= day);
  const review = reviews[f.id];
  const earlierDay = Math.max(0, f.detectedDay - 14);
  return (
    <>
      <section className="section">
        <h2>
          {kindLabel(f, status)} <span style={{ color: color.ink3, fontWeight: 400 }}>#{f.id}</span>
        </h2>
        <p className="lede">
          {pen?.name}, {cellLabel(f.cell)}, {f.side} face. Found {dayLabel(f.detectedDay)} with {Math.round(f.confidence * 100)}% confidence.
        </p>
      </section>
      <section className="section">
        <div className="figure-pair">
          <figure>
            <MeshImage kind={f.kind} severity={0.25} seed={f.id + 1000} outlined={false} />
            <figcaption>Same spot, {dayLabel(earlierDay)}</figcaption>
          </figure>
          <figure>
            <MeshImage kind={f.kind} severity={1} seed={f.id} outlined />
            <figcaption>{dayLabel(f.detectedDay)}, defect outlined</figcaption>
          </figure>
        </div>
        <p className="note">Drawings stand in for the robot’s camera frames in this demo.</p>
      </section>
      {canReview && (
        <section className="section">
          <h3>Is this real damage?</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => dispatch({ type: 'review', findingId: f.id, review: 'confirmed' })}>
              Confirm damage<kbd>C</kbd>
            </button>
            <button className="btn" onClick={() => dispatch({ type: 'review', findingId: f.id, review: 'rejected' })}>
              Reject<kbd>R</kbd>
            </button>
          </div>
          <p className="note">Each answer is saved as a training example for the detection model.</p>
        </section>
      )}
      <section className="section">
        <h3>Progress</h3>
        <ol className="steps">
          {steps.map((s) => (
            <li key={s.status} className="done">
              <div>
                <div>{STATUS_LABEL[s.status]}</div>
                <div className="when">
                  {dayLabel(s.day)}. {s.note}
                </div>
              </div>
            </li>
          ))}
          {review && (
            <li className="done">
              <div>
                <div>{STATUS_LABEL[review]}</div>
                <div className="when">{dayLabel(TODAY)}. By you, in this session</div>
              </div>
            </li>
          )}
          {status !== 'verified' && status !== 'rejected' && (
            <li>
              <div style={{ color: color.ink3 }}>Next: {status === 'unreviewed' ? 'review' : status === 'repaired' ? 're-inspect and verify' : 'repair'}</div>
            </li>
          )}
        </ol>
        {f.kind === 'hole' && f.openedDay !== undefined && (
          <p className="note">
            The hole opened around {dayLabel(f.openedDay)}, {f.detectedDay - f.openedDay} days before it was found.
          </p>
        )}
      </section>
    </>
  );
}
