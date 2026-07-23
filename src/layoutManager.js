import * as THREE from "three";
import { screenPointToGroundWorld } from "./mathUtils.js";
import { getWorldBox3, getFootprintRadius, projectObjectToScreen, isFullyInFrame } from "./bboxCalculator.js";
import { centerBiasedPointInZones } from "./groundZones.js";
import { PipelineError } from "../scripts/errors.js";

/**
 * Places every object inside the ground zones with improved placement logic.
 */
export function arrangeAndFit(objects, camera, layoutCfg, outputSize, zonesForBackground) {
  if (objects.length === 0) return;

  if (!zonesForBackground || zonesForBackground.length === 0) {
    throw new PipelineError("No ground zone polygons available for this background.", {
      code: "NO_GROUND_ZONES",
      retriable: false,
    });
  }

  const groundY = layoutCfg.groundY ?? 0;
  const minGap = layoutCfg.minGapMeters ?? 0.15;
  const maxAttempts = layoutCfg.maxPlacementAttempts ?? 60;
  const frameMargin = layoutCfg.frameMarginRatio ?? 0.12;

  const placedFootprints = [];

  // Sort objects by footprint radius (largest first) for better packing
  const objectsWithRadius = objects.map((obj) => {
    obj.position.set(0, 0, 0);
    const localBox = getWorldBox3(obj);
    const footprintRadius = getFootprintRadius(localBox);
    const centerOffset = localBox.getCenter(new THREE.Vector3());
    const bottomOffset = -localBox.min.y;
    
    console.log(`[PLACEMENT] ${obj.userData.className}: radius=${footprintRadius.toFixed(3)}, centerOffset=(${centerOffset.x.toFixed(3)}, ${centerOffset.y.toFixed(3)}, ${centerOffset.z.toFixed(3)})`);
    
    return { obj, footprintRadius, centerOffset, bottomOffset };
  });
  
  objectsWithRadius.sort((a, b) => b.footprintRadius - a.footprintRadius);

  for (const { obj, footprintRadius, centerOffset, bottomOffset } of objectsWithRadius) {
    let placed = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Use center-biased random point
      const zonePoint = centerBiasedPointInZones(zonesForBackground);
      if (!zonePoint) break;

      const ground = screenPointToGroundWorld(camera, zonePoint.x, zonePoint.y, groundY);
      if (!ground) continue;

      // Collision check
      let collides = false;
      for (const other of placedFootprints) {
        const dx = (ground.x + centerOffset.x) - other.x;
        const dz = (ground.z + centerOffset.z) - other.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < footprintRadius + other.radius + minGap) {
          collides = true;
          break;
        }
      }
      if (collides) continue;

      // Position the object
      obj.position.set(ground.x, ground.y + bottomOffset, ground.z);

      // Full-precision projection check
      const screenBox = projectObjectToScreen(obj, camera, outputSize.width, outputSize.height, null);
      if (!screenBox) {
        continue;
      }
      
      // Check if object is in frame
      if (!isFullyInFrame(screenBox, outputSize.width, outputSize.height, frameMargin)) {
        continue;
      }

      placedFootprints.push({
        x: ground.x + centerOffset.x,
        z: ground.z + centerOffset.z,
        radius: footprintRadius
      });
      placed = true;
      break;
    }

    if (!placed) {
      // Try one last time with a more lenient frame margin
      let lastChancePlaced = false;
      const lenientMargin = frameMargin * 0.5;
      
      for (let attempt = 0; attempt < 20; attempt++) {
        const zonePoint = centerBiasedPointInZones(zonesForBackground);
        if (!zonePoint) break;

        const ground = screenPointToGroundWorld(camera, zonePoint.x, zonePoint.y, groundY);
        if (!ground) continue;

        // Check collision with existing objects
        let collides = false;
        for (const other of placedFootprints) {
          const dx = (ground.x + centerOffset.x) - other.x;
          const dz = (ground.z + centerOffset.z) - other.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < footprintRadius + other.radius + minGap * 0.5) {
            collides = true;
            break;
          }
        }
        if (collides) continue;

        obj.position.set(ground.x, ground.y + bottomOffset, ground.z);

        const screenBox = projectObjectToScreen(obj, camera, outputSize.width, outputSize.height, null);
        if (!screenBox) continue;
        
        if (isFullyInFrame(screenBox, outputSize.width, outputSize.height, lenientMargin)) {
          placedFootprints.push({
            x: ground.x + centerOffset.x,
            z: ground.z + centerOffset.z,
            radius: footprintRadius
          });
          lastChancePlaced = true;
          console.log(`[PLACEMENT] ${obj.userData.className} placed with lenient margin (attempt ${attempt})`);
          break;
        }
      }
      
      if (!lastChancePlaced) {
        throw new PipelineError(
          `PLACEMENT_FAILED: could not find a non-overlapping, in-frame ground spot for className=${obj.userData.className} after ${maxAttempts} attempts. Footprint radius: ${footprintRadius.toFixed(3)}`,
          { code: "PLACEMENT_FAILED", retriable: true }
        );
      }
    }
  }
}