/**
 * shotPlanner.js
 * -----------------------------------------------------------------------
 * All the "what should be in this shot" decisions are made here, on the
 * Node side: how many models, which classes, which source file, which
 * color, which rotation. The Three.js side only executes this plan and
 * does the geometric work (ground placement, bounding boxes, occlusion).
 * Keeping this split makes dataset composition fully debuggable in Node.
 * -----------------------------------------------------------------------
 */

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Weighted pick without replacement from a class list, using
 * shotComposition.classProbability as relative weights.
 */
function weightedPickClasses(classes, weights, count, allowDuplicate) {
  const pool = classes.slice();
  const chosen = [];

  for (let i = 0; i < count; i++) {
    if (pool.length === 0) break;
    const totalWeight = pool.reduce((s, c) => s + (weights[c] ?? 1), 0);
    let r = Math.random() * totalWeight;
    let pickedIndex = 0;
    for (let j = 0; j < pool.length; j++) {
      r -= weights[pool[j]] ?? 1;
      if (r <= 0) {
        pickedIndex = j;
        break;
      }
    }
    chosen.push(pool[pickedIndex]);
    if (!allowDuplicate) pool.splice(pickedIndex, 1);
  }
  return chosen;
}

function buildExclusiveShot(className, manifest, count) {
  const cls = manifest.classes.find(c => c === className);
  if (!cls) {
    throw new Error(`Exclusive class missing: ${className}`);
  }

  const objects = [];
  const files = manifest.models[className];
  for (let i = 0; i < count; i++) {
    objects.push({
      className,
      file: pickRandom(files)
    });
  }

  return objects;
}

/**
 * Builds a usable manifest by removing any model file that failed to load
 * in the browser during preload (see modelLoader.js / main.js), and
 * dropping a class entirely if it ends up with zero usable files.
 */
export function buildUsableManifest(manifest, excludedFiles) {
  if (!excludedFiles || excludedFiles.length === 0) return manifest;
  const excluded = new Set(excludedFiles);

  const models = {};
  const classes = [];
  for (const className of manifest.classes) {
    const files = (manifest.models[className] || []).filter((f) => !excluded.has(f));
    if (files.length > 0) {
      models[className] = files;
      classes.push(className);
    } else {
      console.warn(`[shotPlanner] class "${className}" has no usable model files left after excluding failed ones; it will not appear in this run.`);
    }
  }
  return { ...manifest, classes, models };
}

export function buildShotPlan(shotIndex, manifest, config) {
  const { shotComposition, randomization, models } = config;
  const maxModels = Math.min(shotComposition.maxModelsPerShot, manifest.classes.length);
  const minModels = Math.min(shotComposition.minModelsPerShot, maxModels);

  const count = Math.max(1, randInt(minModels, maxModels));
  
  const exclusiveClasses = config.shotComposition?.exclusiveClasses ?? [];
  const exclusiveChance = 0.25;

  let classNames;

  if (exclusiveClasses.length > 0 && Math.random() < exclusiveChance) {
    const chosenExclusive = exclusiveClasses[Math.floor(Math.random() * exclusiveClasses.length)];
    const exclusiveObjects = buildExclusiveShot(chosenExclusive, manifest, count);
    const background = pickRandom(manifest.backgrounds);
    
    const fullObjects = exclusiveObjects.map((obj) => {
      const classCfg = models[obj.className];
      if (!classCfg) {
        throw new Error(`CLASS_NOT_IN_CONFIG: class "${obj.className}" is not defined in generation.config.json.`);
      }
      return {
        ...obj,
        color: pickRandom(classCfg.colors),
        rotationYDeg: randRange(randomization.rotationYRangeDeg),
        rotationXDeg: randRange(randomization.rotationXRangeDeg),
        rotationZDeg: randRange(randomization.rotationZRangeDeg),
      };
    });

    return {
      shotId: String(shotIndex).padStart(6, "0"),
      background,
      objects: fullObjects,
    };
  }

  // Normal (non-exclusive) shot planning
  classNames = weightedPickClasses(
    manifest.classes,
    shotComposition.classProbability || {},
    count,
    shotComposition.allowDuplicateClassInShot
  );

  const objects = classNames.map((className) => {
    const files = manifest.models[className];
    const classCfg = models[className];
    if (!classCfg) {
      throw new Error(`CLASS_NOT_IN_CONFIG: class "${className}" is not defined in generation.config.json.`);
    }
    return {
      className,
      file: pickRandom(files),
      color: pickRandom(classCfg.colors),
      rotationYDeg: randRange(randomization.rotationYRangeDeg),
      rotationXDeg: randRange(randomization.rotationXRangeDeg),
      rotationZDeg: randRange(randomization.rotationZRangeDeg),
    };
  });

  const background = pickRandom(manifest.backgrounds);

  return {
    shotId: String(shotIndex).padStart(6, "0"),
    background,
    objects,
  };
}