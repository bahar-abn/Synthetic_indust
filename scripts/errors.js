/**
 * errors.js
 * -----------------------------------------------------------------------
 * Universal error model shared by Node scripts AND the Three.js browser
 * bundle (no fs/path imports here, so it is safe to import from src/*.js
 * too). Every error in the pipeline should be raised as a PipelineError
 * (or normal Error with a recognizable message) and explained with
 * explainError() instead of dumping a raw stack trace.
 * -----------------------------------------------------------------------
 */

export class PipelineError extends Error {
  constructor(message, { code, hint, cause, retriable = false } = {}) {
    super(message);
    this.name = "PipelineError";
    this.code = code || "UNKNOWN";
    this.hint = hint || "";
    this.cause = cause;
    this.retriable = retriable;
  }
}

/**
 * Returns true if an error message matches a known "retriable" failure
 * (i.e. only this single shot is bad, the rest of the pipeline is fine).
 */
export function isRetriableMessage(message) {
  const m = (message || "").toUpperCase();
  return (
    m.includes("LAYOUT_FIT_FAILED") ||
    m.includes("PLACEMENT_FAILED") ||
    m.includes("TOO_MANY_OBJECTS_FOR_ZONES") ||
    m.includes("NO_VISIBLE_OBJECTS") ||
    m.includes("OCCLUDED_OBJECT_DROPPED")
  );
}

/**
 * Returns true if an error indicates the browser/page/renderer itself died
 * (not just a bad shot) and the caller should relaunch before retrying.
 */
export function isFatalInfraMessage(message) {
  const m = (message || "").toLowerCase();
  return (
    m.includes("target closed") ||
    m.includes("session closed") ||
    m.includes("protocol error") ||
    m.includes("page crashed") ||
    m.includes("net::err_") ||
    m.includes("detached frame") ||
    m.includes("websocket") ||
    m.includes("disconnected")
  );
}

const RULES = [
  {
    code: "SERVER_NOT_UP",
    test: (l) => l.includes("econnrefused") || l.includes("connect econnrefused"),
    explain:
      "Could not connect to the Vite preview server. The render server that Puppeteer needs is not up yet.",
    hint:
      "Make sure `npm run build` finished successfully before generating. If it still fails, check that port 5183 is free.",
  },
  {
    code: "PORT_BUSY",
    test: (l) => l.includes("eaddrinuse") || l.includes("address already in use"),
    explain: "The preview server port (5183) is already used by another process.",
    hint: "Close the other process, or change PREVIEW_PORT in scripts/generate.js to a free port.",
  },
  {
    code: "CHROMIUM_MISSING",
    test: (l) =>
      l.includes("failed to launch the browser process") ||
      l.includes("could not find chrome") ||
      l.includes("could not find expected browser"),
    explain: "Puppeteer could not find or launch a Chromium binary.",
    hint: "Run `npx puppeteer browsers install chrome` and try again.",
  },
  {
    code: "SANDBOX_ISSUE",
    test: (l) => l.includes("no usable sandbox") || l.includes("running as root without --no-sandbox"),
    explain: "Chromium refused to start in sandboxed mode (common on Linux CI/servers).",
    hint: "The `--no-sandbox` flag is already set in scripts/generate.js; make sure you did not remove it.",
  },
  {
    code: "WEBGL_CONTEXT_FAILED",
    test: (l) => l.includes("webgl") || l.includes("could not create a webgl context") || l.includes("gpu process"),
    explain: "Headless Chromium could not create a WebGL context, so Three.js cannot render.",
    hint:
      "Keep the SwiftShader flags in scripts/generate.js (--use-gl=angle, --use-angle=swiftshader, --enable-unsafe-swiftshader, --ignore-gpu-blocklist). Update your GPU/driver if the issue persists.",
  },
  {
    code: "TARGET_CLOSED",
    test: (l) => l.includes("target closed") || l.includes("session closed") || l.includes("page crashed"),
    explain: "The Chromium tab/renderer process crashed or was closed unexpectedly, usually from a GPU/OOM fault inside one specific 3D model.",
    hint:
      "The pipeline automatically relaunches the browser and retries the shot. If it repeats on the same model file, that file is likely corrupt or has degenerate geometry — remove/replace it in public/models.",
  },
  {
    code: "MANIFEST_MISSING",
    test: (l) => l.includes("manifest.json") && (l.includes("enoent") || l.includes("no such file")),
    explain: "public/config/manifest.json was not found. It lists every model file and background image.",
    hint: "Run `npm run discover` to generate it, then run `npm run generate` again.",
  },
  {
    code: "INVALID_JSON",
    test: (l) => l.includes("unexpected token") && l.includes("json"),
    explain: "A config file (generation.config.json, manifest.json or ground.json) has invalid JSON syntax.",
    hint: "Open the file in an editor and check for a missing/extra comma or brace, or validate it with an online JSON linter.",
  },
  {
    code: "NO_MODEL_IN_CLASS",
    test: (l) => l.includes("no model files found") || l.includes("empty model folder"),
    explain: "At least one folder inside public/models has no usable .fbx/.glb/.obj file.",
    hint: "Every class folder (e.g. public/models/Compressor) needs at least one .fbx, .glb or .obj file, or should be removed.",
  },
  {
    code: "NO_BACKGROUNDS",
    test: (l) => l.includes("no background images found"),
    explain: "public/backgrounds has no image files.",
    hint: "Add at least one .jpg/.png/.webp image to public/backgrounds.",
  },
  {
    code: "SHOT_TIMEOUT",
    test: (l) => l.includes("timeout") && l.includes("evaluate"),
    explain: "Generating a single shot (window.generateShot in the browser) took too long and timed out.",
    hint: "A model file is probably too heavy or fails to load silently. Check file sizes (keep each under ~50-80MB) and look at the headless browser console output above.",
  },
  {
    code: "MODEL_LOAD_ERROR",
    test: (l) => l.includes("failed_to_load_model"),
    explain: "A 3D model file (FBX/GLB/OBJ) failed to parse or load.",
    hint:
      "Possible reasons: corrupted export, missing/relative texture paths that don't resolve under public/, or an unsupported FBX feature. Re-export the model from Blender using the checklist in README.md.",
  },
  {
    code: "PLACEMENT_FAILED",
    test: (l) => l.includes("placement_failed") || l.includes("layout_fit_failed") || l.includes("could not fit object"),
    explain:
      "The placement system could not find a spot inside the defined ground zones where this object fits fully in frame without overlapping another object, after the maximum number of attempts.",
    hint:
      "Increase layout.maxPlacementAttempts / layout.minGapMeters tolerance, reduce shotComposition.maxModelsPerShot, make the ground zone polygons in ground.json larger, or reduce that model's targetHeightMeters/scale in generation.config.json.",
  },
  {
    code: "TOO_MANY_OBJECTS_FOR_ZONES",
    test: (l) => l.includes("too_many_objects_for_zones"),
    explain: "More objects were requested for this shot than the ground zones can reasonably fit without overlap.",
    hint: "Lower shotComposition.maxModelsPerShot or reduce layout.minGapMeters in generation.config.json.",
  },
  {
    code: "OCCLUDED_OBJECT_DROPPED",
    test: (l) => l.includes("occluded_object_dropped"),
    explain:
      "At least one object was actually rendered in the frame but was too overlapped by another object (or too far off-frame) to get a valid bounding box for it — that would have shipped an image with a visible, unlabeled object, which is bad for training.",
    hint:
      "The pipeline automatically discards this shot and tries a new random layout instead. If this happens very often, increase layout.minGapMeters in generation.config.json, or lower shotComposition.maxModelsPerShot for backgrounds with small ground zones.",
  },
  {
    code: "NO_GROUND_ZONES",
    test: (l) => l.includes("no_ground_zones"),
    explain: "No polygon regions were found in ground.json for the selected background image.",
    hint: "Add a 'ground' or 'zone' polygon region for that image filename in public/config/ground.json (e.g. using VGG Image Annotator).",
  },
];

/**
 * Turns a raw error (Node, Puppeteer, Vite, or in-browser) into a clear,
 * actionable English explanation.
 */
export function explainError(err) {
  const raw = err && err.message ? err.message : String(err);
  const lower = raw.toLowerCase();

  for (const rule of RULES) {
    if (rule.test(lower)) {
      const code = err && err.code ? err.code : rule.code;
      return `[${code}]\nCause: ${rule.explain}\nSuggested fix: ${rule.hint}\n\n(raw message: ${raw})`;
    }
  }

  if (err && err.name === "PipelineError") {
    return `[${err.code}]\nCause: ${err.message}\nSuggested fix: ${err.hint || "See raw message below."}\n\n(raw message: ${raw})`;
  }

  return `[UNKNOWN]\nAn unexpected error occurred. Raw message:\n${raw}\n\nIf this repeats, save this text and note which step triggered it.`;
}
