/**
 * The BlueROV2 drone model (simplified mesh from UUVControl/bluerov2, Apache-2.0; see
 * public/models/NOTICE.md), loaded once and shared by the 3D views.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

let pending: Promise<THREE.BufferGeometry> | null = null;

/**
 * Geometry oriented for three.js: up is +y and the vehicle faces along local −z, so `lookAt` turns
 * its long axis along the travel direction. Normalised to 1 unit long; callers scale it up.
 */
export function robotGeometry(): Promise<THREE.BufferGeometry> {
  if (!pending) {
    pending = new STLLoader()
      .loadAsync(`${import.meta.env.BASE_URL}models/bluerov2.stl`)
      .then((g) => {
        g.rotateX(-Math.PI / 2); // ROS model: length along y, up along z
        g.computeBoundingBox();
        const size = new THREE.Vector3();
        g.boundingBox!.getSize(size);
        const s = 1 / Math.max(size.x, size.y, size.z);
        g.scale(s, s, s);
        g.computeVertexNormals();
        return g;
      });
  }
  return pending;
}

/** Placeholder shape shown for the moment before the model has loaded. */
export const placeholderGeometry = new THREE.BoxGeometry(0.75, 0.55, 1);

export const ROBOT_COLOR = '#2b3439';
