import * as THREE from "three";

/**
 * World-space Box3 of an object3D (rotation + scale + position already
 * baked in via the world matrix). Used for collision footprint math, not
 * for the final 2D bounding box (that uses per-vertex projection below,
 * which stays tight even when the object is rotated).
 */
export function getWorldBox3(object3D) {
  object3D.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object3D);
}

/**
 * Half-extent in the XZ (ground) plane, used as the collision-footprint
 * radius when checking overlap between two placed objects.
 */
export function getFootprintRadius(box3) {
  const size = new THREE.Vector3();
  box3.getSize(size);
  return Math.max(size.x, size.z) / 2;
}

/**
 * Projects every mesh vertex of an object (after world transform) onto the
 * screen and returns the tight 2D bounding box in pixels. This stays
 * accurate under arbitrary rotation, unlike projecting the 8 corners of an
 * axis-aligned Box3 (which over-estimates the box as soon as the object is
 * rotated away from axis alignment).
 *
 * maxSamples caps total vertices sampled across all meshes, for speed
 * during the placement search loop; pass null for the final, full-accuracy
 * pass used to write the YOLO label.
 *
 * Returns { xmin, ymin, xmax, ymax, rawXmin, rawYmin, rawXmax, rawYmax } in
 * pixels (clip-space rejected verts skipped), or null if nothing projected
 * (fully behind camera / off-frustum).
 */
export function projectObjectToScreen(object3D, camera, width, height, maxSamples = null) {
  object3D.updateWorldMatrix(true, false);

  const meshes = [];
  object3D.traverse((c) => {
    if (c.isMesh) meshes.push(c);
  });

  let rawXmin = Infinity, rawYmin = Infinity, rawXmax = -Infinity, rawYmax = -Infinity;
  const v = new THREE.Vector3();

  for (const mesh of meshes) {
    const posAttr = mesh.geometry.getAttribute("position");
    if (!posAttr) continue;

    const world = mesh.matrixWorld;
    const total = posAttr.count;

    let step = 1;
    if (maxSamples) {
      const perMesh = Math.max(4, Math.floor(maxSamples / meshes.length));
      step = Math.max(1, Math.floor(total / perMesh));
    }

    for (let i = 0; i < total; i += step) {
      v.fromBufferAttribute(posAttr, i);
      v.applyMatrix4(world);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
      v.project(camera);

      if (v.z < -1 || v.z > 1) continue;

      const px = (v.x * 0.5 + 0.5) * width;
      const py = (-v.y * 0.5 + 0.5) * height;

      rawXmin = Math.min(rawXmin, px);
      rawYmin = Math.min(rawYmin, py);
      rawXmax = Math.max(rawXmax, px);
      rawYmax = Math.max(rawYmax, py);
    }
  }

  if (rawXmin === Infinity) return null; // nothing in frustum (e.g. behind camera)

  return {
    xmin: Math.max(0, rawXmin),
    ymin: Math.max(0, rawYmin),
    xmax: Math.min(width, rawXmax),
    ymax: Math.min(height, rawYmax),
    rawXmin,
    rawYmin,
    rawXmax,
    rawYmax,
  };
}

/**
 * Is a raw (unclipped) screen box fully inside the image, with a safety
 * margin of marginRatio on every side?
 */
export function isFullyInFrame(rawBox, width, height, marginRatio) {
  if (!rawBox) return false;
  const mx = width * marginRatio;
  const my = height * marginRatio;
  return (
    rawBox.rawXmin >= mx &&
    rawBox.rawYmin >= my &&
    rawBox.rawXmax <= width - mx &&
    rawBox.rawYmax <= height - my
  );
}

function sampleWorldVertices(object3D, maxSamples) {
  const points = [];
  const meshes = [];
  object3D.traverse((c) => {
    if (c.isMesh) meshes.push(c);
  });
  if (meshes.length === 0) return points;

  const perMesh = Math.max(4, Math.floor(maxSamples / meshes.length));

  for (const mesh of meshes) {
    const posAttr = mesh.geometry.getAttribute("position");
    if (!posAttr) continue;
    const total = posAttr.count;
    const step = Math.max(1, Math.floor(total / perMesh));
    for (let i = 0; i < total; i += step) {
      const local = new THREE.Vector3().fromBufferAttribute(posAttr, i);
      const world = local.applyMatrix4(mesh.matrixWorld);
      if (!Number.isFinite(world.x) || !Number.isFinite(world.y) || !Number.isFinite(world.z)) continue;
      points.push({ world, ownerId: mesh.userData.ownerId });
    }
  }
  return points;
}

/**
 * Fraction of an object's sampled surface points that are actually visible
 * from the camera (i.e. the nearest raycast hit belongs to the object
 * itself, not to something occluding it).
 */
export function computeVisibilityRatio(object3D, allMeshesInScene, camera, sampleCount) {
  const samples = sampleWorldVertices(object3D, sampleCount);
  if (samples.length === 0) return 1;

  const raycaster = new THREE.Raycaster();
  let visible = 0;
  const EPS = 1e-3;

  for (const { world, ownerId } of samples) {
    const dir = new THREE.Vector3().subVectors(world, camera.position).normalize();
    const distToSample = camera.position.distanceTo(world);
    raycaster.set(camera.position, dir);
    raycaster.far = distToSample + 0.5;

    const hits = raycaster.intersectObjects(allMeshesInScene, false);
    if (hits.length === 0) {
      visible++;
      continue;
    }
    const nearest = hits[0];
    const isSelf =
      nearest.object.userData.ownerId === ownerId &&
      Math.abs(nearest.distance - distToSample) < Math.max(EPS, distToSample * 0.01);
    if (isSelf) visible++;
  }

  return visible / samples.length;
}
