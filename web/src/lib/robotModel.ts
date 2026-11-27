/**
 * The BlueROV2 drone model (from UUVControl/bluerov2, Apache-2.0; see public/models/NOTICE.md),
 * loaded once and shared by the 3D views. Clones share geometry and materials, so 20 drones cost
 * about the same as one.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

let pending: Promise<THREE.Object3D> | null = null;

/**
 * A template oriented for three.js: up is +y and the vehicle faces local +z (so `lookAt` points it
 * along its travel), normalised to 1 unit long. Every mesh in it is marked `shared` so callers never
 * dispose its geometry or materials.
 */
export function robotTemplate(): Promise<THREE.Object3D> {
  if (!pending) {
    pending = new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/bluerov2.glb`).then((gltf) => {
      const model = gltf.scene;
      model.rotation.set(-Math.PI / 2, 0, 0); // source is z-up with its length along x
      const turn = new THREE.Group();
      turn.rotation.y = -Math.PI / 2; // length from x onto +z
      turn.add(model);
      const box = new THREE.Box3().setFromObject(turn);
      const size = box.getSize(new THREE.Vector3());
      const holder = new THREE.Group();
      holder.add(turn);
      turn.position.sub(box.getCenter(new THREE.Vector3()));
      holder.scale.setScalar(1 / Math.max(size.x, size.y, size.z));
      holder.traverse((o) => {
        o.userData.shared = true;
        if (o instanceof THREE.Mesh) {
          const m = o.material as THREE.MeshStandardMaterial;
          m.roughness = 0.55;
          m.metalness = 0.05;
        }
      });
      return holder;
    });
  }
  return pending;
}

/** Placeholder shape for the moment before the model has loaded. */
export const placeholderGeometry = new THREE.BoxGeometry(0.75, 0.55, 1);

export const ROBOT_COLOR = '#2b3439';
