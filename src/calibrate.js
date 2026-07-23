import * as THREE from "three";
import { buildScene, setBackgroundTexture } from "./sceneBuilder.js";
import { preloadAllModels, instantiateModel, disposeInstance, getRawDimensions } from "./modelLoader.js";
import { getWorldBox3 } from "./bboxCalculator.js";
import { screenPointToGroundWorld } from "./mathUtils.js";
import { loadGroundZonesFile, getZonesForBackground } from "./groundZones.js";

// ---------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------
const el = {
  loadingOverlay: document.getElementById("loading-overlay"),
  loadingLabel: document.getElementById("loading-label"),
  loadingBar: document.getElementById("loading-bar"),
  activeTitle: document.getElementById("active-title"),
  statusLine: document.getElementById("status-line"),
  backgroundSelect: document.getElementById("background-select"),
  copyFromSelect: document.getElementById("copy-from-select"),
  copyBtn: document.getElementById("copy-btn"),
  applyAllBtn: document.getElementById("apply-all-btn"),
  heightSlider: document.getElementById("height-slider"),
  heightValue: document.getElementById("height-value"),
  prevBtn: document.getElementById("prev-btn"),
  nextBtn: document.getElementById("next-btn"),
  resetBtn: document.getElementById("reset-btn"),
  autoRotate: document.getElementById("auto-rotate"),
  rotateSlider: document.getElementById("rotate-slider"),
  saveBtn: document.getElementById("save-btn"),
  saveStatus: document.getElementById("save-status"),
  listWrap: document.getElementById("list-wrap"),
};

function setLoading(label, frac) {
  el.loadingLabel.textContent = label;
  if (frac != null) el.loadingBar.style.width = `${Math.round(frac * 100)}%`;
}
function setStatus(text) {
  el.statusLine.textContent = text;
}

// ---------------------------------------------------------------------
// Height <-> slider mapping (exponential, so small objects are easy to
// dial in precisely and large ones are still reachable)
// ---------------------------------------------------------------------
const MIN_H = 0.02;
const MAX_H = 12;
function sliderToHeight(t) {
  return MIN_H * Math.pow(MAX_H / MIN_H, t);
}
function heightToSlider(h) {
  const clamped = Math.min(MAX_H, Math.max(MIN_H, h));
  return Math.log(clamped / MIN_H) / Math.log(MAX_H / MIN_H);
}

async function fetchJSON(url, fallback = null) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (fallback !== null) return fallback;
    throw err;
  }
}

async function main() {
  setLoading("Loading config…", 0);
  const config = await fetchJSON("/config/generation.config.json");
  const manifest = await fetchJSON("/config/manifest.json");
  const classSizeProfiles = await fetchJSON("/config/classSizeProfiles.json", {});
  const zonesData = await fetchJSON("/config/ground.json", {});
  const diskOverrides = await fetchJSON("/api/scale-overrides", null) ?? await fetchJSON("/config/modelScaleOverrides.json", {});

  setLoading("Building scene…", 0.05);
  const { scene, camera, renderer, backgroundPlane } = buildScene(config);

  setLoading("Preloading all models — this can take a while…", 0.1);
  const { failed } = await preloadAllModels(manifest, (done, total, file) => {
    setLoading(`Preloading ${done}/${total}: ${file}`, 0.1 + 0.85 * (done / total));
  });
  if (failed.length > 0) {
    console.warn(`[calibrate] ${failed.length} model file(s) failed to preload and are excluded:`, failed);
  }

  // Flat, sorted list of every usable {className, file}
  const entries = [];
  for (const className of manifest.classes) {
    for (const file of manifest.models[className] || []) {
      if (failed.includes(file)) continue;
      entries.push({ className, file });
    }
  }
  entries.sort((a, b) => (a.className + a.file).localeCompare(b.className + b.file));

  // heights[background][file] = target real-world height in meters (in-memory working state)
  const heights = {};
  // calibrated[background] = Set(file) that have an explicit saved value for that background
  const calibrated = {};

  function defaultHeightFor(className) {
    const profile = classSizeProfiles && classSizeProfiles[className];
    if (profile && profile.realHeightMeters) return profile.realHeightMeters;
    return 1.0;
  }

  function ensureBackgroundState(bg) {
    if (heights[bg]) return;
    heights[bg] = {};
    calibrated[bg] = new Set();
    const savedForBg = diskOverrides[bg] || null;
    const savedDefault = diskOverrides._default || null;
    for (const { className, file } of entries) {
      const raw = getRawDimensions(file);
      const rawHeight = raw ? raw.height : 1;
      if (savedForBg && Number.isFinite(savedForBg[file])) {
        heights[bg][file] = savedForBg[file] * rawHeight;
        calibrated[bg].add(file);
      } else if (savedDefault && Number.isFinite(savedDefault[file])) {
        heights[bg][file] = savedDefault[file] * rawHeight;
      } else {
        heights[bg][file] = defaultHeightFor(className);
      }
    }
  }

  for (const bg of manifest.backgrounds) ensureBackgroundState(bg);

  // ---------------------------------------------------------------------
  // Background dropdowns
  // ---------------------------------------------------------------------
  for (const bg of manifest.backgrounds) {
    const opt1 = document.createElement("option");
    opt1.value = bg;
    opt1.textContent = bg;
    el.backgroundSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = bg;
    opt2.textContent = bg;
    el.copyFromSelect.appendChild(opt2);
  }

  let currentBackground = manifest.backgrounds[0];
  let groundSpot = null;
  let activeIndex = 0;
  let currentObject = null;

  async function computeGroundSpot(bg) {
    const bgSize = await setBackgroundTexture(backgroundPlane, bg);
    const zones = getZonesForBackground(zonesData, bg, bgSize.width, bgSize.height);
    if (!zones || zones.length === 0) {
      console.warn(`[calibrate] no ground zones defined for "${bg}" in ground.json; using screen center as fallback.`);
      return screenPointToGroundWorld(camera, 0.5, 0.6, config.layout?.groundY ?? 0);
    }
    // Largest zone by area, placed at its centroid.
    const biggest = zones.reduce((a, b) => (b.area > a.area ? b : a), zones[0]);
    const xs = biggest.points.map((p) => p.x);
    const ys = biggest.points.map((p) => p.y);
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    return screenPointToGroundWorld(camera, cx, cy, config.layout?.groundY ?? 0);
  }

  function teardownActive() {
    if (currentObject) {
      disposeInstance(currentObject);
      scene.remove(currentObject);
      currentObject = null;
    }
  }

  function placeActiveObject() {
    teardownActive();
    const { className, file } = entries[activeIndex];
    const heightM = heights[currentBackground][file];
    const raw = getRawDimensions(file);
    const rawHeight = raw ? raw.height : 1;
    const forcedScale = heightM / rawHeight;

    const classCfg = config.models[className] || {};
    const color = classCfg.colors ? classCfg.colors[0] : "#ffffff";

    const obj = instantiateModel({
      className,
      file,
      color,
      classCfg,
      forcedScale,
    });

    obj.position.set(0, 0, 0);
    obj.rotation.y = THREE.MathUtils.degToRad(Number(el.rotateSlider.value));
    scene.add(obj);

    // Sit the object on the ground plane at the calibration spot.
    obj.updateMatrixWorld(true);
    const box = getWorldBox3(obj);
    const bottomOffset = -box.min.y;
    if (groundSpot) {
      obj.position.set(groundSpot.x, groundSpot.y + bottomOffset, groundSpot.z);
    }

    currentObject = obj;

    el.activeTitle.textContent = `${className} — ${file.split("/").pop()}`;
    el.heightSlider.disabled = false;
    el.heightValue.disabled = false;
    el.heightSlider.value = heightToSlider(heightM);
    el.heightValue.value = heightM.toFixed(3);

    setStatus(`${activeIndex + 1}/${entries.length} · ${file} · target height ${heightM.toFixed(3)} m · background: ${currentBackground}`);
    highlightActiveListItem();
  }

  async function switchBackground(bg) {
    currentBackground = bg;
    el.backgroundSelect.value = bg;
    groundSpot = await computeGroundSpot(bg);
    renderModelList();
    placeActiveObject();
  }

  function setHeight(newHeight) {
    const { file } = entries[activeIndex];
    const clamped = Math.min(MAX_H, Math.max(MIN_H, newHeight));
    heights[currentBackground][file] = clamped;
    calibrated[currentBackground].add(file);
    el.heightSlider.value = heightToSlider(clamped);
    el.heightValue.value = clamped.toFixed(3);

    if (currentObject) {
      const raw = getRawDimensions(file);
      const rawHeight = raw ? raw.height : 1;
      currentObject.scale.setScalar(clamped / rawHeight);

      // Re-ground: figure out the new bottom offset at this scale, then
      // re-place at the calibration spot so the object still sits flush
      // on the floor instead of floating/sinking as it resizes.
      currentObject.position.y = 0;
      currentObject.updateMatrixWorld(true);
      const box = getWorldBox3(currentObject);
      const offset = -box.min.y;
      if (groundSpot) currentObject.position.set(groundSpot.x, groundSpot.y + offset, groundSpot.z);
    }
    updateListItemValue(file);
    setStatus(`${activeIndex + 1}/${entries.length} · ${file} · target height ${clamped.toFixed(3)} m · background: ${currentBackground}`);
  }

  // ---------------------------------------------------------------------
  // Sidebar model list (grouped by class)
  // ---------------------------------------------------------------------
  const listItemEls = new Map(); // file -> {row, miniHeight}

  function renderModelList() {
    el.listWrap.innerHTML = "";
    listItemEls.clear();
    let lastClass = null;

    entries.forEach((entry, idx) => {
      if (entry.className !== lastClass) {
        lastClass = entry.className;
        const title = document.createElement("div");
        title.className = "class-group-title";
        title.textContent = entry.className;
        el.listWrap.appendChild(title);
      }

      const row = document.createElement("div");
      row.className = "model-item";
      row.dataset.index = String(idx);

      const dot = document.createElement("div");
      dot.className = "status-dot";

      const name = document.createElement("div");
      name.className = "name";
      const fileName = entry.file.split("/").pop();
      name.innerHTML = `${fileName}<small>${entry.className}</small>`;

      const miniHeight = document.createElement("div");
      miniHeight.className = "mini-height";
      miniHeight.textContent = `${heights[currentBackground][entry.file].toFixed(2)} m`;

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(miniHeight);
      row.addEventListener("click", () => {
        activeIndex = idx;
        placeActiveObject();
      });

      el.listWrap.appendChild(row);
      listItemEls.set(entry.file, { row, miniHeight, dot });
      if (calibrated[currentBackground].has(entry.file)) row.classList.add("calibrated");
    });

    highlightActiveListItem();
  }

  function updateListItemValue(file) {
    const item = listItemEls.get(file);
    if (!item) return;
    item.miniHeight.textContent = `${heights[currentBackground][file].toFixed(2)} m`;
    item.row.classList.add("calibrated");
  }

  function highlightActiveListItem() {
    for (const { row } of listItemEls.values()) row.classList.remove("active");
    const active = entries[activeIndex];
    if (!active) return;
    const item = listItemEls.get(active.file);
    if (item) {
      item.row.classList.add("active");
      item.row.scrollIntoView({ block: "nearest" });
    }
  }

  // ---------------------------------------------------------------------
  // Controls wiring
  // ---------------------------------------------------------------------
  el.backgroundSelect.addEventListener("change", (e) => switchBackground(e.target.value));

  el.heightSlider.addEventListener("input", (e) => {
    setHeight(sliderToHeight(Number(e.target.value)));
  });
  el.heightValue.addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) setHeight(v);
  });

  el.prevBtn.addEventListener("click", () => {
    activeIndex = (activeIndex - 1 + entries.length) % entries.length;
    placeActiveObject();
  });
  el.nextBtn.addEventListener("click", () => {
    activeIndex = (activeIndex + 1) % entries.length;
    placeActiveObject();
  });
  el.resetBtn.addEventListener("click", () => {
    const { className } = entries[activeIndex];
    setHeight(defaultHeightFor(className));
  });

  el.rotateSlider.addEventListener("input", (e) => {
    if (currentObject) currentObject.rotation.y = THREE.MathUtils.degToRad(Number(e.target.value));
  });

  el.copyBtn.addEventListener("click", () => {
    const src = el.copyFromSelect.value;
    if (!src || src === currentBackground) return;
    ensureBackgroundState(src);
    for (const { file } of entries) {
      heights[currentBackground][file] = heights[src][file];
      calibrated[currentBackground].add(file);
    }
    renderModelList();
    placeActiveObject();
    el.saveStatus.textContent = `Copied heights from "${src}" — remember to click Save.`;
    el.saveStatus.style.color = "var(--text-dim)";
  });

  el.applyAllBtn.addEventListener("click", async () => {
    const source = { ...heights[currentBackground] };
    for (const bg of manifest.backgrounds) {
      ensureBackgroundState(bg);
      for (const { file } of entries) {
        heights[bg][file] = source[file];
        calibrated[bg].add(file);
      }
      await saveBackground(bg);
    }
    el.saveStatus.textContent = `Applied and saved current heights to all ${manifest.backgrounds.length} backgrounds.`;
    el.saveStatus.style.color = "var(--good)";
    renderModelList();
  });

  async function saveBackground(bg) {
    const overrides = {};
    for (const { file } of entries) {
      const raw = getRawDimensions(file);
      const rawHeight = raw ? raw.height : 1;
      overrides[file] = heights[bg][file] / rawHeight; // store as absolute Three.js scale
    }
    const res = await fetch("/api/scale-overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ background: bg, overrides }),
    });
    if (!res.ok) throw new Error(`Save failed: HTTP ${res.status}`);
    diskOverrides[bg] = overrides;
  }

  el.saveBtn.addEventListener("click", async () => {
    el.saveStatus.textContent = "Saving…";
    el.saveStatus.style.color = "var(--text-dim)";
    try {
      await saveBackground(currentBackground);
      for (const { file } of entries) calibrated[currentBackground].add(file);
      renderModelList();
      el.saveStatus.textContent = `Saved ${entries.length} model scale(s) for "${currentBackground}".`;
      el.saveStatus.style.color = "var(--good)";
    } catch (err) {
      el.saveStatus.textContent = `Save failed: ${err.message}. (Are you running "npm run dev" / "npm run calibrate"? The save API is dev-only.)`;
      el.saveStatus.style.color = "#e06060";
    }
  });

  // ---------------------------------------------------------------------
  // Render loop (with optional idle rotation)
  // ---------------------------------------------------------------------
  function tick() {
    if (currentObject && el.autoRotate.checked) {
      currentObject.rotation.y += 0.006;
      el.rotateSlider.value = String(Math.round(THREE.MathUtils.radToDeg(currentObject.rotation.y) % 360));
    }
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  await switchBackground(currentBackground);
  el.loadingOverlay.style.display = "none";
  tick();
}

main().catch((err) => {
  console.error(err);
  setLoading(`Error: ${err.message}`, null);
});
