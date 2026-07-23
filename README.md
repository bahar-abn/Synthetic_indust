# 🏭 Synthetic Industrial Dataset Generator

**Generate synthetic industrial object-detection datasets automatically — with YOLO annotations — by compositing 3D models onto real backgrounds.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.12.0-brightgreen.svg)
![Three.js](https://img.shields.io/badge/three.js-r185-black.svg)
![Puppeteer](https://img.shields.io/badge/puppeteer-headless-orange.svg)
![YOLO](https://img.shields.io/badge/annotations-YOLO%20format-red.svg)

---

## 🎯 What This Does

Ever tried to train an object detector for industrial equipment? Real images are expensive to collect and label. This pipeline solves that by rendering 3D models onto factory/studio backgrounds, automatically generating YOLO-format bounding boxes for every object in every image.

**In plain English:** You feed it 3D models (compressor, crane, fire truck, etc.) and background photos, it outputs a complete dataset with images + annotation files, ready to train YOLOv8/v9/v10.

**Example output:**
```
dataset/
├── train/
│   ├── images/000001.png
│   ├── labels/000001.txt      # YOLO: class cx cy w h
├── val/
├── test/
├── classes.txt
└── data.yaml                  # Ready for Ultralytics
```

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🏗️ **Multi-class support** | Compressor, Crane, FireTruck, ElectroMotor, FanSanati, PanelBargh, FireHydrant, more |
| 🎯 **Automatic YOLO labels** | `class x_center y_center width height` |
| 📦 **Multiple formats** | FBX, GLB, OBJ — drag and drop |
| 🧩 **Collision-free placement** | Objects don't overlap; configurable spacing |
| 🎚️ **Manual scale calibration** | Web-based tool to set per-model, per-background scales visually |
| ✂️ **Stratified split** | Train/val/test with balanced class distribution |
| 🛡️ **Fault-tolerant** | Skips bad shots, logs failures, resumes after crash |
| 🖥️ **Server-ready** | Headless — runs on cloud VMs with no display |

---

## 🚀 Quick Start

### 1. Install & Prepare

```bash
git clone <this-repo>
cd synthetic_indust
npm install

# Create your folder structure
mkdir -p public/models public/backgrounds
```

### 2. Add Your Assets

**Models** — each class gets its own folder:
```
public/models/
├── Compressor/
│   └── compressor_01.glb
├── Crane/
│   └── crane_05.glb
└── FireTruck/
    └── fire_truck.glb
```

**Backgrounds** — any JPG/PNG/WEBP:
```
public/backgrounds/
├── workshop_01.jpg
└── factory_floor_02.png
```

### 3. Run the Full Pipeline

```bash
npm run full-pipeline
```

This does everything: discover → build → generate → split.

### 4. Use Your Dataset

Point YOLO to `dataset/data.yaml`:

```bash
yolo train data=dataset/data.yaml model=yolov8n.pt epochs=100
```

---

## 📖 How It Works (Step by Step)

### Step 1: Discover Assets (`npm run discover`)

Scans `public/models/` and `public/backgrounds/`, builds `manifest.json`:

```json
{
  "classes": ["Compressor", "Crane", "FireTruck"],
  "models": {
    "Compressor": ["models/Compressor/compressor_01.glb"],
    "Crane": ["models/Crane/crane_05.glb"]
  },
  "backgrounds": ["backgrounds/workshop_01.jpg"]
}
```

### Step 2: Configure (`public/config/generation.config.json`)

This file controls *everything* — how many images, what classes appear, how big objects are, placement rules:

```json
{
  "totalImages": 100,
  "output": { "width": 1280, "height": 960 },
  
  "shotComposition": {
    "minModelsPerShot": 3,
    "maxModelsPerShot": 5,
    "classProbability": {
      "Compressor": 1,
      "Crane": 1,
      "FireTruck": 1
    }
  },
  
  "layout": {
    "minGapMeters": 0.5,
    "maxPlacementAttempts": 60,
    "frameMarginRatio": 0.12
  },
  
  "randomization": {
    "rotationYRangeDeg": [0, 360],
    "occlusionVisibilityThreshold": 0.4
  },
  
  "models": {
    "Compressor": {
      "scale": 1,
      "colors": ["#F2A900", "#1F3A5F"]
    }
  }
}
```

**Key settings explained:**

| Setting | What it does |
|---------|--------------|
| `totalImages` | Total images to generate |
| `minModelsPerShot` | Minimum objects per image |
| `classProbability` | Higher = more likely to appear |
| `minGapMeters` | Minimum empty space between objects |
| `frameMarginRatio` | How close objects can get to image edges |
| `colors` | Color palette for each class |
| `exclusiveClasses` | Only show these classes (good for single-class test) |
| `allowDuplicateClassInShot` | Can two of the same class appear together? |

### Step 3: Size Calibration (`npm run calibrate`)

3D models come in wildly different scales. This tool lets you set per-model, per-background sizes visually:

```bash
npm run dev      # Start the dev server
npm run calibrate # Open the calibration tool
```

In the tool:
- Browse all models
- Adjust height with slider
- Rotate to see from all angles
- Save scale for each model/background

The scales are stored in `public/config/modelScaleOverrides.json`:
```json
{
  "backgrounds/01.jpg": {
    "models/Compressor/compressor_01.glb": 0.58,
    "models/Crane/crane_05.glb": 0.45
  }
}
```

### Step 4: Generate (`npm run generate`)

This is where the magic happens:

1. **Plan a shot** — picks classes, models, colors, rotation (Node.js side)
2. **Build the scene** — loads models, applies scales, places them on the background
3. **Render** — takes a screenshot via headless Chromium
4. **Annotate** — projects 3D bounding boxes to 2D, writes YOLO labels
5. **Validate** — checks visibility, occlusion, and being in frame

**Output** goes to `dataset_staging/`:
```
dataset_staging/
├── images/000001.png
├── labels/000001.txt
└── meta.jsonl    # Track what was generated
```

**Why this is done in two steps?** Generate can take hours. If it crashes, you can just re-run it — it skips already-generated shots.

### Step 5: Split (`npm run split`)

Splits the dataset into train/val/test with **stratified** sampling — each split gets a representative mix of class combinations:

```
dataset/
├── train/      # 70%
├── val/        # 20%
├── test/       # 10%
├── classes.txt
└── data.yaml   # Ready for YOLO
```

---

## 📁 Folder Structure Explained

```
synthetic_indust/
├── public/                         # All static assets
│   ├── models/                     # 3D models by class
│   │   ├── Compressor/
│   │   │   └── compressor_01.glb
│   │   └── Crane/
│   │       └── crane_05.glb
│   ├── backgrounds/                # Background images
│   │   └── workshop_01.jpg
│   └── config/                     # Configuration files
│       ├── generation.config.json  # Main settings (edit this)
│       ├── manifest.json           # Auto-generated asset list
│       ├── classSizeProfiles.json  # Real-world object sizes
│       ├── ground.json             # Placement zones per background
│       └── modelScaleOverrides.json # Per-model scales (auto-saved)
│
├── src/                            # Three.js scene code
│   ├── main.js                     # Entry point
│   ├── modelLoader.js              # Loads FBX/GLB/OBJ
│   ├── layoutManager.js            # Collision-free placement
│   ├── bboxCalculator.js           # 3D → 2D bounding boxes
│   ├── groundZones.js              # Reads placement polygons
│   └── calibrate.js                # Scale calibration tool
│
├── scripts/                        # Node.js pipeline scripts
│   ├── discoverAssets.js           # Builds manifest.json
│   ├── generate.js                 # Main generation (Puppeteer)
│   ├── shotPlanner.js              # Plans each shot's content
│   ├── splitDataset.js             # Train/val/test split
│   └── errors.js                   # Structured error handling
│
├── dataset_staging/                # Raw output (before split)
│   └── images/, labels/, meta.jsonl
│
├── dataset/                        # Final dataset
│   ├── train/, val/, test/
│   ├── classes.txt
│   └── data.yaml
│
├── calibrate.html                  # Calibration tool UI
├── index.html                      # Main scene entry
├── package.json
└── vite.config.js
```

---

## 🎨 What You Put In vs What You Get Out

### Input: Your Assets

**3D Models**
```
public/models/Compressor/compressor_01.glb
public/models/Crane/crane_05.glb
public/models/FireTruck/fire_truck.glb
```

**Backgrounds**
```
public/backgrounds/workshop_01.jpg
public/backgrounds/factory_02.png
```

**Configuration**
```
public/config/generation.config.json
```

### Output: Your Dataset

**Image** (`dataset/train/images/000001.png`)
- Rendered scene with 3-5 objects on a background

**Label** (`dataset/train/labels/000001.txt`)
```
0 0.234 0.456 0.123 0.234    # Compressor
1 0.567 0.345 0.089 0.156    # Crane
2 0.789 0.678 0.067 0.123    # FireTruck
```

**Classes** (`dataset/classes.txt`)
```
Compressor
Crane
FireTruck
```

**Data YAML** (`dataset/data.yaml`)
```yaml
path: /path/to/dataset
train: train/images
val: val/images
test: test/images
nc: 3
names: [Compressor, Crane, FireTruck]
```

---

## 🔧 Configuration Deep Dive

### Class Size Profiles (`classSizeProfiles.json`)

```json
{
  "Crane": {
    "realHeightMeters": 2.5,
    "occupancyRatio": 0.35,
    "sizeVariance": 0.15
  }
}
```

| Field | What it does |
|-------|--------------|
| `realHeightMeters` | Target height in the scene (in meters) |
| `occupancyRatio` | How much space this class takes relative to others |
| `sizeVariance` | Random variation in size per shot (±15% for Crane) |

### Material Overrides

You can force a model to use procedural colors instead of its original textures:

```json
"materialOverridesByFile": {
  "models/Crane/Crane_04/source/Rough-Terrain Crane.glb": {
    "mode": "original",
    "colors": ["#f5c542", "#ff8c00"]
  }
}
```

| Mode | Effect |
|------|--------|
| `"original"` | Uses the model's existing materials/textures |
| `"procedural"` | Applies solid colors (randomly selected from the palette) |

### Ground Zones (`ground.json`)

This defines *where* objects can be placed in the scene. You create these polygons using [VGG Image Annotator (VIA)](http://www.robots.ox.ac.uk/~vgg/software/via/):

```json
{
  "01.jpg": {
    "regions": {
      "0": {
        "shape_attributes": {
          "name": "polygon",
          "all_points_x": [1537, 97, 97, 5095, 5076, 3591],
          "all_points_y": [2265, 2912, 3360, 3276, 2732, 2246]
        },
        "region_attributes": { "label": "ground" }
      }
    }
  }
}
```

**Why?** The background is a flat image, but objects need to sit on a "floor." Zones tell the pipeline where the floor is.

---

## 🛠️ Commands Reference

| Command | What it does |
|---------|--------------|
| `npm run discover` | Scan models/backgrounds → build manifest.json |
| `npm run build` | Build the Three.js app (static files) |
| `npm run generate` | Generate the dataset (Puppeteer + headless Chrome) |
| `npm run split` | Split into train/val/test |
| `npm run full-pipeline` | discover → build → generate → split |
| `npm run calibrate` | Open the scale calibration tool |
| `npm run dev` | Start the dev server (for debugging) |
| `npm run preview` | Preview the built app |

---

## 🐛 Error Handling & Recovery

Instead of raw stack traces, you get actionable messages:

```
❌ [PLACEMENT_FAILED]
Cause: Could not find a non-overlapping, in-frame ground spot for className=Crane after 60 attempts.
Suggested fix: Increase layout.maxPlacementAttempts, reduce layout.minGapMeters, or lower maxModelsPerShot.
```

**Common errors and fixes:**

| Error Code | What happened | Fix |
|------------|---------------|-----|
| `MANIFEST_MISSING` | No manifest.json | Run `npm run discover` |
| `NO_MODEL_IN_CLASS` | Empty class folder | Add a model file |
| `SERVER_NOT_UP` | Vite preview not running | Run `npm run build` first |
| `WEBGL_CONTEXT_FAILED` | GPU/WebGL issue | Update drivers; the pipeline uses SwiftShader fallback |
| `OCCLUDED_OBJECT_DROPPED` | Object visible but unlabeled | The shot is skipped and retried automatically |

### Resuming After Crash

Generation is **resumable**:
1. Kill the process with `Ctrl+C`
2. Run `npm run generate` again
3. It skips already-generated shots automatically

---

## 🖼️ For Each Image — What Goes Into It

Every image is built from these pieces:

### 1. Background
- Randomly selected from `public/backgrounds/`
- Loaded as a full-screen plane behind everything

### 2. Objects (3-5 per image)
- **Classes** chosen via `classProbability` weights
- **Models** randomly picked from available files
- **Colors** randomly chosen from the class palette
- **Rotation** random (0-360° on Y axis)
- **Scales** from `modelScaleOverrides.json` or class defaults

### 3. Placement
- Objects are placed within the `ground` zones
- Collision detection prevents overlap
- Each object must be fully in frame (with margin)
- Objects too occluded by others are rejected

### 4. Rendering
- Studio lighting (3-point setup)
- Soft environment reflections
- No shadows (cleaner labels, faster rendering)

### 5. Labels
- Tight bounding boxes from 3D vertex projection
- YOLO format: `class cx cy w h`
- Only objects with >40% visibility get labeled

---

## 💡 Pro Tips

### For Better Data Quality
1. **Calibrate scales carefully** — wrong sizes = wrong bounding boxes
2. **Add more backgrounds** — variety prevents overfitting
3. **Use diverse models** — multiple variants per class
4. **Balance class probabilities** — avoid rare classes getting 2 examples
5. **Check the shot log** (`dataset_staging/shot_log.json`) to see which models are used

### For Faster Generation
1. **Reduce model complexity** — simplify geometry in Blender
2. **Lower image resolution** — 1280×960 is a good balance
3. **Use SSD** — IO speed matters for many images
4. **Increase `maxPlanRetries`** — fewer failed shots = faster

### For Debugging
1. **Preview a single shot** — generate 1 image first
2. **Check the browser console** — run `npm run dev` and open DevTools
3. **Inspect `shot_log.json`** — see exactly what was attempted
4. **Review `failed_shots.log`** — all errors with explanations

---

## 🔬 Technical Overview

### Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Node.js   │────▶│   Vite      │────▶│  Three.js   │
│  (generate) │     │  (preview)  │     │  (scene)    │
└─────────────┘     └─────────────┘     └─────────────┘
       │                    │                    │
       ▼                    ▼                    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Puppeteer  │────▶│  Chromium   │────▶│  Screenshot │
│  (control)  │     │ (headless)  │     │   + Labels  │
└─────────────┘     └─────────────┘     └─────────────┘
```

### Key Technical Choices

**Why Three.js?**
- WebGL runs in the browser (Puppeteer)
- Supports FBX/GLB/OBJ natively
- Easy to manipulate and calculate bounding boxes

**Why Puppeteer?**
- Headless Chrome automation
- Screenshots match exactly what the browser renders
- Works on servers with no display

**Why Vite?**
- Fast build times
- Simple dev server
- Good for serving static assets

### How Bounding Boxes Are Calculated

1. Every mesh vertex is projected from 3D world space to 2D screen space
2. Min/max values give the tight bounding box
3. This handles rotation correctly (unlike projecting 8 corners)
4. Visibility is checked by sampling points and raycasting

---

## 📝 Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | ^20.19.0 or >=22.12.0 |
| Chrome/Chromium | Latest (Puppeteer manages this) |
| Disk space | ~2GB per 1000 images |
| RAM | ~4GB (more for complex models) |
| GPU | Not required (software rendering) |

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Test with `npm run full-pipeline`
5. Submit a PR

**Areas where help is welcome:**
- More model formats (DAE, STL, PLY)
- Instance segmentation (masks)
- Domain randomization
- Blender backend (higher quality)

---

## 📄 License

MIT — use it for anything, commercial or academic.

---

## 🙏 Acknowledgments

- [Three.js](https://threejs.org/) — 3D engine
- [Puppeteer](https://pptr.dev/) — Headless Chrome
- [Vite](https://vitejs.dev/) — Build tool
- All the 3D model creators who shared their work

---

## 📞 Questions?

**File an issue** on GitHub with:
- Error message (copy the full output)
- Your `generation.config.json`
- The last few lines of `failed_shots.log`

---

**Happy generating! 🚀**
