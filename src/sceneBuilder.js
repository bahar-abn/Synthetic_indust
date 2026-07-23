import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { frustumHalfSizeAtDepth } from "./mathUtils.js";

/**
 * Builds the scene, the (static) camera, the renderer and studio lighting.
 * The camera and renderer are never touched again after this call: camera
 * and background are both fixed for the whole run, only the objects move.
 */
export function buildScene(config) {
  const canvas = document.getElementById("render-canvas");
  const { width, height } = config.output;

  // Canvas size matches the output size exactly so the Puppeteer screenshot
  // and the bounding-box pixel coordinates always agree.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true, // required for a stable screenshot
  });
  renderer.setPixelRatio(1); // never scale implicitly
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();

  const camCfg = config.camera;
  const camera = new THREE.PerspectiveCamera(camCfg.fov, width / height, camCfg.near, camCfg.far);
  camera.position.set(...camCfg.position);
  camera.lookAt(new THREE.Vector3(...camCfg.lookAt));
  camera.updateProjectionMatrix();
  // Camera is never moved/rotated after this point.

  setupLighting(scene, renderer);
  const backgroundPlane = buildBackgroundPlane(scene, camera);

  return { scene, camera, renderer, backgroundPlane };
}

function setupLighting(scene, renderer) {
  // Soft environment lighting for realistic reflections on metallic
  // industrial parts, without needing an external HDRI file.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  pmrem.dispose();

  const ambient = new THREE.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);

  // Studio 3-point setup: key / fill / rim
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3.5, 5, 4);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.9);
  fill.position.set(-4, 2.5, 2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 1.4);
  rim.position.set(0, 4, -5);
  scene.add(rim);
}

/**
 * Builds a large plane behind the scene that the background image is
 * mapped onto. Its size is computed so it exactly fills the camera
 * frustum at its own depth (no empty edges, and — importantly — this
 * means a point normalized to the background image maps 1:1 to a
 * normalized screen point, which groundZones.js relies on).
 */
function buildBackgroundPlane(scene, camera) {
  const depth = camera.far * 0.35;
  const { halfWidth, halfHeight } = frustumHalfSizeAtDepth(camera, depth);

  const geometry = new THREE.PlaneGeometry(halfWidth * 2, halfHeight * 2);
  const material = new THREE.MeshBasicMaterial({ color: 0x222222 });
  const mesh = new THREE.Mesh(geometry, material);

  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  mesh.position.copy(camera.position).addScaledVector(forward, depth);
  mesh.quaternion.copy(camera.quaternion);

  scene.add(mesh);
  return mesh;
}

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();

/**
 * Loads (and caches) the background texture, applies it to the plane, and
 * returns the image's native pixel size — needed to normalize the pixel
 * coordinates stored in ground.json into 0..1 screen-space zones.
 */
export async function setBackgroundTexture(backgroundPlane, relativePath) {
  let cached = textureCache.get(relativePath);
  if (!cached) {
    const tex = await textureLoader.loadAsync("/" + relativePath);
    tex.colorSpace = THREE.SRGBColorSpace;
    cached = { tex, width: tex.image.width, height: tex.image.height };
    textureCache.set(relativePath, cached);
  }
  backgroundPlane.material.map = cached.tex;
  backgroundPlane.material.color.set(0xffffff);
  backgroundPlane.material.needsUpdate = true;
  return { width: cached.width, height: cached.height };
}
