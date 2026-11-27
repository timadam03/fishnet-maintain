/**
 * Robot view: what one drone sees, opened by clicking a drone.
 *
 * PLACEHOLDER. A teammate is building the real robot view (live camera, detections, life prediction).
 * To plug it in, replace this component, keeping the props below: the app passes the selected drone,
 * the world and the day, and closes the view through `onClose` (Esc does the same).
 */
import { useEffect, useRef, type RefObject } from 'react';
import { TODAY, cellLabel, dayLabel, type World } from '../data/model';
import type { Drone } from '../data/swarm';
import { explainRisk } from '../data/risk';
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

/** Floating window over the stage. Esc, the close button, or a click anywhere else on the stage closes it. */
export function RobotView({ world, day, drone, onClose }: RobotViewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pen = drone.penIndex === null ? null : world.pens[drone.penIndex];
  const risk = drone.penIndex !== null && drone.cell !== null ? explainRisk(world.sims[drone.penIndex], drone.cell, Math.min(day, TODAY)) : null;
  const finding =
    pen && drone.cell !== null
      ? world.findings.find((f) => f.penId === pen.id && f.cell === drone.cell && f.detectedDay <= day && !f.steps.some((s) => s.day <= day && (s.status === 'verified' || s.status === 'rejected')))
      : undefined;
  const detection = finding ? `${finding.kind === 'hole' ? 'Hole' : 'Wear'} #${finding.id}, ${Math.round(finding.confidence * 100)}%` : risk && risk.score >= 0.5 ? 'Worn twine?' : null;
  useFakeFeed(ref, day === TODAY && pen !== null, detection);

  return (
    <>
      <div className="robot-backdrop" onClick={onClose} aria-hidden="true" />
      <section className="robot-window" role="dialog" aria-label={`${drone.name}, camera and status`}>
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
        <div className="robot-feed">
          {pen ? <canvas ref={ref} aria-label="Simulated camera feed" role="img" /> : <p className="robot-off">Camera off while docked.</p>}
          {pen && <span className="robot-badge">{day === TODAY ? 'Live, simulated' : 'Recorded, simulated'}</span>}
        </div>
        <p style={{ margin: 0 }}>{drone.task}</p>
        <p className="note" style={{ margin: 0 }}>
          {drone.reason}
        </p>
        <dl className="facts robot-facts">
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
