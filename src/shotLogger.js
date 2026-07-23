/**
 * shotLogger.js
 * -----------------------------------------------------------------------
 * Logs detailed information about each generated shot including:
 * - Which models were used (full paths)
 * - Their scaling factors
 * - Placement positions
 * - Bounding boxes
 * - Success/failure status
 * 
 * This helps debug model-specific issues and track which files are
 * being used in the dataset.
 * -----------------------------------------------------------------------
 */

import fs from "node:fs";
import path from "node:path";

// This will be used in the browser to collect shot data
export class ShotLogger {
  constructor() {
    this.shots = [];
    this.failedShots = [];
    this.modelUsage = new Map(); // className -> { files: Set, count: number }
    this.currentShot = null;
  }

  /**
   * Start tracking a new shot
   */
  startShot(shotId, background, objects) {
    this.currentShot = {
      shotId,
      background,
      timestamp: new Date().toISOString(),
      objects: objects.map(obj => ({
        className: obj.className,
        file: obj.file,
        color: obj.color,
        rotationXDeg: obj.rotationXDeg || 0,
        rotationYDeg: obj.rotationYDeg || 0,
        rotationZDeg: obj.rotationZDeg || 0,
        scaleFactors: {
          baseScale: null,
          sceneFactor: null,
          shotScaleFactor: null,
          finalScale: null
        },
        placement: {
          position: null,
          footprintRadius: null,
          screenBox: null
        },
        visibility: {
          visibleRatio: null,
          occluded: false
        },
        boundingBox: null
      })),
      success: false,
      error: null,
      boxes: []
    };

    // Track model usage
    for (const obj of objects) {
      const key = obj.className;
      if (!this.modelUsage.has(key)) {
        this.modelUsage.set(key, { files: new Set(), count: 0 });
      }
      this.modelUsage.get(key).files.add(obj.file);
      this.modelUsage.get(key).count++;
    }

    return this.currentShot;
  }

  /**
   * Log scale factors applied to each object
   */
  logScales(objectsWithScales) {
    if (!this.currentShot) return;
    
    for (const obj of this.currentShot.objects) {
      const scaleInfo = objectsWithScales.find(o => o.className === obj.className && o.file === obj.file);
      if (scaleInfo) {
        obj.scaleFactors = {
          baseScale: scaleInfo.baseScale || null,
          sceneFactor: scaleInfo.sceneFactor || null,
          shotScaleFactor: scaleInfo.shotScaleFactor || null,
          finalScale: scaleInfo.finalScale || null,
          rawHeight: scaleInfo.rawHeight || null,
          targetHeight: scaleInfo.targetHeight || null
        };
      }
    }
  }

  /**
   * Log placement information for each object
   */
  logPlacement(placedObjects) {
    if (!this.currentShot) return;
    
    for (const placed of placedObjects) {
      const obj = this.currentShot.objects.find(o => o.className === placed.className);
      if (obj) {
        obj.placement = {
          position: placed.position,
          footprintRadius: placed.footprintRadius,
          screenBox: placed.screenBox
        };
      }
    }
  }

  /**
   * Log bounding boxes after rendering
   */
  logBoundingBoxes(boxes) {
    if (!this.currentShot) return;
    this.currentShot.boxes = boxes;
    
    // Update objects with their bounding boxes
    for (const box of boxes) {
      const obj = this.currentShot.objects.find(o => o.className === box.className);
      if (obj) {
        obj.boundingBox = {
          cx: box.cx,
          cy: box.cy,
          w: box.w,
          h: box.h,
          visibleRatio: box.visibleRatio
        };
        obj.visibility.visibleRatio = box.visibleRatio;
        obj.visibility.occluded = box.visibleRatio < 0.4;
      }
    }
  }

  /**
   * Mark shot as successful
   */
  markSuccess() {
    if (this.currentShot) {
      this.currentShot.success = true;
      this.shots.push(this.currentShot);
      this.currentShot = null;
    }
  }

  /**
   * Mark shot as failed
   */
  markFailure(error) {
    if (this.currentShot) {
      this.currentShot.success = false;
      this.currentShot.error = error.message || String(error);
      this.failedShots.push(this.currentShot);
      this.shots.push(this.currentShot);
      this.currentShot = null;
    }
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const total = this.shots.length;
    const successful = this.shots.filter(s => s.success).length;
    const failed = this.failedShots.length;
    
    const classStats = {};
    for (const [className, data] of this.modelUsage) {
      classStats[className] = {
        totalInstances: data.count,
        uniqueFiles: data.files.size,
        files: Array.from(data.files)
      };
    }

    return {
      totalShots: total,
      successfulShots: successful,
      failedShots: failed,
      successRate: total > 0 ? (successful / total * 100).toFixed(1) + '%' : '0%',
      classStats,
      failedShotsList: this.failedShots.map(s => ({
        shotId: s.shotId,
        error: s.error,
        objects: s.objects.map(o => `${o.className}: ${o.file}`)
      }))
    };
  }

  /**
   * Export to JSON for debugging
   */
  exportToJSON() {
    return {
      generatedAt: new Date().toISOString(),
      summary: this.getSummary(),
      shots: this.shots,
      failedShots: this.failedShots
    };
  }

  /**
   * Save to file (Node.js side)
   */
  saveToFile(outputPath) {
    const data = this.exportToJSON();
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[ShotLogger] Saved to ${outputPath}`);
  }

  /**
   * Print summary to console
   */
  printSummary() {
    const summary = this.getSummary();
    console.log('\n========== SHOT LOGGER SUMMARY ==========');
    console.log(`Total Shots: ${summary.totalShots}`);
    console.log(`Successful: ${summary.successfulShots}`);
    console.log(`Failed: ${summary.failedShots}`);
    console.log(`Success Rate: ${summary.successRate}`);
    console.log('\n--- Model Usage ---');
    for (const [className, stats] of Object.entries(summary.classStats)) {
      console.log(`  ${className}:`);
      console.log(`    Instances: ${stats.totalInstances}`);
      console.log(`    Unique Files: ${stats.uniqueFiles}`);
      if (stats.files.length <= 5) {
        console.log(`    Files: ${stats.files.join(', ')}`);
      } else {
        console.log(`    Files (first 5): ${stats.files.slice(0, 5).join(', ')}... (${stats.files.length} total)`);
      }
    }
    
    if (summary.failedShotsList.length > 0) {
      console.log('\n--- Failed Shots ---');
      for (const fail of summary.failedShotsList) {
        console.log(`  ${fail.shotId}: ${fail.error}`);
        console.log(`    Objects: ${fail.objects.join(', ')}`);
      }
    }
    console.log('==========================================\n');
  }
}

// Singleton instance for browser use
let loggerInstance = null;

export function getShotLogger() {
  if (!loggerInstance) {
    loggerInstance = new ShotLogger();
  }
  return loggerInstance;
}

export function resetShotLogger() {
  loggerInstance = null;
}