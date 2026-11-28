/**
 * 3D model of one pen: collar, net and bottom cone painted with the active layer as a smooth heat
 * texture, sinker tube, chains and moorings. Open findings get floating labels that can be clicked.
 * Renders only when something changes (no animation loop) and is loaded lazily, so the farm view
 * never pays for three.js.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  ANGLE_SECTORS,
  PEN_RADIUS_M,
  ROWS,
  SECTOR_DEG,
  WALL_ROWS,
  cellCol,
  cellIndex,
  cellLabel,
  cellRow,
  rowDepth,
  type Finding,
} from '../data/model';
import type { Drone } from '../data/swarm';
import { NET_OPACITY, environment } from '../lib/environment';
import { paintNetTexture } from '../lib/heat';
import { ROBOT_RENDER_ORDER, robotGeometry, robotMaterial } from '../lib/robotModel';
import { buildNetGeometry, netPoint, radiusAt } from '../lib/netGeometry';
import { FLY_MS, HANDOFF_MS, PEN_DRONE_SCALE, PEN_FOG, PEN_LIGHT, PEN_VIEW, buildRigging, dronePosition, faceAlongNet, penViewOffset, sceneClock } from '../lib/penView';
import type { LayerDef, LayerGrid } from '../lib/layers';
import { color } from '../lib/tokens';

interface Props {
  grid: LayerGrid;
  layer: LayerDef;
  selectedCell: number | null;
  findings: Finding[];
  /** Ids of confirmed holes; other hole findings are possible openings, drawn like wear. */
  holeIds: ReadonlySet<number>;
  /** Per-cell fouling to draw as growth on the net, or undefined on the fouling layer. */
  growth?: ArrayLike<number>;
  /** Direction the current flows towards, degrees, and its speed in cm/s. */
  currentDir: number;
  currentSpeed: number;
  /** Drones working in this pen. */
  drones: Drone[];
  selectedDrone: string | null;
  onSelectDrone: (id: string) => void;
  /** Live mode animates drones and the current; history and forecast are still. */
  live: boolean;
  onSelect: (cell: number) => void;
  onSelectFinding: (f: Finding) => void;
  labelFor: (f: Finding) => string;
  /** The camera turns to face this cell when it is on the far side. */
  focusCell: number | null;
  /** See-through horizontal water layers inside the pen (oxygen), each painted at its depth, or null. */
  water: { depths: number[]; paint: (canvas: HTMLCanvasElement, depth: number) => void } | null;
}

const R = PEN_RADIUS_M;
const ORIGIN = new THREE.Vector3();

function cellOutline(cell: number): THREE.Vector3[] {
  const [d0, d1] = rowDepth(cellRow(cell));
  const a0 = cellCol(cell) * SECTOR_DEG;
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= 6; k++) pts.push(netPoint(d0, a0 + (k / 6) * SECTOR_DEG, 1.012));
  for (let k = 6; k >= 0; k--) pts.push(netPoint(d1, a0 + (k / 6) * SECTOR_DEG, 1.012));
  pts.push(pts[0].clone());
  return pts;
}

function cellCentre(cell: number, scale = 1.02): THREE.Vector3 {
  const [d0, d1] = rowDepth(cellRow(cell));
  return netPoint((d0 + d1) / 2, cellCol(cell) * SECTOR_DEG + SECTOR_DEG / 2, scale);
}

interface SceneCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  net: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  texture: THREE.CanvasTexture;
  textureCanvas: HTMLCanvasElement;
  outline: THREE.Line;
  markers: THREE.Group;
  flowLines: THREE.LineSegments;
  flowPoints: THREE.Points;
  droneGroup: THREE.Group;
  /** Advances drones and current particles to time `t` (seconds) and re-renders. */
  animate: (t: number) => void;
  /** Smoothly orbits the camera to an azimuth (theta) and/or polar angle (phi), in radians. */
  orbitTo: (to: { theta?: number; phi?: number }) => () => void;
  waterGroup: THREE.Group;
  render: () => void;
}

/** Streamlines of the current past the pen: straight far away, nudged outward near the net. */
function flowPaths(dirDeg: number): THREE.Vector3[][] {
  const a = (dirDeg * Math.PI) / 180;
  const along = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
  const across = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  const paths: THREE.Vector3[][] = [];
  for (const depth of [3, 11, 19]) {
    for (let b = -1.75; b <= 1.76; b += 0.5) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 40; k++) {
        const s = (-2.6 + (5.2 * k) / 40) * R;
        const lateral = b * R * (1 + 0.22 * Math.exp(-(s * s) / (1.4 * R * R)));
        pts.push(along.clone().multiplyScalar(s).add(across.clone().multiplyScalar(lateral)).setY(-depth));
      }
      paths.push(pts);
    }
  }
  return paths;
}

const PARTICLES_PER_PATH = 4;

export default function Pen3D({
  grid,
  layer,
  selectedCell,
  findings,
  holeIds,
  growth,
  currentDir,
  currentSpeed,
  drones,
  selectedDrone,
  onSelectDrone,
  live,
  onSelect,
  onSelectFinding,
  labelFor,
  water,
  focusCell,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<SceneCtx | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const findingsRef = useRef(findings);
  findingsRef.current = findings;
  const dronesRef = useRef(drones);
  dronesRef.current = drones;
  const speedRef = useRef(currentSpeed);
  speedRef.current = currentSpeed;
  const onSelectDroneRef = useRef(onSelectDrone);
  onSelectDroneRef.current = onSelectDrone;
  const droneLabelsRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(sceneClock());
  // Camera turns wait until the pen view has faded in over the site, so they play on screen instead
  // of putting the view at a different angle from the one the site camera arrived at.
  const revealAt = useRef(performance.now() + FLY_MS + HANDOFF_MS);
  const afterReveal = useCallback((turn: () => () => void): (() => void) => {
    const wait = revealAt.current - performance.now();
    if (wait <= 0) return turn();
    let cancel = (): void => {};
    const timer = window.setTimeout(() => (cancel = turn()), wait);
    return () => {
      window.clearTimeout(timer);
      cancel();
    };
  }, []);
  const setFlowRef = useRef<((dirDeg: number) => void) | null>(null);
  const [hover, setHover] = useState<{ cell: number; x: number; y: number } | null>(null);

  // Scene setup, once.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = 'block';
    wrap.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, PEN_LIGHT.ambient));
    const sun = new THREE.DirectionalLight(0xffffff, PEN_LIGHT.sun);
    sun.position.copy(PEN_LIGHT.sunPosition);
    scene.add(sun);

    // Starts exactly where the site camera's flight into the pen ends.
    const camera = new THREE.PerspectiveCamera(PEN_VIEW.fov, 1, 1, 1000);
    camera.position.copy(PEN_VIEW.target).add(PEN_VIEW.offset);

    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 1536;
    textureCanvas.height = ROWS * 56;
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // See-through net (about 0.8), so drones and the far side stay visible from outside.
    const net = new THREE.Mesh(
      buildNetGeometry(),
      new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, opacity: NET_OPACITY, depthWrite: false }),
    );
    scene.add(net);
    scene.add(buildRigging());

    // Fjord surroundings in the same water colours as the site view: the seabed fades into the water,
    // under a faint surface.
    scene.fog = new THREE.Fog(PEN_FOG.color, PEN_FOG.near, PEN_FOG.far);
    const seabed = new THREE.Mesh(new THREE.CircleGeometry(260, 64), new THREE.MeshLambertMaterial({ color: environment.seabed }));
    seabed.rotation.x = -Math.PI / 2;
    seabed.position.y = -46;
    scene.add(seabed);
    const surface = new THREE.Mesh(
      new THREE.RingGeometry(R + 2.8, 260, 64),
      new THREE.MeshBasicMaterial({ color: environment.shallow, transparent: true, opacity: environment.surfaceOpacity, side: THREE.DoubleSide, depthWrite: false }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 0.1;
    scene.add(surface);

    const outline = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: color.ink }));
    outline.visible = false;
    scene.add(outline);
    const markers = new THREE.Group();
    scene.add(markers);
    // Current: faint streamlines with particles drifting along them.
    const flowLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: color.signal, transparent: true, opacity: 0.16 }));
    scene.add(flowLines);
    const flowPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: color.signal, size: 0.45, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    scene.add(flowPoints);
    let paths: THREE.Vector3[][] = [];

    const droneGroup = new THREE.Group();
    scene.add(droneGroup);

    const waterGroup = new THREE.Group();
    scene.add(waterGroup);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(PEN_VIEW.target);
    controls.minDistance = 40;
    controls.maxDistance = 320;
    controls.update();

    // Floating labels follow their finding on screen and hide while it faces away.
    const placeLabels = (): void => {
      const box = labelsRef.current;
      if (!box) return;
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      const place = (el: HTMLElement | undefined, p: THREE.Vector3, alwaysVisible: boolean): void => {
        if (!el) return;
        const normal = p.clone().setY(0).normalize();
        const visible = alwaysVisible || camera.position.clone().sub(p).dot(normal) > 0;
        const s = p.clone().project(camera);
        el.style.transform = `translate(${((s.x + 1) / 2) * w}px, ${((1 - s.y) / 2) * h}px)`;
        el.style.opacity = visible ? '1' : '0';
        el.style.pointerEvents = visible ? 'auto' : 'none';
      };
      findingsRef.current.forEach((f, i) => place(box.children[i] as HTMLElement | undefined, cellCentre(f.cell, 1.0), cellRow(f.cell) >= WALL_ROWS));
      const droneBox = droneLabelsRef.current;
      if (droneBox) {
        droneGroup.children.forEach((m, i) => place(droneBox.children[i] as HTMLElement | undefined, m.position, false));
      }
    };

    const animate = (t: number): void => {
      timeRef.current = t;
      dronesRef.current.forEach((d, k) => {
        const m = droneGroup.children[k];
        if (!m) return;
        const p = dronePosition(d, t, k);
        m.position.copy(p);
        faceAlongNet(m, p, ORIGIN);
      });
      const pos = flowPoints.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos && paths.length) {
        const rate = 0.02 + speedRef.current / 900; // path lengths per second
        let i = 0;
        for (let pi = 0; pi < paths.length; pi++) {
          const path = paths[pi];
          for (let q = 0; q < PARTICLES_PER_PATH; q++) {
            const u = (((t * rate + q / PARTICLES_PER_PATH + pi * 0.137) % 1) + 1) % 1;
            const f = u * (path.length - 1);
            const k0 = Math.floor(f);
            const p = path[k0].clone().lerp(path[Math.min(path.length - 1, k0 + 1)], f - k0);
            pos.setXYZ(i++, p.x, p.y, p.z);
          }
        }
        pos.needsUpdate = true;
      }
      render();
    };

    const setFlow = (dirDeg: number): void => {
      paths = flowPaths(dirDeg);
      const segs: THREE.Vector3[] = [];
      for (const path of paths) for (let k = 0; k < path.length - 1; k++) segs.push(path[k], path[k + 1]);
      flowLines.geometry.dispose();
      flowLines.geometry = new THREE.BufferGeometry().setFromPoints(segs);
      flowPoints.geometry.dispose();
      flowPoints.geometry = new THREE.BufferGeometry();
      flowPoints.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(paths.length * PARTICLES_PER_PATH * 3), 3));
    };
    setFlowRef.current = setFlow;

    const render = (): void => {
      renderer.render(scene, camera);
      placeLabels();
    };
    controls.addEventListener('change', render);

    // Keep the whole pen in view in narrow stages, without changing the angle the user (or a focus
    // turn) left the camera at. Same distance as the end of the site camera's flight.
    const resize = (): void => {
      const { clientWidth: w, clientHeight: h } = wrap;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      const offset = camera.position.clone().sub(controls.target);
      camera.position.copy(controls.target).add(offset.setLength(penViewOffset(camera.aspect).length()));
      camera.updateProjectionMatrix();
      controls.update();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (e: PointerEvent): { cell: number; droneId?: string; x: number; y: number } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([droneGroup, net], true)[0];
      if (hit && hit.object !== net) {
        let o: THREE.Object3D | null = hit.object;
        while (o && !o.userData.droneId) o = o.parent;
        return o ? { cell: -1, droneId: o.userData.droneId as string, x: e.clientX - rect.left, y: e.clientY - rect.top } : null;
      }
      if (!hit?.uv) return null;
      const col = Math.min(ANGLE_SECTORS - 1, Math.floor(hit.uv.x * ANGLE_SECTORS));
      const row = Math.min(ROWS - 1, Math.floor(hit.uv.y * ROWS));
      return { cell: cellIndex(row, col), x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    let down: [number, number] | null = null;
    const onDown = (e: PointerEvent): void => {
      down = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent): void => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4) {
        const hit = pick(e);
        if (hit?.droneId) onSelectDroneRef.current(hit.droneId);
        else if (hit) onSelectRef.current(hit.cell);
      }
      down = null;
    };
    const onMove = (e: PointerEvent): void => {
      if (e.buttons) return;
      const hit = pick(e);
      setHover(hit && !hit.droneId ? hit : null);
      renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
    };
    const onLeave = (): void => setHover(null);
    const el = renderer.domElement;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);

    const orbitTo = (to: { theta?: number; phi?: number }): (() => void) => {
      const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      const from = { theta: sph.theta, phi: sph.phi };
      let theta = to.theta ?? from.theta;
      while (theta - from.theta > Math.PI) theta -= 2 * Math.PI;
      while (from.theta - theta > Math.PI) theta += 2 * Math.PI;
      const phi = to.phi ?? from.phi;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const start = performance.now();
      let raf = 0;
      // Only the requested angle is driven, so a turn and a tilt can run at the same time.
      const step = (now: number): void => {
        const t = reduce ? 1 : Math.min(1, (now - start) / 650);
        const k = 1 - Math.pow(1 - t, 3);
        const cur = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
        if (to.theta !== undefined) cur.theta = from.theta + (theta - from.theta) * k;
        if (to.phi !== undefined) cur.phi = from.phi + (phi - from.phi) * k;
        camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(cur));
        controls.update();
        render();
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    };

    ctx.current = { scene, camera, controls, orbitTo, net, texture, textureCanvas, outline, markers, flowLines, flowPoints, droneGroup, animate, waterGroup, render };
    resize();

    return () => {
      ro.disconnect();
      controls.dispose();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      scene.traverse((o) => {
        if (o.userData.shared) return; // the shared robot model stays loaded for the next view
        if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
        }
      });
      texture.dispose();
      waterGroup.children.forEach((m) => ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).map?.dispose());
      renderer.dispose();
      el.remove();
      ctx.current = null;
    };
  }, []);

  // Paint the active layer (and open holes) onto the net texture.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    paintNetTexture(
      c.textureCanvas,
      grid,
      layer,
      findings.filter((f) => holeIds.has(f.id)),
      growth,
    );
    c.texture.needsUpdate = true;
    c.render();
  }, [grid, layer, findings, holeIds, growth]);

  // Selection outline.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.outline.visible = selectedCell !== null;
    if (selectedCell !== null) {
      c.outline.geometry.dispose();
      c.outline.geometry = new THREE.BufferGeometry().setFromPoints(cellOutline(selectedCell));
    }
    c.render();
  }, [selectedCell]);

  // Small markers at open findings; the labels carry the detail.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.markers.children.forEach((m) => {
      if (m instanceof THREE.Mesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    c.markers.clear();
    for (const f of findings) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(holeIds.has(f.id) ? 1.1 : 0.8, 14, 14), new THREE.MeshBasicMaterial({ color: holeIds.has(f.id) ? color.riskCritical : color.ink }));
      m.position.copy(cellCentre(f.cell, 1.03));
      c.markers.add(m);
    }
    c.render();
  }, [findings, holeIds]);

  // Water layers inside the pen, one disc per depth, rebuilt when the data changes.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    for (const m of [...c.waterGroup.children] as THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>[]) {
      m.geometry.dispose();
      m.material.map?.dispose();
      m.material.dispose();
      c.waterGroup.remove(m);
    }
    // A lighter net while the water is shown, so the layers inside stay visible.
    c.net.material.opacity = water ? 0.55 : NET_OPACITY;
    for (const depth of water?.depths ?? []) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      water!.paint(canvas, depth);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      const r = radiusAt(depth) * 0.985;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 96), new THREE.MeshBasicMaterial({ map, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; // local +y becomes north (−z)
      disc.position.y = -depth;
      c.waterGroup.add(disc);
    }
    c.render();
  }, [water]);

  // Turn the camera round the pen to face the focus cell, if it is on the far side.
  useEffect(() => {
    const c = ctx.current;
    if (!c || focusCell === null) return;
    const outward = cellCentre(focusCell, 1).setY(0).normalize();
    const facing = c.camera.position.clone().sub(c.controls.target).setY(0).normalize().dot(outward);
    if (facing > 0.45) return;
    return afterReveal(() => c.orbitTo({ theta: Math.atan2(outward.x, outward.z) + 0.35 })); // slightly off-axis reads better
  }, [focusCell, afterReveal]);

  // Seen a little from above, the stacked water layers separate instead of lining up edge-on.
  const hasWater = water !== null;
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    return afterReveal(() => c.orbitTo({ phi: hasWater ? 1.12 : 1.48 }));
  }, [hasWater, afterReveal]);

  // Current streamlines follow the day's direction.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    setFlowRef.current?.(currentDir);
    c.animate(timeRef.current);
  }, [currentDir]);

  // Drone bodies: the shared BlueROV2-style model, drawn about 10× its real 0.46 m so it reads at
  // pen scale. The selected drone gets a ring.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.droneGroup.children.forEach((g) =>
      g.traverse((o) => {
        if (o instanceof THREE.Mesh && !o.userData.shared) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      }),
    );
    c.droneGroup.clear();
    for (const d of drones) {
      const g = new THREE.Group();
      g.userData.droneId = d.id;
      const body = new THREE.Mesh(robotGeometry, robotMaterial);
      body.userData.shared = true;
      body.renderOrder = ROBOT_RENDER_ORDER;
      body.scale.setScalar(PEN_DRONE_SCALE);
      g.add(body);
      if (d.id === selectedDrone) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(3, 0.12, 8, 32), new THREE.MeshBasicMaterial({ color: color.signal }));
        ring.rotation.x = Math.PI / 2;
        g.add(ring);
      }
      c.droneGroup.add(g);
    }
    c.animate(timeRef.current);
  }, [drones, selectedDrone]);

  // Live mode: drones sweep and the current drifts, at about 30 frames a second.
  useEffect(() => {
    const c = ctx.current;
    if (!c || !live || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number): void => {
      if (now - last > 33) {
        last = now;
        c.animate(sceneClock(now));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live]);


  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <div ref={labelsRef} className="scene-labels">
        {findings.map((f) => (
          <button key={f.id} className={`scene-label${holeIds.has(f.id) ? ' hole' : ''}`} onClick={() => onSelectFinding(f)}>
            <span className="pin" aria-hidden="true" />
            {labelFor(f)}
          </button>
        ))}
      </div>
      <div ref={droneLabelsRef} className="scene-labels">
        {drones.map((d) => (
          <button key={d.id} className={`scene-label drone-label${d.id === selectedDrone ? ' selected' : ''}`} onClick={() => onSelectDrone(d.id)}>
            {d.id}, {d.status === 'sampling' ? 'sampling' : d.status === 'returning' ? 'returning' : 'inspecting'}
          </button>
        ))}
      </div>
      {hover && (
        <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="t">{cellLabel(hover.cell)}</div>
          <div className="m">
            {layer.label}: {Number.isNaN(grid.values[hover.cell]) ? 'no data' : layer.format(grid.values[hover.cell])}
          </div>
        </div>
      )}
    </div>
  );
}
