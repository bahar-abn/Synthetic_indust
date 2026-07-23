import * as THREE from "three";
import { buildScene, setBackgroundTexture } from "./sceneBuilder.js";
import { 
  preloadAllModels, 
  instantiateModel, 
  disposeInstance,
  setClassSizeProfiles,
  calculateSceneFactor,
  calculateShotScaleFactor
} from "./modelLoader.js";
import { arrangeAndFit } from "./layoutManager.js";
import { getWorldBox3, getFootprintRadius, projectObjectToScreen, computeVisibilityRatio } from "./bboxCalculator.js";
import { loadGroundZonesFile, getZonesForBackground } from "./groundZones.js";
import { PipelineError, explainError } from "../scripts/errors.js";
import { getShotLogger } from "./shotLogger.js";

const statusEl = document.getElementById("status");
function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
  console.log("[status]", text);
}

function waitTwoFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function bootstrap() {
  setStatus("Loading config...");
  const config = await fetchJSON("/config/generation.config.json");

  setStatus("Loading manifest...");
  const manifest = await fetchJSON("/config/manifest.json");

  setStatus("Loading class size profiles...");
  let classSizeProfiles = null;
  try {
    classSizeProfiles = await fetchJSON("/config/classSizeProfiles.json");
    setClassSizeProfiles(classSizeProfiles);
    console.log("[bootstrap] Loaded class size profiles:", Object.keys(classSizeProfiles));
  } catch (err) {
    console.warn("[bootstrap] classSizeProfiles.json not found, using legacy scaling");
  }

  setStatus("Loading model scale overrides...");
  let scaleOverrides = {};
  try {
    scaleOverrides = await fetchJSON("/config/modelScaleOverrides.json");
    const calibrated = Object.keys(scaleOverrides).filter((k) => k !== "_default");
    console.log(`[bootstrap] Loaded manual scale overrides for ${calibrated.length} background(s):`, calibrated);
  } catch (err) {
    console.warn("[bootstrap] modelScaleOverrides.json not found; falling back to automatic scaling for every model. Run `npm run dev`, open /calibrate.html, and hit Save to create it.");
  }

  setStatus("Loading ground zones...");
  const zonesData = await loadGroundZonesFile();
  const zoneCacheByBackground = new Map();
  const sceneFactorCache = new Map();

  setStatus("Building scene...");
  const { scene, camera, renderer, backgroundPlane } = buildScene(config);

  setStatus("Preloading models (this can take a while)...");
  const { failed } = await preloadAllModels(manifest, (done, total, file) => {
    setStatus(`Preloading model ${done}/${total}: ${file}`);
  });
  window.__failedModelFiles = failed;
  if (failed.length > 0) {
    console.warn(`[bootstrap] ${failed.length} model file(s) failed to preload and will be skipped:`, failed);
  }

  let currentObjects = [];
  const logger = getShotLogger();

  function teardownCurrentShot() {
    for (const obj of currentObjects) {
      disposeInstance(obj);
      scene.remove(obj);
    }
    currentObjects = [];
  }

  window.generateShot = async function generateShot(plan) {
    teardownCurrentShot();
    
    // Start logging this shot
    logger.startShot(plan.shotId, plan.background, plan.objects);

    try {
      const bgSize = await setBackgroundTexture(backgroundPlane, plan.background);

      let zones = zoneCacheByBackground.get(plan.background);
      let sceneFactor = sceneFactorCache.get(plan.background);
      
      if (!zones) {
        zones = getZonesForBackground(zonesData, plan.background, bgSize.width, bgSize.height);
        zoneCacheByBackground.set(plan.background, zones);
        
        sceneFactor = calculateSceneFactor(zones, bgSize.width, bgSize.height);
        sceneFactorCache.set(plan.background, sceneFactor);
        console.log(`[sceneFactor] ${plan.background}: ${sceneFactor.toFixed(3)} (${zones.length} zones)`);
      }
      
      if (zones.length === 0) {
        throw new PipelineError(`NO_GROUND_ZONES: no polygon regions found in ground.json for "${plan.background}".`, {
          code: "NO_GROUND_ZONES",
        });
      }

      const shotScaleFactor = calculateShotScaleFactor(plan.objects, classSizeProfiles);
      console.log(`[shotScaleFactor] shot ${plan.shotId}: ${shotScaleFactor.toFixed(3)}`);

      const modelsCfg = config.models;
      const fileOverrides = config.fileOverrides || null;
      const materialOverrides = config.materialOverridesByFile || null;
      
      const placedObjects = [];
      const objectsWithScales = [];

      for (const spec of plan.objects) {
        const classCfg = modelsCfg[spec.className];
        if (!classCfg) {
          throw new PipelineError(`CLASS_NOT_IN_CONFIG: class "${spec.className}" is not defined in generation.config.json.`, {
            code: "CLASS_NOT_IN_CONFIG",
          });
        }
        
        const obj = instantiateModel({
          className: spec.className,
          file: spec.file,
          color: spec.color,
          classCfg,
          sceneFactor: sceneFactor,
          shotScaleFactor: shotScaleFactor,
          fileOverrides: fileOverrides,
          background: plan.background,
          scaleOverrides: scaleOverrides,
          materialOverrides: materialOverrides
        });
        
        obj.rotation.set(
          THREE.MathUtils.degToRad(spec.rotationXDeg || 0),
          THREE.MathUtils.degToRad(spec.rotationYDeg || 0),
          THREE.MathUtils.degToRad(spec.rotationZDeg || 0)
        );
        scene.add(obj);
        currentObjects.push(obj);
        
        // Log scale information
        objectsWithScales.push({
          className: spec.className,
          file: spec.file,
          baseScale: obj.userData.__finalScale / (sceneFactor * shotScaleFactor) || null,
          sceneFactor: sceneFactor,
          shotScaleFactor: shotScaleFactor,
          finalScale: obj.userData.__finalScale || null,
          rawHeight: obj.userData.__rawDimensions?.height || null,
          targetHeight: classSizeProfiles?.[spec.className]?.realHeightMeters || null
        });
      }

      // Log scales before placement
      logger.logScales(objectsWithScales);

      // Ground-zone placement
      arrangeAndFit(currentObjects, camera, config.layout, config.output, zones);

      // Log placement info
      for (const obj of currentObjects) {
        const localBox = getWorldBox3(obj);
        const footprintRadius = getFootprintRadius(localBox);
        placedObjects.push({
          className: obj.userData.className,
          position: obj.position.clone(),
          footprintRadius: footprintRadius,
          screenBox: null // Will be filled after rendering
        });
      }

      renderer.render(scene, camera);
      await waitTwoFrames();
      renderer.render(scene, camera);

      const allMeshes = [];
      scene.traverse((c) => {
        if (c.isMesh) allMeshes.push(c);
      });

      const boxes = [];
      const droppedObjects = [];
      for (const obj of currentObjects) {
        const screenBox = projectObjectToScreen(obj, camera, config.output.width, config.output.height, null);
        if (!screenBox) {
          droppedObjects.push(obj.userData.className);
          continue;
        }

        const visibleRatio = computeVisibilityRatio(obj, allMeshes, camera, config.randomization.occlusionSampleCount);
        if (visibleRatio < config.randomization.occlusionVisibilityThreshold) {
          droppedObjects.push(obj.userData.className);
          continue;
        }

        const w = (screenBox.xmax - screenBox.xmin) / config.output.width;
        const h = (screenBox.ymax - screenBox.ymin) / config.output.height;
        const cx = (screenBox.xmin + screenBox.xmax) / 2 / config.output.width;
        const cy = (screenBox.ymin + screenBox.ymax) / 2 / config.output.height;
        if (w <= 0 || h <= 0) {
          droppedObjects.push(obj.userData.className);
          continue;
        }

        boxes.push({ className: obj.userData.className, cx, cy, w, h, visibleRatio });
        
        // Update placement with screen box
        const placed = placedObjects.find(p => p.className === obj.userData.className);
        if (placed) {
          placed.screenBox = {
            xmin: screenBox.xmin,
            ymin: screenBox.ymin,
            xmax: screenBox.xmax,
            ymax: screenBox.ymax
          };
        }
      }

      // If a shot still renders more than one object, an object that got
      // dropped here is still visible in the final image — it's just
      // unlabeled. Shipping that is worse than a placement failure (it
      // silently teaches the detector that a visible object is
      // background), so treat it the same as a failed placement: fail
      // this shot and let the caller retry with a fresh random plan.
      if (droppedObjects.length > 0) {
        throw new PipelineError(
          `OCCLUDED_OBJECT_DROPPED: ${droppedObjects.length} object(s) [${droppedObjects.join(", ")}] would be visible in the rendered image but too occluded/off-frame for a valid bounding box (shot ${plan.shotId}).`,
          { code: "OCCLUDED_OBJECT_DROPPED", retriable: true }
        );
      }

      // Log bounding boxes and placement
      logger.logPlacement(placedObjects);
      logger.logBoundingBoxes(boxes);
      logger.markSuccess();

      // Print summary every 10 shots
      if (logger.shots.length % 10 === 0) {
        logger.printSummary();
      }

      return { shotId: plan.shotId, boxes };
    } catch (err) {
      const explained = err instanceof PipelineError ? err : err;
      console.error(explainError(explained));
      logger.markFailure(explained);
      throw new Error(explained.message || String(explained));
    }
  };

  // Expose logger to console for debugging
  window.__shotLogger = logger;

  setStatus("Ready. Waiting for window.generateShot calls from Puppeteer...");
  window.__rendererReady = true;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new PipelineError(`FETCH_FAILED: ${url} -> HTTP ${res.status}`, { code: "FETCH_FAILED" });
  }
  return res.json();
}

bootstrap().catch((err) => {
  setStatus("Error: " + err.message);
  console.error(explainError(err));
  window.__rendererError = err.message;
});
