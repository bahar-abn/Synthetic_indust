/**
 * discoverAssets.js
 * -----------------------------------------------------------------------
 * Scans public/models: every subfolder = one class. The YOLO class name is
 * exactly the folder name (e.g. "Compressor"). Also scans
 * public/backgrounds. Result is written to public/config/manifest.json so
 * both the browser (Three.js) and the Node scripts read the same source
 * of truth.
 *
 * Run: npm run discover
 * -----------------------------------------------------------------------
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineError, explainError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MODELS_DIR = path.join(ROOT, "public", "models");
const BACKGROUNDS_DIR = path.join(ROOT, "public", "backgrounds");
const OUT_PATH = path.join(ROOT, "public", "config", "manifest.json");

const MODEL_EXTS = new Set([".fbx", ".glb", ".gltf", ".obj"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function listDirsSafe(dir) {
  if (!fs.existsSync(dir)) {
    throw new PipelineError(`Directory not found: ${dir}`, {
      code: "DIR_NOT_FOUND",
      hint: `Make sure ${dir} exists.`,
    });
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function findModelFiles(dir, baseDir = dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findModelFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (MODEL_EXTS.has(ext)) {
        const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");
        results.push(relPath);
      }
    }
  }
  return results.sort();
}

function discoverModels() {
  const classNames = listDirsSafe(MODELS_DIR);
  if (classNames.length === 0) {
    throw new PipelineError("No class folders found inside public/models.", {
      code: "NO_CLASS_FOLDERS",
      hint: "Create at least one folder like public/models/Compressor and put an fbx/glb/obj file inside it.",
    });
  }

  const models = {};
  for (const className of classNames) {
    const classDir = path.join(MODELS_DIR, className);
    const files = findModelFiles(classDir);
    if (files.length === 0) {
      throw new PipelineError(`No model files found in class folder: ${className}`, {
        code: "NO_MODEL_IN_CLASS",
        hint: `Put at least one .fbx, .glb, .gltf or .obj file (at any depth) inside public/models/${className}.`,
      });
    }
    models[className] = files.map((f) => `models/${className}/${f}`);
  }
  return models;
}

function discoverBackgrounds() {
  if (!fs.existsSync(BACKGROUNDS_DIR)) {
    throw new PipelineError("public/backgrounds directory not found.", {
      code: "NO_BACKGROUNDS_DIR",
      hint: "Create public/backgrounds and put at least one image inside it.",
    });
  }
  const files = fs.readdirSync(BACKGROUNDS_DIR).filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  if (files.length === 0) {
    throw new PipelineError("No background images found in public/backgrounds.", {
      code: "NO_BACKGROUNDS",
      hint: "Add at least one jpg/png/webp studio or factory-floor photo to public/backgrounds.",
    });
  }
  return files.map((f) => `backgrounds/${f}`);
}

function main() {
  console.log("Scanning public/models and public/backgrounds...");
  const models = discoverModels();
  const backgrounds = discoverBackgrounds();

  const manifest = {
    generatedAt: new Date().toISOString(),
    classes: Object.keys(models).sort(),
    models,
    backgrounds,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2), "utf-8");

  console.log("manifest.json written to:", OUT_PATH);
  console.log(`Classes (${manifest.classes.length}):`, manifest.classes.join(", "));
  for (const c of manifest.classes) {
    console.log(`  - ${c}: ${models[c].length} model file(s)`);
  }
  console.log(`Backgrounds: ${backgrounds.length} image(s)`);

  if (!fs.existsSync(path.join(ROOT, "public", "config", "ground.json"))) {
    console.warn(
      "\nWARNING: public/config/ground.json was not found. Ground-zone placement requires a polygon region per background image (see README.md)."
    );
  }
}

try {
  main();
} catch (err) {
  console.error("\n" + explainError(err));
  process.exit(1);
}
