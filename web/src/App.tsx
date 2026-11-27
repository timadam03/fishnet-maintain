import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { environment } from './lib/environment';
import { DAYS, STORM_FORECAST_DAY, TODAY, cellLabel, type World } from './data/model';
import { generateWorld } from './data/simulate';
import { CellPanel, FindingPanel, PenPanel, SitePanel } from './components/SidePanel';
import { swarmState } from './data/swarm';
import { Legend } from './components/Legend';
import { PenView } from './components/PenView';
import { RobotView } from './components/RobotView';
import { TimeBar } from './components/TimeBar';
import { layerById } from './lib/layers';
import { fromHash, initialState, openFindings, reducer, statusAt, toHash } from './lib/state';
import { riskShareSeries, summarisePen, topRiskAreas } from './lib/summary';
import { color } from './lib/tokens';

const SiteScene3D = lazy(() => import('./components/SiteScene3D'));

const world: World = generateWorld();
const stormSummaries = world.pens.map((_, i) => summarisePen(world, i, STORM_FORECAST_DAY));
const stormPeak = topRiskAreas(stormSummaries, 20, 20).filter((a) => a.score >= 0.5);
const siteShare = riskShareSeries(
  world,
  world.pens.map((_, i) => i),
  DAYS,
);

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState, (s) => ({ ...s, ...fromHash(window.location.hash, world.pens.length) }));
  const { penIndex, cell, findingId, day, layer, playing, reviews } = state;
  const summaries = useMemo(() => world.pens.map((_, i) => summarisePen(world, i, day)), [day]);
  const open = useMemo(() => openFindings(world, day, reviews), [day, reviews]);
  const pen = penIndex === null ? null : world.pens[penIndex];
  const finding = findingId === null ? null : (world.findings.find((f) => f.id === findingId) ?? null);
  const drones = useMemo(() => swarmState(world, day, open), [day, open]);
  const drone = state.droneId === null ? null : (drones.find((d) => d.id === state.droneId) ?? null);
  const penOpen = useMemo(() => (pen ? open.filter((f) => f.penId === pen.id) : []), [open, pen]);

  // Keep the view in the URL: moving between levels adds a history entry (so Back works); time and layer replace it.
  // Browsers limit how often history can be written (Safari throws), so day changes from scrubbing are debounced.
  const lastLevel = useRef(`${penIndex}/${cell}/${findingId}`);
  useEffect(() => {
    if (playing) return;
    const level = `${penIndex}/${cell}/${findingId}`;
    const write = (): void => {
      const hash = toHash({ penIndex, cell, findingId, day, layer });
      if (hash === window.location.hash) return;
      const url = `${window.location.pathname}${window.location.search}${hash}`;
      try {
        if (level !== lastLevel.current) window.history.pushState(null, '', url);
        else window.history.replaceState(null, '', url);
      } catch (err) {
        console.warn('Could not save the view in the URL', err);
      }
      lastLevel.current = level;
    };
    if (level !== lastLevel.current) {
      write();
      return;
    }
    const t = window.setTimeout(write, 300);
    return () => window.clearTimeout(t);
  }, [penIndex, cell, findingId, day, layer, playing]);
  useEffect(() => {
    const onPop = (): void => {
      const location = fromHash(window.location.hash, world.pens.length);
      lastLevel.current = `${location.penIndex}/${location.cell}/${location.findingId}`;
      dispatch({ type: 'restore', location });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Replay: one day every 350 ms.
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => dispatch({ type: 'day', day: state.day + 1 }), 350);
    return () => window.clearInterval(t);
  }, [playing, state.day]);

  // Keyboard: ←/→ move in time, Esc goes up a level, space replays, C/R review the open finding.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const inInput = e.target instanceof HTMLInputElement;
      if (e.key === 'ArrowLeft' && !inInput) dispatch({ type: 'day', day: day - 1 });
      else if (e.key === 'ArrowRight' && !inInput) dispatch({ type: 'day', day: day + 1 });
      else if (e.key === 'Escape') dispatch({ type: 'up' });
      else if (e.key === ' ' && !inInput && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof SVGElement)) {
        e.preventDefault();
        dispatch({ type: 'play', playing: !playing });
      } else if (finding && day >= TODAY && statusAt(finding, day, reviews) === 'unreviewed' && !reviews[finding.id]) {
        if (e.key === 'c') dispatch({ type: 'review', findingId: finding.id, review: 'confirmed' });
        if (e.key === 'r') dispatch({ type: 'review', findingId: finding.id, review: 'rejected' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [day, playing, finding, reviews]);

  const common = { world, day, reviews, dispatch };
  let side;
  if (finding) side = <FindingPanel {...common} finding={finding} />;
  else if (pen && penIndex !== null && cell !== null)
    side = <CellPanel {...common} penIndex={penIndex} cell={cell} cellFindings={world.findings.filter((f) => f.penId === pen.id && f.cell === cell && f.detectedDay <= day)} />;
  else if (pen && penIndex !== null) side = <PenPanel {...common} penIndex={penIndex} summary={summaries[penIndex]} penFindings={world.findings.filter((f) => f.penId === pen.id)} />;
  else side = <SitePanel {...common} summaries={summaries} open={open} stormPeak={stormPeak} siteShare={siteShare} />;

  const crumbs: Array<{ label: string; onClick: () => void }> = [{ label: world.siteName, onClick: () => dispatch({ type: 'site' }) }];
  if (pen && penIndex !== null) crumbs.push({ label: pen.name, onClick: () => dispatch({ type: 'pen', penIndex }) });
  if (pen && penIndex !== null && cell !== null) crumbs.push({ label: cellLabel(cell), onClick: () => dispatch({ type: 'cell', penIndex, cell }) });
  if (finding) crumbs.push({ label: `Finding #${finding.id}`, onClick: () => dispatch({ type: 'finding', penIndex: penIndex ?? 0, cell: finding.cell, findingId: finding.id }) });

  const penRisk = useMemo(() => summaries.map((s) => s.maxRisk), [summaries]);
  const openPen = useCallback((i: number): void => dispatch({ type: 'pen', penIndex: i }), []);
  const selectDrone = useCallback((id: string): void => dispatch({ type: 'drone', id }), []);

  return (
    <div className="app">
      <main className="stage" style={{ background: environment.haze }}>
        <Suspense fallback={<p className="stage-hint">Loading 3D site…</p>}>
          <SiteScene3D world={world} day={day} live={day === TODAY} open={open} drones={drones} focusPen={penIndex} penRisk={penRisk} env={environment} onOpenPen={openPen} onSelectDrone={selectDrone} />
        </Suspense>
        {pen && penIndex !== null && (
          <PenView
            key={penIndex}
            world={world}
            penIndex={penIndex}
            day={day}
            layerId={layer}
            cell={cell}
            view={state.view}
            sliceDepth={state.sliceDepth}
            findings={penOpen}
            reviews={reviews}
            drones={drones}
            selectedDrone={state.droneId}
            dispatch={dispatch}
          />
        )}
        {!pen && (
          <div className="stage-controls bottom-left">
            <Legend layer={layerById('risk')} />
          </div>
        )}
        {drone && <RobotView world={world} day={day} drone={drone} onClose={() => dispatch({ type: 'drone', id: null })} />}
        <div className="timebar">
          <TimeBar day={day} playing={playing} operations={world.operations} findings={world.findings} penId={pen?.id ?? null} dispatch={dispatch} />
        </div>
      </main>

      <aside className="side" aria-label="Details">
        <header className="side-header">
          <div className="brand">
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="8.5" fill="none" stroke={color.ink} strokeWidth="1.5" />
              <path d="M10 1.5v17M1.5 10h17" stroke={color.ink} strokeWidth="0.8" />
              <circle cx="10" cy="10" r="4" fill={color.signal} />
            </svg>
            Shoal
            <span className="status-text" title="Every value in this demo comes from a simulation. Feed barge connected.">
              <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true">
                <circle cx="4" cy="4" r="4" fill={color.live} />
              </svg>
              Demo data
            </span>
          </div>
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={c.label} style={{ display: 'inline-flex', alignItems: 'center' }}>
                {i > 0 && (
                  <span className="sep" aria-hidden="true">
                    ›
                  </span>
                )}
                {i === crumbs.length - 1 ? (
                  <span className="crumb-current" aria-current="page">
                    {c.label}
                  </span>
                ) : (
                  <button onClick={c.onClick}>{c.label}</button>
                )}
              </span>
            ))}
          </nav>
        </header>
        {side}
      </aside>
    </div>
  );
}
