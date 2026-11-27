/**
 * Site version 4: the whole farm in 3D. Every pen's net hangs in the water painted with hole risk,
 * the feed barge floats at the edge, and the swarm drones circle the pens they work on. Click a pen
 * to open it. Renders on demand; drones animate in live mode only.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PEN_RADIUS_M, ROWS, WALL_DEPTH_M, type Finding, type World } from '../data/model';
import type { Drone } from '../data/swarm';
import { paintNetTexture } from '../lib/heat';
import { computeLayerGrid, layerById } from '../lib/layers';
import { buildNetGeometry, netPoint } from '../lib/netGeometry';
import { ROBOT_RENDER_ORDER, robotGeometry, robotMaterial } from '../lib/robotModel';
import { NET_OPACITY, environment as env } from '../lib/environment';
import { TERRAIN, heightAt, paintTerrain } from '../lib/terrain';
import { color } from '../lib/tokens';

interface Props {
  world: World;
  day: number;
  live: boolean;
  /** Confirmed open holes, drawn on the nets and pinned with "!". */
  holes: Finding[];
  drones: Drone[];
  /** The pen the user opened: the camera flies down into it, then the pen view takes over. */
  focusPen: number | null;
  /** Worst hole risk per pen today, for the pins above pens that need attention. */
  penRisk: number[];
  onOpenPen: (penIndex: number) => void;
  onSelectDrone: (id: string) => void;
}

/** Overview camera, and the camera offset the pen view starts from (so the hand-over is seamless). */
const OVERVIEW = { position: new THREE.Vector3(60, 470, 780), target: new THREE.Vector3(0, -15, -20) };
const PEN_OFFSET = new THREE.Vector3(85, 9, 95);
const PEN_TARGET = new THREE.Vector3(0, -15, 0);

const R = PEN_RADIUS_M;
/** Feed barge position (waterline) and the cradle positions along its swarm-dock pontoon. */
const BARGE = new THREE.Vector3(-30, 0, -165);
const DOCK_SLOTS = [-8, 0, 8];

/** Pen centre in metres, centred on the farm. */
function penPosition(world: World, i: number): THREE.Vector3 {
  const p = world.pens[i];
  return new THREE.Vector3(p.x - 450, 0, p.y - 212);
}

interface SceneCtx {
  render: () => void;
  textures: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture }[];
  collars: THREE.Mesh<THREE.TorusGeometry, THREE.MeshLambertMaterial>[];
  droneGroup: THREE.Group;
  animate: (t: number) => void;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}

export default function SiteScene3D({ world, day, live, holes, drones, focusPen, penRisk, onOpenPen, onSelectDrone }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<SceneCtx | null>(null);
  const dronesRef = useRef(drones);
  dronesRef.current = drones;
  const handlers = useRef({ onOpenPen, onSelectDrone });
  handlers.current = { onOpenPen, onSelectDrone };
  const timeRef = useRef(0);
  const compassRef = useRef<HTMLDivElement>(null);
  const bargeLabelRef = useRef<HTMLSpanElement>(null);
  const [hoverPen, setHoverPen] = useState<number | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = 'block';
    wrap.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    // Gentle haze far away, tinted like the sky, so the land fades out instead of turning to dust.
    scene.fog = new THREE.Fog(env.haze, 1400, 4800);
    scene.background = null;
    scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(-120, 260, 160);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(34, 1, 1, 9000);
    camera.position.copy(OVERVIEW.position);

    // Surroundings: shore, headland, island and seabed, painted like a sea chart.
    const terrainCanvas = document.createElement('canvas');
    terrainCanvas.width = 2048;
    terrainCanvas.height = 1664;

    paintTerrain(terrainCanvas, env); // painted here, so the scene never shows an unpainted (black) terrain
    const terrainTexture = new THREE.CanvasTexture(terrainCanvas);
    terrainTexture.colorSpace = THREE.SRGBColorSpace;
    terrainTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const terrainGeometry = new THREE.PlaneGeometry(TERRAIN.width, TERRAIN.depth, 320, 260);
    const tp = terrainGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < tp.count; i++) tp.setZ(i, heightAt(tp.getX(i), -tp.getY(i)));
    terrainGeometry.computeVertexNormals();
    const terrain = new THREE.Mesh(terrainGeometry, new THREE.MeshLambertMaterial({ map: terrainTexture }));
    terrain.rotation.x = -Math.PI / 2; // local +y becomes north (−z)
    scene.add(terrain);
    // A faint water surface over the underwater terrain; land rises through it.
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(TERRAIN.width, TERRAIN.depth),
      new THREE.MeshBasicMaterial({ color: env.shallow, transparent: true, opacity: env.surfaceOpacity, depthWrite: false }),
    );
    surface.rotation.x = -Math.PI / 2;
    scene.add(surface);


    // Pens: textured net, collar, mooring frame.
    const netGeometry = buildNetGeometry();
    const textures: SceneCtx['textures'] = [];
    const nets: THREE.Mesh[] = [];
    const collars: SceneCtx['collars'] = [];
    world.pens.forEach((_, i) => {
      const pos = penPosition(world, i);
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = ROWS * 20;
      const texture = new THREE.CanvasTexture(canvas);
      texture.flipY = false;
      texture.wrapS = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push({ canvas, texture });
      // See-through nets, so the drones and the inside stay visible from outside.
      const net = new THREE.Mesh(netGeometry, new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, opacity: NET_OPACITY, depthWrite: false }));
      net.position.copy(pos);
      net.userData.penIndex = i;
      scene.add(net);
      nets.push(net);
      const collar = new THREE.Mesh(new THREE.TorusGeometry(R + 1.5, 0.9, 8, 72), new THREE.MeshLambertMaterial({ color: env.collar }));
      collar.rotation.x = Math.PI / 2;
      collar.position.copy(pos).setY(0.6);
      scene.add(collar);
      collars.push(collar);
      const frame = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(2 * R + 44, 2 * R + 44)),
        new THREE.LineBasicMaterial({ color: color.ink, transparent: true, opacity: 0.15 }),
      );
      frame.rotation.x = -Math.PI / 2;
      frame.position.copy(pos).setY(0.2);
      scene.add(frame);
    });

    // Feed barge with the swarm dock: a hull with deckhouse and feed silos, and a pontoon on the pen
    // side where drones charge in cradles.
    const bargeGroup = new THREE.Group();
    const lambert = (c: string): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color: c });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(40, 5, 22), lambert(env.collar));
    hull.position.set(0, 0.5, 0);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(40, 1.2, 22), lambert(color.paper));
    deck.position.set(0, 3.6, 0);
    const deckhouse = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 14), lambert(color.paper));
    deckhouse.position.set(-12, 7.7, 0);
    bargeGroup.add(hull, deck, deckhouse);
    for (const [x, z] of [
      [2, -5],
      [2, 5],
      [11, -5],
      [11, 5],
    ]) {
      const silo = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 9, 16), lambert('#c9cfd1'));
      silo.position.set(x, 8.7, z);
      bargeGroup.add(silo);
    }
    const pontoon = new THREE.Mesh(new THREE.BoxGeometry(12, 1.4, 26), lambert('#b9bfc1'));
    pontoon.position.set(26, 0.4, 0);
    bargeGroup.add(pontoon);
    DOCK_SLOTS.forEach((z) => {
      const cradle = new THREE.Mesh(new THREE.BoxGeometry(9, 0.6, 6), lambert(env.collar));
      cradle.position.set(26, 1.4, z);
      bargeGroup.add(cradle);
    });
    bargeGroup.position.copy(BARGE);
    scene.add(bargeGroup);

    const droneGroup = new THREE.Group();
    scene.add(droneGroup);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(OVERVIEW.target);
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 120;
    controls.maxDistance = 2200;
    controls.update();

    const placeLabels = (): void => {
      const box = labelsRef.current;
      if (!box) return;
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      world.pens.forEach((_, i) => {
        const el = box.children[i] as HTMLElement | undefined;
        if (!el) return;
        const s = penPosition(world, i).setY(6).project(camera);
        el.style.transform = `translate(${((s.x + 1) / 2) * w}px, ${((1 - s.y) / 2) * h}px)`;
      });
      const barge = bargeLabelRef.current;
      if (barge) {
        const s = BARGE.clone().setY(16).project(camera);
        barge.style.transform = `translate(${((s.x + 1) / 2) * w}px, ${((1 - s.y) / 2) * h}px)`;
      }
    };
    const render = (): void => {
      renderer.render(scene, camera);
      placeLabels();
      // Compass: north is −z; rotate the needle as the camera turns.
      const off = camera.position.clone().sub(controls.target);
      const heading = Math.atan2(off.x, off.z);
      if (compassRef.current) compassRef.current.style.transform = `rotate(${(-heading * 180) / Math.PI}deg)`;
    };
    controls.addEventListener('change', render);

    const animate = (t: number): void => {
      timeRef.current = t;
      let docked = 0;
      dronesRef.current.forEach((d, k) => {
        const m = droneGroup.children[k];
        if (!m) return;
        if (d.penIndex === null) {
          // Docked: resting in the next free cradle on the barge's pontoon, nose to the pens.
          const slot = docked++;
          m.position.set(BARGE.x + 26, BARGE.y + 4, BARGE.z + DOCK_SLOTS[slot % DOCK_SLOTS.length]);
          m.lookAt(m.position.x + 1, m.position.y, m.position.z);
          return;
        }
        // Inside the net, sweeping either side of its area.
        const centre = penPosition(world, d.penIndex);
        const base = (d.cell === null ? 0 : (d.cell % 24) * 15 + 7.5) + d.viewDeg;
        const angle = base + (d.rule === 'sweep' ? 14 * Math.sin(t / 3 + k) : 1.5 * Math.sin(t / 2 + k));
        // Site scale: drones are drawn 8× life size, so keep them a little further off the net.
        const local = netPoint(Math.min(d.depth, WALL_DEPTH_M), angle, Math.min(0.85, 1 - d.standoffM / R));
        m.position.copy(centre).add(local);
        // Face along the net (tangent to the pen), the way it sweeps.
        const a = (angle * Math.PI) / 180;
        m.lookAt(m.position.x + Math.cos(a), m.position.y, m.position.z + Math.sin(a));
      });
      render();
    };

    const resize = (): void => {
      const { clientWidth: w, clientHeight: h } = wrap;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (e: PointerEvent): { pen?: number; drone?: string } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([droneGroup, ...nets, ...collars], true)[0];
      if (!hit) return null;
      if (hit.object.userData.droneId) return { drone: hit.object.userData.droneId as string };
      const netIndex = nets.indexOf(hit.object as THREE.Mesh);
      const collarIndex = collars.indexOf(hit.object as SceneCtx['collars'][number]);
      const pen = netIndex >= 0 ? netIndex : collarIndex;
      return pen >= 0 ? { pen } : null;
    };
    let down: [number, number] | null = null;
    const el = renderer.domElement;
    const onDown = (e: PointerEvent): void => {
      down = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent): void => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4) {
        const hit = pick(e);
        if (hit?.drone) handlers.current.onSelectDrone(hit.drone);
        else if (hit?.pen !== undefined) handlers.current.onOpenPen(hit.pen);
      }
      down = null;
    };
    const onMove = (e: PointerEvent): void => {
      if (e.buttons) return;
      const hit = pick(e);
      el.style.cursor = hit ? 'pointer' : 'grab';
      setHoverPen(hit?.pen ?? null);
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);

    ctx.current = { render, textures, collars, droneGroup, animate, camera, controls };
    resize();

    return () => {
      ro.disconnect();
      controls.dispose();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      scene.traverse((o) => {
        if (o.userData.shared) return; // the shared robot model stays loaded for the next view
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
        }
      });
      textures.forEach((t) => t.texture.dispose());
      terrainTexture.dispose();
      renderer.dispose();
      el.remove();
      ctx.current = null;
    };
    // The scene is built once per world; day-dependent parts update in the effects below.
    // (world is a module constant in the app.)
  }, [world]);

  // Paint each net with that day's hole risk and open holes.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const layer = layerById('risk');
    c.textures.forEach(({ canvas, texture }, i) => {
      const grid = computeLayerGrid(world, i, day, 'risk');
      paintNetTexture(
        canvas,
        grid,
        layer,
        holes.filter((f) => f.penId === world.pens[i].id),
      );
      texture.needsUpdate = true;
    });
    c.animate(timeRef.current);
  }, [world, day, holes]);


  // Highlight the hovered pen's collar.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.collars.forEach((m, i) => m.material.color.set(i === hoverPen ? env.collarHover : env.collar));
    c.render();
  }, [hoverPen]);

  // Drone bodies: the shared BlueROV2-style model, enlarged so it reads at site scale.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.droneGroup.clear();
    for (const d of drones) {
      const g = new THREE.Group();
      g.userData.droneId = d.id;
      const body = new THREE.Mesh(robotGeometry, robotMaterial);
      body.userData.shared = true;
      body.renderOrder = ROBOT_RENDER_ORDER;
      body.userData.droneId = d.id;
      body.scale.setScalar(8);
      g.add(body);
      c.droneGroup.add(g);
    }
    c.animate(timeRef.current);
  }, [drones]);

  // Fly into the opened pen, or back out to the whole site.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const toTarget = focusPen === null ? OVERVIEW.target.clone() : penPosition(world, focusPen).add(PEN_TARGET);
    const toPosition = focusPen === null ? OVERVIEW.position.clone() : toTarget.clone().add(PEN_OFFSET);
    const fromTarget = c.controls.target.clone();
    const fromPosition = c.camera.position.clone();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();
    let raf = 0;
    const step = (now: number): void => {
      const t = reduce ? 1 : Math.min(1, (now - start) / 900);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in and out
      c.controls.target.lerpVectors(fromTarget, toTarget, k);
      c.camera.position.lerpVectors(fromPosition, toPosition, k);
      c.controls.update();
      c.render();
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [focusPen, world]);

  // Live animation at about 30 frames a second.
  useEffect(() => {
    const c = ctx.current;
    if (!c || !live || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let last = 0;
    const start = performance.now() - timeRef.current * 1000;
    const tick = (now: number): void => {
      if (now - last > 33) {
        last = now;
        c.animate((now - start) / 1000);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live]);

  return (
    <div ref={wrapRef} className={`site3d${focusPen !== null ? ' focused' : ''}`}>
      <div className="compass" aria-hidden="true">
        <div ref={compassRef} className="compass-needle">
          <span>N</span>
        </div>
      </div>
      <div ref={labelsRef} className="scene-labels">
        {world.pens.map((p, i) => {
          const penHoles = holes.filter((f) => f.penId === p.id).length;
          const r = penRisk[i] ?? 0;
          const kind = penHoles ? 'hole' : r >= 0.5 ? 'high' : null;
          const title = penHoles ? `${p.name}: hole open` : kind ? `${p.name}: high hole risk (${Math.round(r * 100)})` : p.name;
          return (
            <span key={p.id} className="site-marker" title={title}>
              {kind && (
                <svg className={`pin pin-${kind}`} width="26" height="34" viewBox="0 0 26 34" role="img" aria-label={title}>
                  <path d="M13 33C13 33 2 20.5 2 12.5a11 11 0 0 1 22 0C24 20.5 13 33 13 33Z" />
                  {kind === 'hole' ? <path d="M13 6.5v8M13 18v.5" className="glyph" /> : <path d="M13 6.8 7.6 16.2h10.8Z" className="glyph-fill" />}
                </svg>
              )}
              <span className="pen-chip">{p.id}</span>
            </span>
          );
        })}
      </div>
      <span ref={bargeLabelRef} className="site-place">
        Feed barge, swarm dock
      </span>
    </div>
  );
}
