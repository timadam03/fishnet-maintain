/**
 * Robot view: what one drone sees, opened by clicking a drone.
 *
 * PLACEHOLDER. A teammate is building the real robot view (live camera, detections, life prediction).
 * To plug it in, replace this component, keeping the props below: the app passes the selected drone,
 * the world and the day, and closes the view through `onClose` (Esc does the same).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { TODAY, cellLabel, dayLabel, type World } from '../data/model';
import type { Drone } from '../data/swarm';
import { explainRisk } from '../data/risk';
import { DEMO_VIDEO } from '../lib/demoVideo';
import { color } from '../lib/tokens';

export interface RobotViewProps {
  world: World;
  day: number;
  drone: Drone;
  onClose: () => void;
}

/** A drawn stand-in for the camera feed: netting drifting past in murky water, detections boxed. */
function useFakeFeed(ref: RefObject<HTMLCanvasElement | null>, live: boolean, detection: string | null): void {
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    const draw = (t: number): void => {
      const w = (canvas.width = canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1));
      const h = (canvas.height = canvas.clientHeight * Math.min(2, window.devicePixelRatio || 1));
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, '#5d6b6d');
      g.addColorStop(1, '#232a2b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // Netting: two families of diagonal twines, drifting slowly as the drone moves along.
      const step = w / 9;
      const drift = (t / 40) % step;
      ctx.strokeStyle = 'rgba(214, 222, 226, 0.55)';
      ctx.lineWidth = Math.max(1.5, w / 500);
      ctx.beginPath();
      for (let o = -h; o < w + h; o += step) {
        ctx.moveTo(o + drift, 0);
        ctx.lineTo(o + drift + h, h);
        ctx.moveTo(o + drift + h, 0);
        ctx.lineTo(o + drift, h);
      }
      ctx.stroke();
      // Particles in the water.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      for (let i = 0; i < 40; i++) {
        const x = ((i * 137.5 + t / 25) % w + w) % w;
        const y = ((i * 89.3 + Math.sin(t / 900 + i) * 20) % h + h) % h;
        ctx.fillRect(x, y, 2, 2);
      }
      if (detection) {
        const bw = w * 0.22;
        const bh = h * 0.28;
        const bx = w * 0.5 - bw / 2 + Math.sin(t / 1200) * 6;
        const by = h * 0.48 - bh / 2;
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = color.riskHigh;
        ctx.lineWidth = Math.max(2, w / 400);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);
        ctx.font = `${Math.round(h / 28)}px 'IBM Plex Sans', system-ui, sans-serif`;
        const tw = ctx.measureText(detection).width;
        ctx.fillStyle = color.riskHigh;
        ctx.fillRect(bx, by - h / 22, tw + 16, h / 22);
        ctx.fillStyle = '#fff';
        ctx.fillText(detection, bx + 8, by - h / 90);
      }
      if (live) raf = requestAnimationFrame(draw);
    };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (live && !reduce) raf = requestAnimationFrame(draw);
    else draw(0);
    return () => cancelAnimationFrame(raf);
  }, [ref, live, detection]);
}

const STATUS: Record<Drone['status'], string> = {
  inspecting: 'Inspecting',
  sampling: 'Sampling water',
  returning: 'Returning to charge',
  docked: 'Docked for repair',
};

/** Gap kept around the video when it fills the stage. */
const THEATER_MARGIN = 24;

/**
 * Zooms the feed from its place in the window to fill the stage, by scaling the same element (so the
 * video keeps playing without a restart). Returns the transform for the current state.
 */
function useTheater(feed: RefObject<HTMLDivElement | null>, expanded: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useEffect(() => {
    if (!expanded) {
      setStyle(undefined);
      return;
    }
    const fit = (): void => {
      const el = feed.current;
      const stage = el?.closest('.stage');
      if (!el || !stage) return;
      // Measure the feed where it sits in the window, without the current transform.
      const box = el.offsetParent instanceof HTMLElement ? el.offsetParent.getBoundingClientRect() : null;
      if (!box) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = box.left + el.offsetLeft - el.offsetParent!.scrollLeft;
      const top = box.top + el.offsetTop - (el.offsetParent as HTMLElement).scrollTop;
      const area = stage.getBoundingClientRect();
      const scale = Math.min((area.width - 2 * THEATER_MARGIN) / w, (area.height - 2 * THEATER_MARGIN) / h);
      const dx = area.left + area.width / 2 - (left + w / 2);
      const dy = area.top + area.height / 2 - (top + h / 2);
      setStyle({ transform: `translate(${dx}px, ${dy}px) scale(${scale})` });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [feed, expanded]);
  return style;
}

/** Floating window over the stage. Esc, the close button, or a click anywhere else on the stage closes it. */
export function RobotView({ world, day, drone, onClose }: RobotViewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pen = drone.penIndex === null ? null : world.pens[drone.penIndex];
  const wantsVideo = pen !== null && (DEMO_VIDEO.pens === null || DEMO_VIDEO.pens.includes(pen.id));
  // Falls back to the drawn feed if the video file is missing or can't play.
  const [videoFailed, setVideoFailed] = useState(false);
  const showVideo = wantsVideo && !videoFailed;
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const theater = useTheater(feedRef, expanded);

  const toggleExpanded = useCallback((): void => setExpanded((x) => !x), []);
  const togglePlay = useCallback((): void => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch((error: unknown) => console.error('Could not play the demo video', error));
    else v.pause();
  }, []);

  // Sound only in the full view: autoplay must start muted, and expanding is a click, so the browser allows it.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !expanded;
  }, [expanded]);

  // While the video fills the stage, Esc zooms back out (instead of closing the window) and space
  // pauses the video (instead of replaying history). Captured before the app's own key handler.
  useEffect(() => {
    if (!showVideo) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && expanded) {
        e.stopImmediatePropagation();
        setExpanded(false);
      } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePlay();
      } else if (e.key === 'f') {
        e.stopImmediatePropagation();
        toggleExpanded();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showVideo, expanded, togglePlay, toggleExpanded]);
  const risk = drone.penIndex !== null && drone.cell !== null ? explainRisk(world.sims[drone.penIndex], drone.cell, Math.min(day, TODAY)) : null;
  const finding =
    pen && drone.cell !== null
      ? world.findings.find((f) => f.penId === pen.id && f.cell === drone.cell && f.detectedDay <= day && !f.steps.some((s) => s.day <= day && (s.status === 'verified' || s.status === 'rejected')))
      : undefined;
  const detection = finding ? `${finding.kind === 'hole' ? 'Opening' : 'Wear'} #${finding.id}, ${Math.round(finding.confidence * 100)}%` : risk && risk.score >= 0.5 ? 'Worn twine?' : null;
  useFakeFeed(ref, day === TODAY && pen !== null && !showVideo, showVideo ? null : detection);

  return (
    <>
      <div className={`robot-backdrop${expanded ? ' dim' : ''}`} onClick={expanded ? toggleExpanded : onClose} aria-hidden="true" />
      <section className={`robot-window${expanded ? ' expanded' : ''}`} role="dialog" aria-label={`${drone.name}, camera and status`}>
        <header className="robot-head">
          <div>
            <h2>{drone.name}</h2>
            <p className="note" style={{ margin: 0 }}>
              {STATUS[drone.status]}
              {pen ? ` in ${pen.name}${drone.cell !== null ? `, ${cellLabel(drone.cell)}` : ''}, ${drone.depth} m` : ' at the feed barge'}
              {day === TODAY ? '' : `, ${dayLabel(day)}`}
            </p>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close robot window">
            Close<kbd>Esc</kbd>
          </button>
        </header>
        <div ref={feedRef} className={`robot-feed${showVideo ? ' video' : ''}`} style={theater}>
          {showVideo ? (
            <>
              <video
                ref={videoRef}
                src={DEMO_VIDEO.src}
                autoPlay
                muted
                loop
                playsInline
                onClick={togglePlay}
                onError={() => setVideoFailed(true)}
                onPlay={() => setPaused(false)}
                onPause={() => setPaused(true)}
                onTimeUpdate={(e) => setProgress(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
                aria-label={`Demo run of ${drone.name} in the Isaac simulation`}
              />
              <span className="robot-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
              <button className="robot-expand" onClick={toggleExpanded} aria-label={expanded ? 'Back to the window' : 'Watch full size'} title={expanded ? 'Back (Esc)' : 'Full size (F)'}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  {expanded ? <path d="M5 1v4H1M9 1v4h4M5 13V9H1M9 13V9h4" /> : <path d="M1 5V1h4M13 5V1H9M1 9v4h4M13 9v4H9" />}
                </svg>
              </button>
              {paused && <span className="robot-paused">Paused</span>}
            </>
          ) : pen ? (
            <canvas ref={ref} aria-label="Simulated camera feed" role="img" />
          ) : (
            <p className="robot-off">Camera off while docked.</p>
          )}
          {pen && <span className="robot-badge">{showVideo ? 'Demo run, Isaac Sim' : day === TODAY ? 'Live, simulated' : 'Recorded, simulated'}</span>}
        </div>
        <p style={{ margin: 0 }}>{drone.task}</p>
        <p className="note" style={{ margin: 0 }}>
          {drone.reason}
        </p>
        <dl className="facts robot-facts">
          {pen && (
            <>
              <dt>Plan rule</dt>
              <dd>{drone.rule === 'sweep' ? 'Coverage sweep' : `${drone.rule}, targeted look`}</dd>
              <dt>Off the net</dt>
              <dd>{drone.standoffM} m</dd>
            </>
          )}
          {drone.partner && (
            <>
              <dt>With</dt>
              <dd>Drone {drone.partner}, other side</dd>
            </>
          )}
          <dt>Battery</dt>
          <dd>{drone.battery}%</dd>
          <dt>Hole risk here</dt>
          <dd>{risk ? Math.round(risk.score * 100) : '–'}</dd>
          <dt>Last message</dt>
          <dd>{drone.lastContactMin === 0 ? 'Just now' : `${drone.lastContactMin} min ago`}</dd>
          <dt>Health</dt>
          <dd>{drone.health}</dd>
          <dt>Next</dt>
          <dd>{drone.next[0]}</dd>
        </dl>
        <div className="placeholder-slot">
          <b>Net life prediction</b>
          <p className="note" style={{ marginTop: 4 }}>
            Comes from the robot-view module being built by the team: remaining strength and expected time to failure for the area in view. The feed
            and this panel are placeholders until it is connected.
          </p>
        </div>
      </section>
    </>
  );
}
