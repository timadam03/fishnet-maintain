/**
 * A simple, light drone model in the style of the BlueROV2 (rounded black side frames with a window,
 * blue top fairings, white electronics tube with camera dome, battery tube, six ducted thrusters), built
 * from a dozen primitives with the real
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

/** Side frame: a rounded plate with a large window, in the y–z plane. */
function framePlate(): THREE.BufferGeometry {
  const rounded = (w: number, h: number, r: number): THREE.Shape => {
    const sh = new THREE.Shape();
    sh.moveTo(-w / 2 + r, -h / 2);
    sh.lineTo(w / 2 - r, -h / 2);
    sh.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    sh.lineTo(w / 2, h / 2 - r);
    sh.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    sh.lineTo(-w / 2 + r, h / 2);
    sh.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    sh.lineTo(-w / 2, -h / 2 + r);
    sh.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    return sh;
  };
  const outer = rounded(0.46, 0.22, 0.05);
  const window = rounded(0.3, 0.11, 0.03);
  outer.holes.push(new THREE.Path(window.getPoints(4)));
  const g = new THREE.ExtrudeGeometry(outer, { depth: 0.014, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -0.007);
  g.rotateY(Math.PI / 2); // plate length from x onto z
  return g;
}

function build(): THREE.BufferGeometry {
  const alongZ: [number, number, number] = [Math.PI / 2, 0, 0];
  const pod = (): THREE.BufferGeometry => new THREE.CapsuleGeometry(0.05, 0.24, 4, 12).scale(1.15, 1, 0.55);
  const parts = [
    // Side frames and a slim bottom rail.
    part(framePlate(), FRAME, [0.165, 0, 0]),
    part(framePlate(), FRAME, [-0.165, 0, 0]),
    part(new THREE.CapsuleGeometry(0.012, 0.36, 2, 6), FRAME, [0, -0.11, 0], alongZ),
    // Rounded blue top fairings.
    part(pod(), COVER, [0.085, 0.1, -0.02], alongZ),
    part(pod(), COVER, [-0.085, 0.1, -0.02], alongZ),
    // Electronics tube with a dark camera dome at the front, battery tube below.
    part(new THREE.CapsuleGeometry(0.055, 0.22, 4, 16), TUBE, [0, 0.025, 0.01], alongZ),
    part(new THREE.SphereGeometry(0.05, 12, 8), FRAME, [0, 0.025, 0.16]),
    part(new THREE.CapsuleGeometry(0.04, 0.18, 3, 12), BATTERY, [0, -0.07, -0.03], alongZ),
  ];
  // Ducted thrusters: four vectored at the corners, two vertical on top.
  const duct = (): THREE.BufferGeometry => mergeGeometries([new THREE.TorusGeometry(0.04, 0.009, 6, 18), new THREE.CylinderGeometry(0.012, 0.012, 0.03, 8).rotateX(Math.PI / 2)])!;
  for (const [x, z] of [
    [0.13, 0.19],
    [-0.13, 0.19],
    [0.13, -0.19],
    [-0.13, -0.19],
  ]) {
    parts.push(part(duct(), THRUSTER, [x, -0.02, z], [0, (x > 0 ? 1 : -1) * (z > 0 ? 1 : -1) * Math.PI / 4, 0]));
  }
  for (const x of [0.12, -0.12]) parts.push(part(duct(), THRUSTER, [x, 0.09, 0.0], [Math.PI / 2, 0, 0]));
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
