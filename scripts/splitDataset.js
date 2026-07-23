/**
 * splitDataset.js
 * -----------------------------------------------------------------------
 * Reads the images/labels produced in dataset_staging and performs a
 * stratified split (by the set of classes present in each shot) into
 * train (70%) / val (20%) / test (10%) so class distribution stays close
 * to uniform across all three splits.
 *
 * Run: npm run split   (after npm run generate)
 * -----------------------------------------------------------------------
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineError, explainError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const STAGING_DIR = path.join(ROOT, "dataset_staging");
const META_PATH = path.join(STAGING_DIR, "meta.jsonl");
const CLASSES_PATH = path.join(STAGING_DIR, "classes.txt");
const CONFIG_PATH = path.join(ROOT, "public", "config", "generation.config.json");

const OUT_DIR = path.join(ROOT, "dataset");

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadMeta() {
  if (!fs.existsSync(META_PATH)) {
    throw new PipelineError("meta.jsonl not found.", {
      code: "META_MISSING",
      hint: "Run `npm run generate` to completion first.",
    });
  }
  const lines = fs.readFileSync(META_PATH, "utf-8").trim().split("\n").filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const l of lines) {
    const item = JSON.parse(l);
    if (seen.has(item.shotId)) continue; // guards against duplicate lines from a resumed run
    seen.add(item.shotId);
    unique.push(item);
  }
  return unique;
}

function ensureCleanDir(p) {
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
}

function copyPair(shotId, split) {
  const srcImg = path.join(STAGING_DIR, "images", `${shotId}.png`);
  const srcLbl = path.join(STAGING_DIR, "labels", `${shotId}.txt`);
  if (!fs.existsSync(srcImg) || !fs.existsSync(srcLbl)) return false;
  const dstImg = path.join(OUT_DIR, split, "images", `${shotId}.png`);
  const dstLbl = path.join(OUT_DIR, split, "labels", `${shotId}.txt`);
  fs.copyFileSync(srcImg, dstImg);
  fs.copyFileSync(srcLbl, dstLbl);
  return true;
}

function main() {
  console.log("Reading meta.jsonl and classes.txt...");
  const meta = loadMeta();
  if (!fs.existsSync(CLASSES_PATH)) {
    throw new PipelineError("classes.txt not found.", {
      code: "CLASSES_MISSING",
      hint: "Run `npm run generate` to completion first.",
    });
  }
  const classes = fs.readFileSync(CLASSES_PATH, "utf-8").trim().split("\n").filter(Boolean);
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const { train, val, test } = config.split;

  const ratioSum = train + val + test;
  if (Math.abs(ratioSum - 1) > 0.001) {
    throw new PipelineError(`The split ratios in config do not add up to 1 (currently ${ratioSum}).`, {
      code: "SPLIT_RATIO_INVALID",
      hint: "Set split.train / split.val / split.test so they add up to exactly 1 (e.g. 0.7/0.2/0.1).",
    });
  }

  const groups = new Map();
  for (const item of meta) {
    const key = item.classesPresent.slice().sort().join("+");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.shotId);
  }

  console.log(`Total shots: ${meta.length} | distinct class combinations: ${groups.size}`);

  ensureCleanDir(path.join(OUT_DIR, "train", "images"));
  fs.mkdirSync(path.join(OUT_DIR, "train", "labels"), { recursive: true });
  ensureCleanDir(path.join(OUT_DIR, "val", "images"));
  fs.mkdirSync(path.join(OUT_DIR, "val", "labels"), { recursive: true });
  ensureCleanDir(path.join(OUT_DIR, "test", "images"));
  fs.mkdirSync(path.join(OUT_DIR, "test", "labels"), { recursive: true });

  const counts = { train: 0, val: 0, test: 0 };
  let skippedMissing = 0;

  for (const [, shotIds] of groups) {
    const shuffled = shuffle(shotIds);
    const n = shuffled.length;
    const nTrain = Math.round(n * train);
    const nVal = Math.round(n * val);
    const nTest = n - nTrain - nVal;

    const trainIds = shuffled.slice(0, nTrain);
    const valIds = shuffled.slice(nTrain, nTrain + nVal);
    const testIds = shuffled.slice(nTrain + nVal);

    for (const id of trainIds) { if (copyPair(id, "train")) counts.train++; else skippedMissing++; }
    for (const id of valIds) { if (copyPair(id, "val")) counts.val++; else skippedMissing++; }
    for (const id of testIds) { if (copyPair(id, "test")) counts.test++; else skippedMissing++; }
  }

  const yamlContent = buildDataYaml(classes);
  fs.writeFileSync(path.join(OUT_DIR, "data.yaml"), yamlContent, "utf-8");
  fs.copyFileSync(CLASSES_PATH, path.join(OUT_DIR, "classes.txt"));

  console.log("Split complete:");
  console.log(`   train: ${counts.train}`);
  console.log(`   val:   ${counts.val}`);
  console.log(`   test:  ${counts.test}`);
  if (skippedMissing > 0) console.log(`   skipped (missing image/label file): ${skippedMissing}`);
  console.log(`   output: ${OUT_DIR}`);
}

function buildDataYaml(classes) {
  const names = classes.map((c, i) => `  ${i}: ${c}`).join("\n");
  return `# auto-generated by splitDataset.js -- do not edit by hand
path: ${OUT_DIR.replace(/\\/g, "/")}
train: train/images
val: val/images
test: test/images

nc: ${classes.length}
names:
${names}
`;
}

try {
  main();
} catch (err) {
  console.error("\n" + explainError(err));
  process.exit(1);
}
