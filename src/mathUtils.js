import * as THREE from "three";

/**
 * Returns the camera's local basis vectors (forward / right / up) in world
 * space. The camera is static, so this is computed once and reused.
 */
export function getCameraBasis(camera) {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward); // normalized
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { forward, right, up };
}

/**
 * Half-width / half-height of the camera frustum at a given depth (meters
 * along the forward vector, measured from the camera position).
 */
export function frustumHalfSizeAtDepth(camera, depth) {
  const vFovRad = THREE.MathUtils.degToRad(camera.fov);
  const halfHeight = Math.tan(vFovRad / 2) * depth;
  const halfWidth = halfHeight * camera.aspect;
  return { halfWidth, halfHeight };
}

/**
 * Builds a world position from camera-local coordinates: offsetRight and
 * offsetUp are in meters relative to the frame center at that depth.
 */
export function pointFromCameraLocal(camera, basis, depth, offsetRight, offsetUp) {
  const p = new THREE.Vector3().copy(camera.position);
  p.addScaledVector(basis.forward, depth);
  p.addScaledVector(basis.right, offsetRight);
  p.addScaledVector(basis.up, offsetUp);
  return p;
}

export function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

const _raycaster = new THREE.Raycaster();
const _groundPlane = new THREE.Plane();

/**
 * Casts a ray from the camera through a normalized screen point (u, v in
 * [0,1], origin at top-left, same convention as the background image /
 * ground-zone polygons and the YOLO bounding boxes) and intersects it with
 * the horizontal ground plane y = groundY.
 *
 * This is how a 2D "zone" drawn on the flat background photo gets turned
 * into a real 3D world position: since the camera and background are both
 * fixed, every screen pixel corresponds to exactly one ray, and that ray
 * hits the virtual ground plane at exactly one point (assuming it isn't
 * parallel to the ground).
 *
 * Returns a THREE.Vector3 world position, or null if the ray cannot hit
 * the ground plane (looking above the horizon, etc).
 */
export function screenPointToGroundWorld(camera, u, v, groundY = 0) {
  const ndcX = u * 2 - 1;
  const ndcY = -(v * 2 - 1);
  _raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
  _groundPlane.set(new THREE.Vector3(0, 1, 0), -groundY);
  const target = new THREE.Vector3();
  const hit = _raycaster.ray.intersectPlane(_groundPlane, target);
  if (!hit) return null;
  if (!Number.isFinite(hit.x) || !Number.isFinite(hit.y) || !Number.isFinite(hit.z)) return null;
  return hit;
}
