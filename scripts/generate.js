/**
 * generate.js
 * -----------------------------------------------------------------------
 * Full dataset generation run:
 *   1) read config + manifest
 *   2) start the Vite preview server (serving the built src/)
 *   3) launch Puppeteer, wait for the Three.js scene to be ready
 *   4) for each shot: build a random plan (Node) -> execute it in the
 *      browser (Three.js) -> read bounding boxes -> screenshot -> save
 *   5) if a shot fails for a retriable reason (placement failed), retry it
 *      with a new random plan (up to randomization.maxPlanRetries times)
 *   6) if a shot fails for a non-retriable reason, or the browser/page
 *      itself crashes, the run does NOT abort: the failure is logged to
 *      dataset_staging/failed_shots.log and generation continues with the
 *      next shot (relaunching the browser first if it crashed)
 *   7) already-produced shots (found in meta.jsonl) are skipped on restart,
 *      so a killed/crashed process can simply be re-run to resume
 *
 * Run: npm run generate   (after npm run discover and npm run build)
 * -----------------------------------------------------------------------
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";
import { PipelineError, explainError, isRetriableMessage, isFatalInfraMessage } from "./errors.js";
import { buildShotPlan, buildUsableManifest } from "./shotPlanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CONFIG_PATH = path.join(ROOT, "public", "config", "generation.config.json");
const MANIFEST_PATH = path.join(ROOT, "public", "config", "manifest.json");
const STAGING_DIR = path.join(ROOT, "dataset_staging");
const IMAGES_DIR = path.join(STAGING_DIR, "images");
const LABELS_DIR = path.join(STAGING_DIR, "labels");
const META_PATH = path.join(STAGING_DIR, "meta.jsonl");
const CLASSES_PATH = path.join(STAGING_DIR, "classes.txt");
const FAILED_LOG_PATH = path.join(STAGING_DIR, "failed_shots.log");

const PREVIEW_PORT = 5183;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;
const MAX_BROWSER_RELAUNCHES = 5;

function readJSON(p, label) {
  if (!fs.existsSync(p)) {
    throw new PipelineError(`${label} not found: ${p}`, {
      code: label.includes("manifest") ? "MANIFEST_MISSING" : "CONFIG_MISSING",
      hint: label.includes("manifest") ? "Run `npm run discover`." : "public/config/generation.config.json must exist.",
    });
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    throw new PipelineError(`Invalid JSON file: ${p}`, {
      code: "INVALID_JSON",
      hint: "Check for a missing/extra comma or brace.",
      cause: err,
    });
  }
}

function validateConfig(config, manifest) {
  for (const className of manifest.classes) {
    if (!config.models[className]) {
      throw new PipelineError(`Class "${className}" exists in public/models but is not defined in generation.config.json.`, {
        code: "CLASS_NOT_IN_CONFIG",
        hint: `Add an entry for "${className}" under "models" in generation.config.json (scale/targetHeightMeters + colors).`,
      });
    }
  }

  const manifestClasses = new Set(manifest.classes);
  const configuredButMissing = Object.keys(config.models).filter((c) => !manifestClasses.has(c));
  if (configuredButMissing.length > 0) {
    console.warn(
      `\nWARNING: the following class(es) are defined in generation.config.json but have no folder/model files under public/models, so they will NEVER appear in any generated image: ${configuredButMissing.join(
        ", "
      )}.\nFix: add e.g. public/models/${configuredButMissing[0]}/<file>.glb (or .fbx/.gltf/.obj) and re-run "npm run discover".\n`
    );
  }
}

function ensureStagingDirs() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(LABELS_DIR, { recursive: true });
}

/** Reads already-completed shotIds from an existing meta.jsonl, if any (resume support). */
function loadAlreadyDoneShotIds() {
  const done = new Set();
  if (!fs.existsSync(META_PATH)) return done;
  const lines = fs.readFileSync(META_PATH, "utf-8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.shotId) done.add(obj.shotId);
    } catch {
      // ignore malformed line
    }
  }
  return done;
}

function startPreviewServer() {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "npx.cmd" : "npx";
    const child = spawn(cmd, ["vite", "preview", "--port", String(PREVIEW_PORT), "--strictPort"], {
      cwd: ROOT,
      shell: false,
    });

    let resolved = false;
    let logBuffer = "";

    const onData = (data) => {
      logBuffer += data.toString();
      if (!resolved && /Local:/i.test(logBuffer)) {
        resolved = true;
        resolve(child);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err) => {
      if (!resolved) reject(err);
    });

    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`PREVIEW_SERVER_EXITED_EARLY: exit code ${code}\n${logBuffer}`));
    });

    setTimeout(async () => {
      if (resolved) return;
      try {
        const res = await fetch(PREVIEW_URL);
        if (res.ok || res.status === 404) {
          resolved = true;
          resolve(child);
        }
      } catch {
        // not ready yet; let the main timeout below fail
      }
    }, 15000);

    setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(
          new PipelineError("Vite preview server did not come up in time.", {
            code: "SERVER_NOT_UP",
            hint: "Make sure `npm run build` ran first and port 5183 is free.",
          })
        );
      }
    }, 30000);
  });
}

async function launchBrowser() {
  try {
    return await puppeteer.launch({
      headless: true,

      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",

        // WebGL / Three.js
        "--enable-webgl",
        "--ignore-gpu-blocklist",

        // Use software renderer only if GPU fails
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",

        "--disable-gpu-sandbox",
        "--window-size=1920,1080",
      ],
    });
  } catch (err) {
    throw new PipelineError("Puppeteer failed to launch Chrome.", {
      code: "CHROME_LAUNCH_FAILED",
      hint: "Check Chrome installation path or executable permissions.",
      cause: err,
    });
  }
}

async function openReadyPage(browser, config) {
  const page = await browser.newPage();
  await page.setViewport({ width: config.output.width, height: config.output.height, deviceScaleFactor: 1 });

  page.on("pageerror", (err) => console.error("[browser pageerror]", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("[browser console.error]", msg.text());
  });

  await page.goto(PREVIEW_URL, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction("window.__rendererReady === true || window.__rendererError", { timeout: 180000 });

  const rendererError = await page.evaluate("window.__rendererError");
  if (rendererError) {
    throw new PipelineError(`The Three.js scene failed to initialize in the browser: ${rendererError}`, {
      code: "RENDERER_INIT_FAILED",
      hint: "The message above usually names a model or background file path that failed to load; check it exists under public/.",
    });
  }

  const failedFiles = (await page.evaluate("window.__failedModelFiles")) || [];
  return { page, failedFiles };
}

function yoloLine(classIndex, box) {
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return [classIndex, clamp01(box.cx).toFixed(6), clamp01(box.cy).toFixed(6), clamp01(box.w).toFixed(6), clamp01(box.h).toFixed(6)].join(" ");
}

async function main() {
  console.log("Reading config and manifest...");
  const config = readJSON(CONFIG_PATH, "generation.config.json");
  const rawManifest = readJSON(MANIFEST_PATH, "manifest.json (run: npm run discover)");
  validateConfig(config, rawManifest);

  ensureStagingDirs();
  const alreadyDone = loadAlreadyDoneShotIds();
  if (alreadyDone.size > 0) {
    console.log(`Resuming: ${alreadyDone.size} shot(s) already exist in meta.jsonl and will be skipped.`);
  }

  const classIndex = {};
  rawManifest.classes.forEach((c, i) => (classIndex[c] = i));
  fs.writeFileSync(CLASSES_PATH, rawManifest.classes.join("\n") + "\n", "utf-8");

  const metaStream = fs.createWriteStream(META_PATH, { flags: "a" });
  const failedLogStream = fs.createWriteStream(FAILED_LOG_PATH, { flags: "a" });

  console.log("Starting Vite preview server...");
  const previewProcess = await startPreviewServer();

  console.log("Launching Puppeteer...");
  let browser = await launchBrowser();
  let { page, failedFiles } = await openReadyPage(browser, config);
  let manifest = buildUsableManifest(rawManifest, failedFiles);
  let browserRelaunches = 0;

  async function relaunchBrowser(reason) {
    browserRelaunches++;
    console.warn(`Relaunching browser (attempt ${browserRelaunches}/${MAX_BROWSER_RELAUNCHES}) after: ${reason}`);
    if (browserRelaunches > MAX_BROWSER_RELAUNCHES) {
      throw new PipelineError("The browser crashed too many times in this run.", {
        code: "TOO_MANY_RELAUNCHES",
        hint: "There is likely a systematically broken model file causing repeated GPU/renderer crashes. Check failed_shots.log for the file names involved.",
      });
    }
    await browser.close().catch(() => {});
    browser = await launchBrowser();
    const ready = await openReadyPage(browser, config);
    page = ready.page;
    manifest = buildUsableManifest(rawManifest, ready.failedFiles);
  }

  try {
    const total = config.totalImages;
    const maxRetries = config.randomization.maxPlanRetries;
    let written = alreadyDone.size;
    let failedCount = 0;
    const startTime = Date.now();

    for (let shotIndex = 1; shotIndex <= total; shotIndex++) {
      const candidateId = String(shotIndex).padStart(6, "0");
      if (alreadyDone.has(candidateId)) continue;

      let result = null;
      let lastErr = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const plan = buildShotPlan(shotIndex, manifest, config);
        try {
          result = await page.evaluate((p) => window.generateShot(p), plan);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const msg = err.message || String(err);

          if (isFatalInfraMessage(msg)) {
            try {
              await relaunchBrowser(msg);
            } catch (relaunchErr) {
              throw relaunchErr; // exhausted relaunch budget -> truly fatal, stop the run
            }
            continue; // retry this same attempt slot with the fresh browser
          }

          if (!isRetriableMessage(msg)) break; // non-retriable, single-shot failure
        }
      }

      if (lastErr) {
        failedCount++;
        const explanation = explainError(lastErr);
        console.error(`\nShot ${candidateId} failed after retries, skipping it and continuing.\n${explanation}`);
        failedLogStream.write(`--- shot ${candidateId} ---\n${explanation}\n\n`);
        continue;
      }

      if (!result || result.boxes.length === 0) {
        // Every object in this shot ended up occluded/out of frame; skip it.
        continue;
      }

      const shotId = result.shotId;
      const imagePath = path.join(IMAGES_DIR, `${shotId}.png`);
      const labelPath = path.join(LABELS_DIR, `${shotId}.txt`);

      try {
        const canvasHandle = await page.$("#render-canvas");
        await canvasHandle.screenshot({ path: imagePath });
      } catch (err) {
        failedCount++;
        const explanation = explainError(err);
        console.error(`\nScreenshot failed for shot ${shotId}, skipping it.\n${explanation}`);
        failedLogStream.write(`--- shot ${shotId} (screenshot) ---\n${explanation}\n\n`);
        if (isFatalInfraMessage(err.message || "")) {
          await relaunchBrowser(err.message);
        }
        continue;
      }

      const lines = result.boxes.map((b) => yoloLine(classIndex[b.className], b));
      fs.writeFileSync(labelPath, lines.join("\n") + "\n", "utf-8");

      const classesPresent = [...new Set(result.boxes.map((b) => b.className))];
      metaStream.write(JSON.stringify({ shotId, classesPresent }) + "\n");

      written++;
      if (written % 25 === 0 || written === total) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = written / Math.max(elapsedSec, 0.001);
        const remaining = Math.max(0, total - written);
        const etaSec = remaining / Math.max(rate, 0.001);
        console.log(
          `${written}/${total} shots done | ${rate.toFixed(2)} img/s | ETA ${(etaSec / 60).toFixed(1)} min | failed so far: ${failedCount}`
        );
      }
    }

    metaStream.end();
    failedLogStream.end();
    console.log(`\nGeneration finished. ${written}/${total} images saved to ${STAGING_DIR}.`);
    if (failedCount > 0) {
      console.log(`${failedCount} shot(s) failed and were skipped — see ${FAILED_LOG_PATH} for details.`);
    }
    console.log("Next step: npm run split");

    // ============================================================
    // Save shot logger data from the browser
    // ============================================================
    try {
      const logData = await page.evaluate(() => {
        const logger = window.__shotLogger;
        if (logger) {
          return logger.exportToJSON();
        }
        return null;
      });
      
      if (logData) {
        const logPath = path.join(STAGING_DIR, 'shot_log.json');
        fs.writeFileSync(logPath, JSON.stringify(logData, null, 2), 'utf-8');
        console.log(`\n✅ Shot log saved to: ${logPath}`);
        
        // Print summary
        console.log('\n========== SHOT LOG SUMMARY ==========');
        console.log(`Total Shots: ${logData.summary.totalShots}`);
        console.log(`Successful: ${logData.summary.successfulShots}`);
        console.log(`Failed: ${logData.summary.failedShots}`);
        console.log(`Success Rate: ${logData.summary.successRate}`);
        console.log('\n--- Model Usage ---');
        for (const [className, stats] of Object.entries(logData.summary.classStats)) {
          console.log(`  ${className}: ${stats.totalInstances} instances, ${stats.uniqueFiles} unique files`);
          if (stats.files.length <= 3) {
            console.log(`    Files: ${stats.files.join(', ')}`);
          } else {
            console.log(`    Files (first 3): ${stats.files.slice(0, 3).join(', ')}... (${stats.files.length} total)`);
          }
        }
        if (logData.summary.failedShotsList.length > 0) {
          console.log('\n--- Failed Shots ---');
          for (const fail of logData.summary.failedShotsList) {
            console.log(`  ${fail.shotId}: ${fail.error}`);
            console.log(`    Objects: ${fail.objects.join(', ')}`);
          }
        }
        console.log('========================================\n');
        
        // Also save a more detailed per-shot log for debugging individual models
        const detailedLogPath = path.join(STAGING_DIR, 'shot_log_detailed.json');
        fs.writeFileSync(detailedLogPath, JSON.stringify(logData, null, 2), 'utf-8');
        console.log(`✅ Detailed shot log saved to: ${detailedLogPath}`);
      } else {
        console.warn('⚠️ Shot logger not available in browser context');
      }
    } catch (logErr) {
      console.warn('⚠️ Could not save shot log:', logErr.message);
    }

  } finally {
    await browser.close().catch(() => {});
    previewProcess.kill();
  }
}

main().catch((err) => {
  console.error("\n" + explainError(err));
  if (err && err.cause) {
    console.error("\n(underlying error for debugging:)");
    console.error(err.cause);
  }
  process.exit(1);
});