/**
 * What the site scene and the pen view share, so flying into a pen hands over without a jump: the
 * site camera ends exactly where the pen view starts, both scenes are lit the same way and use the
 * same fog, rigging, drone placement and clock, and the hand-over is a cross-fade between two frames
 * that already match.
 */
import * as THREE from 'three';
import { CONE_TIP_M, PEN_RADIUS_M, SECTOR_DEG, WALL_DEPTH_M, cellCol } from '../data/model';
import type { Drone } from '../data/swarm';
import { environment } from './environment';
import { netPoint } from './netGeometry';
import { color } from './tokens';

const R = PEN_RADIUS_M;

/** Camera of the pen view, relative to the pen centre. */
export const PEN_VIEW = { fov: 36, target: new THREE.Vector3(0, -15, 0), offset: new THREE.Vector3(85, 9, 95) };

export { FLY_MS, HANDOFF_MS } from './transition';

/**
 * Camera offset from the target for a stage of this aspect ratio: the pen view's angle, pulled back
 * just far enough to keep the whole pen (about 75 m across with the moorings) in view.
 */
export function penViewOffset(aspect: number): THREE.Vector3 {
  const halfFovH = Math.atan(Math.tan(THREE.MathUtils.degToRad(PEN_VIEW.fov / 2)) * aspect);
  const needed = (R + 12) / Math.tan(halfFovH);
  return PEN_VIEW.offset.clone().setLength(Math.max(PEN_VIEW.offset.length(), needed));
}

/** Light inside a pen: soft ambient plus a sun from the camera side. */
export const PEN_LIGHT = { ambient: 1.9, sun: 0.9, sunPosition: new THREE.Vector3(30, 60, 40) };

/** Fog inside a pen: the water closes in beyond the moorings. */
export const PEN_FOG = { color: environment.water, near: 160, far: 420 };

/** Drone size in the pen view (the site draws them larger so they read from afar). */
export const PEN_DRONE_SCALE = 4.5;

/** Seconds on a clock shared by both scenes, so drones keep their place across the hand-over. */
export const sceneClock = (now = performance.now()): number => now / 1000;

/**
 * A drone's position relative to its pen centre: inside the net at its task depth and standoff.
 * Sweeping drones move along either side of their area; targeted ones hold at their viewpoint, and
 * a two-angle look (P4) swings between its two angles.
 */
export function dronePosition(d: Drone, t: number, k: number): THREE.Vector3 {
  if (d.cell === null) return new THREE.Vector3(0, 2, -(R + 30));
  const base = cellCol(d.cell) * SECTOR_DEG + SECTOR_DEG / 2 + d.viewDeg;
  const sweep = d.status === 'sampling' ? 40 * Math.sin(t / 9 + k) : d.rule === 'sweep' ? 9 * Math.sin(t / 3 + k) : d.rule === 'P4' ? 8 * Math.sin(t / 4 + k) : 1.2 * Math.sin(t / 2 + k);
  const depth = d.depth + (d.status === 'sampling' ? 3 * Math.sin(t / 5 + k) : 0);
  return netPoint(Math.min(depth, WALL_DEPTH_M), base + sweep, 1 - Math.max(1, d.standoffM) / R);
}

/** Points a drone along the net, tangent to the pen, the way it sweeps (`p` relative to the pen centre). */
export function faceAlongNet(m: THREE.Object3D, p: THREE.Vector3, centre: THREE.Vector3): void {
  const a = Math.atan2(p.x, -p.z);
  m.lookAt(centre.x + p.x + Math.cos(a), centre.y + p.y, centre.z + p.z + Math.sin(a));
}

/** Floating collar, sinker tube, chains, mooring lines and the cone weight of one pen, centred on the origin. */
export function buildRigging(): THREE.Group {
  const group = new THREE.Group();
  const hdpe = new THREE.MeshLambertMaterial({ color: environment.collar });
  for (const radius of [R + 0.6, R + 2.0]) {
    const torus = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.45, 8, 96), hdpe);
    torus.rotation.x = Math.PI / 2;
    torus.position.y = 0.3;
    group.add(torus);
  }
  const sinker = new THREE.Mesh(new THREE.TorusGeometry(R + 1.2, 0.55, 8, 96), new THREE.MeshLambertMaterial({ color: color.ink3 }));
  sinker.rotation.x = Math.PI / 2;
  sinker.position.y = -(WALL_DEPTH_M + 1.5);
  group.add(sinker);

  const chainPts: THREE.Vector3[] = [];
  for (let a = 0; a < 360; a += 45) {
    const top = netPoint(0, a, (R + 1.2) / R);
    chainPts.push(top, top.clone().setY(-(WALL_DEPTH_M + 1.5)));
  }
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(chainPts), new THREE.LineBasicMaterial({ color: color.ink3 })));

  const moorPts: THREE.Vector3[] = [];
  for (const a of [45, 135, 225, 315]) {
    const end = netPoint(0, a, (R + 45) / R);
    end.y = -38;
    moorPts.push(netPoint(0, a, (R + 2) / R), end);
  }
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(moorPts), new THREE.LineBasicMaterial({ color: color.coast, transparent: true, opacity: 0.6 })));

  const weight = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 12), new THREE.MeshLambertMaterial({ color: color.ink3 }));
  weight.position.y = -CONE_TIP_M - 0.8;
  group.add(weight);
  return group;
}
