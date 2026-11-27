/**
 * Site version 4: the whole farm in 3D. Every pen's net hangs in the water painted with hole risk,
 * the feed barge floats at the edge, and the swarm drones circle the pens they work on. Click a pen
 * to open it. Renders on demand; drones and current streaks animate in live mode only.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PEN_RADIUS_M, ROWS, WALL_DEPTH_M, type Finding, type World } from '../data/model';
import type { Drone } from '../data/swarm';
import { paintNetTexture } from '../lib/heat';
import { computeLayerGrid, layerById } from '../lib/layers';
import { buildNetGeometry, netPoint } from '../lib/netGeometry';
import { TERRAIN, heightAt, paintTerrain } from '../lib/terrain';
import { riskColor } from '../lib/layers';
import { color } from '../lib/tokens';

interface Props {
  world: World;
  day: number;
  live: boolean;
  open: Finding[];
  drones: Drone[];
  /** The pen the user opened: the camera flies down into it, then the pen view takes over. */
  focusPen: number | null;
  /** Worst hole risk per pen today, for the halos on the water. */
  penRisk: number[];
  onOpenPen: (penIndex: number) => void;
  onSelectDrone: (id: string) => void;
}

/** Overview camera, and the camera offset the pen view starts from (so the hand-over is seamless). */
const OVERVIEW = { position: new THREE.Vector3(60, 470, 780), target: new THREE.Vector3(0, -15, -20) };
const PEN_OFFSET = new THREE.Vector3(85, 9, 95);
const PEN_TARGET = new THREE.Vector3(0, -15, 0);

const R = PEN_RADIUS_M;

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
  halos: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>[];
  animate: (t: number) => void;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}

export default function SiteScene3D({ world, day, live, open, drones, focusPen, penRisk, onOpenPen, onSelectDrone }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<SceneCtx | null>(null);
  const dronesRef = useRef(drones);
  dronesRef.current = drones;
  const handlers = useRef({ onOpenPen, onSelectDrone });
  handlers.current = { onOpenPen, onSelectDrone };
  const timeRef = useRef(0);
  const dayRef = useRef(day);
  dayRef.current = day;
  const compassRef = useRef<HTMLDivElement>(null);
  const [hoverPen, setHoverPen] = useState<number | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = 'block';
    wrap.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(color.page, 700, 1700);
    scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(-120, 260, 160);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(34, 1, 1, 3000);
    camera.position.copy(OVERVIEW.position);

    // Surroundings: shore, headland, island and seabed, painted like a sea chart.
    const terrainCanvas = document.createElement('canvas');
    terrainCanvas.width = 1200;
    terrainCanvas.height = 900;
    paintTerrain(terrainCanvas);
    const terrainTexture = new THREE.CanvasTexture(terrainCanvas);
    terrainTexture.colorSpace = THREE.SRGBColorSpace;
    terrainTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const terrainGeometry = new THREE.PlaneGeometry(TERRAIN.width, TERRAIN.depth, 240, 180);
    const tp = terrainGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < tp.count; i++) tp.setZ(i, heightAt(tp.getX(i), -tp.getY(i)));
    terrainGeometry.computeVertexNormals();
    const terrain = new THREE.Mesh(terrainGeometry, new THREE.MeshLambertMaterial({ map: terrainTexture }));
    terrain.rotation.x = -Math.PI / 2; // local +y becomes north (−z)
    scene.add(terrain);
    // A faint water surface over the underwater terrain; land rises through it.
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(TERRAIN.width, TERRAIN.depth),
      new THREE.MeshBasicMaterial({ color: color.sea, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    surface.rotation.x = -Math.PI / 2;
    scene.add(surface);

    // Risk halos on the water around pens at elevated risk or worse.
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = 128;
    haloCanvas.height = 128;
    const hc = haloCanvas.getContext('2d');
    if (hc) {
      const g = hc.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      hc.fillStyle = g;
      hc.fillRect(0, 0, 128, 128);
    }
    const haloTexture = new THREE.CanvasTexture(haloCanvas);
    const halos = world.pens.map((_, i) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(R + 34, 48), new THREE.MeshBasicMaterial({ map: haloTexture, transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.copy(penPosition(world, i)).setY(0.4);
      m.visible = false;
      scene.add(m);
      return m;
    });

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
      const net = new THREE.Mesh(netGeometry, new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide }));
      net.position.copy(pos);
      net.userData.penIndex = i;
      scene.add(net);
      nets.push(net);
      const collar = new THREE.Mesh(new THREE.TorusGeometry(R + 1.5, 0.9, 8, 72), new THREE.MeshLambertMaterial({ color: color.coast }));
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

    // Feed barge.
    const barge = new THREE.Mesh(new THREE.BoxGeometry(40, 10, 22), new THREE.MeshLambertMaterial({ color: color.paper }));
    barge.position.set(-420, 3, 230);
    scene.add(barge);
    const deckhouse = new THREE.Mesh(new THREE.BoxGeometry(18, 8, 14), new THREE.MeshLambertMaterial({ color: color.ink3 }));
    deckhouse.position.set(-428, 11, 230);
    scene.add(deckhouse);

    const droneGroup = new THREE.Group();
    scene.add(droneGroup);

    // Current: short streaks drifting over the water surface in the current's direction.
    const streakCount = 240;
    const seeds = Array.from({ length: streakCount }, (_, k) => [((k * 97) % 1000) / 1000, ((k * 389) % 1000) / 1000]);
    const streaks = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(streakCount * 6), 3)),
      new THREE.LineBasicMaterial({ color: color.ink, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    scene.add(streaks);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(OVERVIEW.target);
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 120;
    controls.maxDistance = 1100;
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
      dronesRef.current.forEach((d, k) => {
        const m = droneGroup.children[k];
        if (!m) return;
        if (d.penIndex === null) {
          m.position.set(-400 + k * 6, 2, 250);
          return;
        }
        // Inside the net, sweeping either side of its area.
        const centre = penPosition(world, d.penIndex);
        const base = d.cell === null ? 0 : (d.cell % 24) * 15 + 7.5;
        const angle = base + 14 * Math.sin(t / 3 + k);
        const local = netPoint(Math.min(d.depth, WALL_DEPTH_M), angle, 0.8);
        m.position.copy(centre).add(local);
      });
      const today = dayRef.current;
      const a = (world.env.currentDir[today] * Math.PI) / 180;
      const along = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
      const across = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const speed = world.env.currentSpeed[today];
      const rate = 0.01 + speed / 3000;
      const length = 18 + speed * 1.2; // longer streaks in stronger current
      const pos = streaks.geometry.getAttribute('position') as THREE.BufferAttribute;
      seeds.forEach(([u, v], k) => {
        const s = ((((u + t * rate) % 1) + 1) % 1) * 1500 - 750;
        const head = along.clone().multiplyScalar(s).add(across.clone().multiplyScalar(v * 1100 - 550));
        const y = heightAt(head.x, head.z) > -2 ? -999 : 0.8; // only over water
        const tail = head.clone().sub(along.clone().multiplyScalar(length));
        pos.setXYZ(k * 2, head.x, y, head.z);
        pos.setXYZ(k * 2 + 1, tail.x, y, tail.z);
      });
      pos.needsUpdate = true;
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

    ctx.current = { render, textures, collars, droneGroup, halos, animate, camera, controls };
    resize();

    return () => {
      ro.disconnect();
      controls.dispose();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
        }
      });
      textures.forEach((t) => t.texture.dispose());
      terrainTexture.dispose();
      haloTexture.dispose();
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
        open.filter((f) => f.penId === world.pens[i].id && f.kind === 'hole'),
      );
      texture.needsUpdate = true;
    });
    c.animate(timeRef.current);
  }, [world, day, open]);

  // Halos tinted by each pen's worst risk; calm pens get none.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.halos.forEach((m, i) => {
      const r = penRisk[i] ?? 0;
      m.visible = r >= 0.25;
      m.material.color.set(riskColor(r));
      m.material.opacity = Math.min(0.85, 0.25 + r * 0.6);
    });
    c.animate(timeRef.current);
  }, [penRisk]);

  // Highlight the hovered pen's collar.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.collars.forEach((m, i) => m.material.color.set(i === hoverPen ? color.signal : color.coast));
    c.render();
  }, [hoverPen]);

  // Drone bodies.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.droneGroup.children.forEach((m) => {
      if (m instanceof THREE.Mesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    c.droneGroup.clear();
    for (const d of drones) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(2.6, 14, 10), new THREE.MeshLambertMaterial({ color: d.penIndex === null ? color.ink3 : color.signal }));
      m.scale.set(1.6, 0.8, 0.8);
      m.userData.droneId = d.id;
      c.droneGroup.add(m);
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
        {world.pens.map((p) => {
          const holes = open.filter((f) => f.penId === p.id && f.kind === 'hole').length;
          return (
            <span key={p.id} className={`scene-label site-label${holes ? ' hole' : ''}`}>
              {p.id}
              {holes ? ', hole' : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}
