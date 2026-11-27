/**
 * 3D model of one pen: collar, net and bottom cone painted with the active layer as a smooth heat
 * texture, sinker tube, chains and moorings. Open findings get floating labels that can be clicked.
 * Renders only when something changes (no animation loop) and is loaded lazily, so the farm view
 * never pays for three.js.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  ANGLE_SECTORS,
  CONE_TIP_M,
  PEN_RADIUS_M,
  ROWS,
  SECTOR_DEG,
  WALL_DEPTH_M,
  WALL_ROWS,
  cellCol,
  cellIndex,
  cellLabel,
  cellRow,
  rowDepth,
  type Finding,
} from '../data/model';
import { paintNetTexture } from '../lib/heat';
import type { LayerDef, LayerGrid } from '../lib/layers';
import { color } from '../lib/tokens';

interface Props {
  grid: LayerGrid;
  layer: LayerDef;
  selectedCell: number | null;
  findings: Finding[];
  /** Direction the current flows towards, degrees. */
  currentDir: number;
  onSelect: (cell: number) => void;
  onSelectFinding: (f: Finding) => void;
  labelFor: (f: Finding) => string;
  /** The camera turns to face this cell when it is on the far side. */
  focusCell: number | null;
  /** A horizontal water slice inside the pen (oxygen, temperature), or null. */
  slice: { depth: number; paint: (canvas: HTMLCanvasElement) => void } | null;
}

const R = PEN_RADIUS_M;
const SEGMENTS = 96;

function radiusAt(depth: number): number {
  return depth <= WALL_DEPTH_M ? R : R * (1 - (depth - WALL_DEPTH_M) / (CONE_TIP_M - WALL_DEPTH_M));
}

/** Point on the net surface; angle 0 = north (−z), clockwise seen from above. */
function netPoint(depth: number, deg: number, scale = 1): THREE.Vector3 {
  const a = (deg * Math.PI) / 180;
  const r = radiusAt(depth) * scale;
  return new THREE.Vector3(r * Math.sin(a), -depth, -r * Math.cos(a));
}

/** Depth → position in rows (wall rows are 2.5 m, cone rows 3.33 m); the texture's v coordinate. */
function rowPosition(depth: number): number {
  return depth <= WALL_DEPTH_M ? (depth / WALL_DEPTH_M) * WALL_ROWS : WALL_ROWS + ((depth - WALL_DEPTH_M) / (CONE_TIP_M - WALL_DEPTH_M)) * (ROWS - WALL_ROWS);
}

/** A smooth surface of revolution (wall + cone) with UVs matching the unrolled texture. */
function buildNetGeometry(): THREE.BufferGeometry {
  const depths: number[] = [];
  for (let d = 0; d <= CONE_TIP_M; d += 1) depths.push(d);
  const pos: number[] = [];
  const uv: number[] = [];
  for (const d of depths) {
    for (let s = 0; s <= SEGMENTS; s++) {
      const p = netPoint(d, (s / SEGMENTS) * 360);
      pos.push(p.x, p.y, p.z);
      uv.push(s / SEGMENTS, rowPosition(d) / ROWS);
    }
  }
  const index: number[] = [];
  const stride = SEGMENTS + 1;
  for (let i = 0; i < depths.length - 1; i++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = i * stride + s;
      const c = a + stride;
      index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

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

function buildRigging(scene: THREE.Scene): void {
  const steel = new THREE.MeshLambertMaterial({ color: color.coast });
  for (const radius of [R + 0.6, R + 2.0]) {
    const torus = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.45, 8, 96), steel);
    torus.rotation.x = Math.PI / 2;
    torus.position.y = 0.3;
    scene.add(torus);
  }
  const sinker = new THREE.Mesh(new THREE.TorusGeometry(R + 1.2, 0.55, 8, 96), new THREE.MeshLambertMaterial({ color: color.ink3 }));
  sinker.rotation.x = Math.PI / 2;
  sinker.position.y = -(WALL_DEPTH_M + 1.5);
  scene.add(sinker);

  const chainPts: THREE.Vector3[] = [];
  for (let a = 0; a < 360; a += 45) {
    const top = netPoint(0, a, (R + 1.2) / R);
    chainPts.push(top, top.clone().setY(-(WALL_DEPTH_M + 1.5)));
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(chainPts), new THREE.LineBasicMaterial({ color: color.ink3 })));

  const moorPts: THREE.Vector3[] = [];
  for (const a of [45, 135, 225, 315]) {
    const end = netPoint(0, a, (R + 45) / R);
    end.y = -38;
    moorPts.push(netPoint(0, a, (R + 2) / R), end);
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(moorPts), new THREE.LineBasicMaterial({ color: color.coast, transparent: true, opacity: 0.6 })));

  const weight = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 12), new THREE.MeshLambertMaterial({ color: color.ink3 }));
  weight.position.y = -CONE_TIP_M - 0.8;
  scene.add(weight);
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
  arrow: THREE.ArrowHelper;
  /** Smoothly orbits the camera to an azimuth (theta) and/or polar angle (phi), in radians. */
  orbitTo: (to: { theta?: number; phi?: number }) => () => void;
  sliceMesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  sliceCanvas: HTMLCanvasElement;
  sliceTexture: THREE.CanvasTexture;
  render: () => void;
}

export default function Pen3D({ grid, layer, selectedCell, findings, currentDir, onSelect, onSelectFinding, labelFor, slice, focusCell }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<SceneCtx | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const findingsRef = useRef(findings);
  findingsRef.current = findings;
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
    scene.add(new THREE.AmbientLight(0xffffff, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(30, 60, 40);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(36, 1, 1, 1000);
    camera.position.set(85, -6, 95);

    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 1536;
    textureCanvas.height = ROWS * 56;
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const net = new THREE.Mesh(buildNetGeometry(), new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide }));
    scene.add(net);
    buildRigging(scene);

    const outline = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: color.ink }));
    outline.visible = false;
    scene.add(outline);
    const markers = new THREE.Group();
    scene.add(markers);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 14, color.signal, 4, 2.5);
    scene.add(arrow);

    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = 128;
    sliceCanvas.height = 128;
    const sliceTexture = new THREE.CanvasTexture(sliceCanvas);
    sliceTexture.colorSpace = THREE.SRGBColorSpace;
    const sliceMesh = new THREE.Mesh(
      new THREE.CircleGeometry(1, 96),
      new THREE.MeshBasicMaterial({ map: sliceTexture, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
    );
    sliceMesh.rotation.x = -Math.PI / 2; // local +y becomes north (−z)
    sliceMesh.visible = false;
    scene.add(sliceMesh);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, -15, 0);
    controls.minDistance = 40;
    controls.maxDistance = 320;
    controls.update();

    // Floating labels follow their finding on screen and hide while it faces away.
    const placeLabels = (): void => {
      const box = labelsRef.current;
      if (!box) return;
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      findingsRef.current.forEach((f, i) => {
        const el = box.children[i] as HTMLElement | undefined;
        if (!el) return;
        const p = cellCentre(f.cell, 1.0);
        const normal = p.clone().setY(0).normalize();
        const facing = cellRow(f.cell) >= WALL_ROWS || camera.position.clone().sub(p).dot(normal) > 0;
        const visible = facing;
        const s = p.project(camera);
        el.style.transform = `translate(${((s.x + 1) / 2) * w}px, ${((1 - s.y) / 2) * h}px)`;
        el.style.opacity = visible ? '1' : '0';
        el.style.pointerEvents = visible ? 'auto' : 'none';
      });
    };

    const render = (): void => {
      renderer.render(scene, camera);
      placeLabels();
    };
    controls.addEventListener('change', render);

    // Keep the whole pen (about 75 m across with the moorings) in view in narrow stages,
    // without changing the angle the user (or a focus turn) left the camera at.
    const baseDistance = camera.position.distanceTo(controls.target);
    const resize = (): void => {
      const { clientWidth: w, clientHeight: h } = wrap;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      const halfFovH = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
      const needed = (R + 12) / Math.tan(halfFovH);
      const offset = camera.position.clone().sub(controls.target);
      camera.position.copy(controls.target).add(offset.setLength(Math.max(baseDistance, needed)));
      camera.updateProjectionMatrix();
      controls.update();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (e: PointerEvent): { cell: number; x: number; y: number } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(net)[0];
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
        if (hit) onSelectRef.current(hit.cell);
      }
      down = null;
    };
    const onMove = (e: PointerEvent): void => {
      if (e.buttons) return;
      setHover(pick(e));
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

    ctx.current = { scene, camera, controls, orbitTo, net, texture, textureCanvas, outline, markers, arrow, sliceMesh, sliceCanvas, sliceTexture, render };
    resize();

    return () => {
      ro.disconnect();
      controls.dispose();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
        }
      });
      texture.dispose();
      sliceTexture.dispose();
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
      findings.filter((f) => f.kind === 'hole'),
    );
    c.texture.needsUpdate = true;
    c.render();
  }, [grid, layer, findings]);

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
      const m = new THREE.Mesh(new THREE.SphereGeometry(f.kind === 'hole' ? 1.1 : 0.8, 14, 14), new THREE.MeshBasicMaterial({ color: f.kind === 'hole' ? color.riskCritical : color.ink }));
      m.position.copy(cellCentre(f.cell, 1.03));
      c.markers.add(m);
    }
    c.render();
  }, [findings]);

  // Horizontal water slice at the chosen depth.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.sliceMesh.visible = slice !== null;
    // See-through net while a slice is shown, so the slice inside is visible.
    c.net.material.transparent = slice !== null;
    c.net.material.opacity = slice ? 0.35 : 1;
    c.net.material.depthWrite = slice === null;
    c.net.material.needsUpdate = true;
    if (slice) {
      slice.paint(c.sliceCanvas);
      c.sliceTexture.needsUpdate = true;
      const r = radiusAt(slice.depth) * 0.985;
      c.sliceMesh.scale.set(r, r, 1);
      c.sliceMesh.position.y = -slice.depth;
    }
    c.render();
  }, [slice]);

  // Turn the camera round the pen to face the focus cell, if it is on the far side.
  useEffect(() => {
    const c = ctx.current;
    if (!c || focusCell === null) return;
    const outward = cellCentre(focusCell, 1).setY(0).normalize();
    const facing = c.camera.position.clone().sub(c.controls.target).setY(0).normalize().dot(outward);
    if (facing > 0.45) return;
    return c.orbitTo({ theta: Math.atan2(outward.x, outward.z) + 0.35 }); // slightly off-axis reads better
  }, [focusCell]);

  // Looking down at a water slice is clearer than seeing it edge-on.
  const hasSlice = slice !== null;
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    return c.orbitTo({ phi: hasSlice ? 0.85 : 1.48 });
  }, [hasSlice]);

  // Current arrow, placed on the upstream side and pointing downstream.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const a = (currentDir * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    c.arrow.setDirection(dir);
    c.arrow.position.copy(dir.clone().multiplyScalar(-(R + 22))).setY(2);
    c.render();
  }, [currentDir]);


  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <div ref={labelsRef} className="scene-labels">
        {findings.map((f) => (
          <button key={f.id} className={`scene-label${f.kind === 'hole' ? ' hole' : ''}`} onClick={() => onSelectFinding(f)}>
            <span className="pin" aria-hidden="true" />
            {labelFor(f)}
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
