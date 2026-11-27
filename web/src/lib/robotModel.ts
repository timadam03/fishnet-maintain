/**
 * A simple, light drone model in the style of the BlueROV2 (black side frames, blue top covers,
 * white electronics tube, battery tube, six thrusters), built from a dozen primitives with the real
 * vehicle's proportions (about 0.46 × 0.34 × 0.25 m). One merged geometry with vertex colours, so
 * every drone is a single cheap draw.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const FRAME = '#1d2326';
const COVER = '#2f8fc4';
const TUBE = '#e9edef';
const BATTERY = '#c9cfd3';
const THRUSTER = '#2c3438';

function part(geometry: THREE.BufferGeometry, colour: string, at: [number, number, number], rotate?: [number, number, number]): THREE.BufferGeometry {
  const g = geometry.toNonIndexed();
  if (rotate) g.rotateX(rotate[0]).rotateY(rotate[1]).rotateZ(rotate[2]);
  g.translate(at[0], at[1], at[2]);
  const c = new THREE.Color(colour);
  const colours = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < colours.length; i += 3) {
    colours[i] = c.r;
    colours[i + 1] = c.g;
    colours[i + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  g.deleteAttribute('uv');
  return g;
}

function build(): THREE.BufferGeometry {
  const alongZ: [number, number, number] = [Math.PI / 2, 0, 0];
  const parts = [
    // Side frames and bottom plate.
    part(new THREE.BoxGeometry(0.02, 0.22, 0.46), FRAME, [0.16, 0, 0]),
    part(new THREE.BoxGeometry(0.02, 0.22, 0.46), FRAME, [-0.16, 0, 0]),
    part(new THREE.BoxGeometry(0.3, 0.014, 0.4), FRAME, [0, -0.115, 0]),
    // Blue top covers.
    part(new THREE.BoxGeometry(0.12, 0.035, 0.32), COVER, [0.085, 0.105, -0.02]),
    part(new THREE.BoxGeometry(0.12, 0.035, 0.32), COVER, [-0.085, 0.105, -0.02]),
    // Electronics tube (front, with a dark dome) and battery tube below.
    part(new THREE.CylinderGeometry(0.055, 0.055, 0.3, 16), TUBE, [0, 0.03, 0.02], alongZ),
    part(new THREE.SphereGeometry(0.055, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), FRAME, [0, 0.03, 0.17], alongZ),
    part(new THREE.CylinderGeometry(0.042, 0.042, 0.24, 12), BATTERY, [0, -0.07, -0.03], alongZ),
  ];
  // Four vectored horizontal thrusters at the corners, two vertical ones on top.
  for (const [x, z] of [
    [0.13, 0.18],
    [-0.13, 0.18],
    [0.13, -0.18],
    [-0.13, -0.18],
  ]) {
    parts.push(part(new THREE.CylinderGeometry(0.038, 0.038, 0.05, 12), THRUSTER, [x, -0.02, z], [Math.PI / 2, 0, (x > 0 ? 1 : -1) * Math.PI / 4]));
  }
  for (const x of [0.12, -0.12]) parts.push(part(new THREE.CylinderGeometry(0.038, 0.038, 0.05, 12), THRUSTER, [x, 0.09, 0]));
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error('Could not build the drone model');
  // Normalise to 1 unit long, facing +z so `lookAt` points it along its travel.
  merged.computeBoundingBox();
  const size = merged.boundingBox!.getSize(new THREE.Vector3());
  merged.scale(1 / size.z, 1 / size.z, 1 / size.z);
  merged.computeVertexNormals();
  return merged;
}

/** Shared by every drone in both 3D views; never dispose it. */
export const robotGeometry = build();
/**
 * Drawn in the transparent pass (still fully opaque) with a later render order, so drones stay crisp
 * when seen through the semi-transparent net instead of being washed out by it.
 */
export const robotMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 1 });
export const ROBOT_RENDER_ORDER = 2;
