/** Geometry of one pen's net (wall + bottom cone), shared by the pen view and the 3D site view. */
import * as THREE from 'three';
import { CONE_TIP_M, PEN_RADIUS_M, ROWS, WALL_DEPTH_M, WALL_ROWS } from '../data/model';

const R = PEN_RADIUS_M;
const SEGMENTS = 96;

export function radiusAt(depth: number): number {
  return depth <= WALL_DEPTH_M ? R : R * (1 - (depth - WALL_DEPTH_M) / (CONE_TIP_M - WALL_DEPTH_M));
}

/** Point on the net surface; angle 0 = north (−z), clockwise seen from above. */
export function netPoint(depth: number, deg: number, scale = 1): THREE.Vector3 {
  const a = (deg * Math.PI) / 180;
  const r = radiusAt(depth) * scale;
  return new THREE.Vector3(r * Math.sin(a), -depth, -r * Math.cos(a));
}

/** Depth → position in rows (wall rows are 2.5 m, cone rows 3.33 m); the texture's v coordinate. */
function rowPosition(depth: number): number {
  return depth <= WALL_DEPTH_M ? (depth / WALL_DEPTH_M) * WALL_ROWS : WALL_ROWS + ((depth - WALL_DEPTH_M) / (CONE_TIP_M - WALL_DEPTH_M)) * (ROWS - WALL_ROWS);
}

/** A smooth surface of revolution (wall + cone) with UVs matching the unrolled texture. */
export function buildNetGeometry(): THREE.BufferGeometry {
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

