import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { PipelineError } from "../scripts/errors.js";

const fbxLoader = new FBXLoader();
const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();
const mtlLoader = new MTLLoader();

const rawCache = new Map();
const failedFiles = new Set();
let classSizeProfiles = null;

let nextOwnerId = 1;

export function setClassSizeProfiles(profiles) {
  classSizeProfiles = profiles;
}

export function getClassSizeProfiles() {
  return classSizeProfiles;
}

function findTextureDirectory(modelPath) {
  const parts = modelPath.split("/");
  const fileName = parts.pop();
  const sourceDir = parts.join("/");
  const parentDir = parts.slice(0, -1).join("/");
  
  const possibleTextureDirs = [
    `${parentDir}/textures`,
    `${sourceDir}/textures`,
    `${parentDir}/Textures`,
    `${sourceDir}/Textures`,
    `${parentDir}/tex`,
    `${sourceDir}/tex`,
    `${parentDir}/assets`,
    `${sourceDir}/assets`,
    `${parentDir}/texture`,
    `${sourceDir}/texture`,
    `${parentDir}/Texture`,
    `${sourceDir}/Texture`,
    `${parentDir}/images`,
    `${sourceDir}/images`,
  ];
  
  // Check if directory exists by trying to fetch a file from it
  for (const dir of possibleTextureDirs) {
    const testPath = `/${dir}/.gitkeep`;
    try {
      // We'll just try to see if the directory exists by checking a known file
      // This is a workaround for browser environment
      const response = fetch(`/${dir}`, { method: 'HEAD' });
      if (response.ok) {
        return dir;
      }
    } catch (e) {
      // Continue checking
    }
  }
  
  // If no texture directory found, try to find textures in the same directory
  // by looking for common texture file patterns
  const sourcePath = `/${sourceDir}`;
  const commonTextureFiles = [
    'basecolor.png', 'diffuse.png', 'albedo.png', 'color.png',
    'normal.png', 'roughness.png', 'metallic.png', 'ao.png',
    'BaseColor.png', 'Diffuse.png', 'Albedo.png', 'Color.png',
    'Normal.png', 'Roughness.png', 'Metallic.png', 'AO.png',
    'basecolor.jpg', 'diffuse.jpg', 'albedo.jpg', 'color.jpg',
    'normal.jpg', 'roughness.jpg', 'metallic.jpg', 'ao.jpg'
  ];
  
  for (const texFile of commonTextureFiles) {
    const fullPath = `${sourcePath}/${texFile}`;
    try {
      const response = fetch(fullPath, { method: 'HEAD' });
      if (response.ok) {
        console.log(`[TEXTURE] Found textures in source directory: ${sourceDir}`);
        return sourceDir;
      }
    } catch (e) {
      // Continue
    }
  }
  
  return null;
}

function getBaseName(filename) {
  return filename.replace(/\.[^/.]+$/, "").toLowerCase();
}

function matchTextureToMaterial(textureFiles, materialName, textureType) {
  const baseName = getBaseName(materialName || "default");
  
  const typeKeywords = {
    map: ['basecolor', 'base_color', 'diffuse', 'albedo', 'color', 'col', '_col', '_c', 'base', 'albedo', 'diff', 'texture', 'tex'],
    normalMap: ['normal', 'norm', 'nrm', '_n', '_nrm', 'normalmap', 'normal_map'],
    roughnessMap: ['roughness', 'rough', 'rgh', '_r', '_rough', 'roughmap', 'roughness_map'],
    metalnessMap: ['metallic', 'metal', 'met', '_m', '_metal', 'metallicmap', 'metalness_map'],
    aoMap: ['ao', 'ambient', 'occlusion', '_ao', 'ambientocclusion', 'ao_map'],
    emissiveMap: ['emissive', 'emit', 'emission', '_e', '_emissive', 'emissive_map'],
    displacementMap: ['displacement', 'disp', 'height', '_h', '_disp', 'displacement_map'],
    specularMap: ['specular', 'spec', '_s', '_spec', 'specular_map']
  };
  
  const keywords = typeKeywords[textureType] || [];
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const file of textureFiles) {
    const fileBase = getBaseName(file);
    const fileLower = fileBase.toLowerCase();
    
    let score = 0;
    
    if (materialName && fileLower.includes(baseName)) {
      score += 10;
    }
    
    for (const keyword of keywords) {
      if (fileLower.includes(keyword)) {
        score += 5;
        break;
      }
    }
    
    if (fileLower.includes('_d') || fileLower.includes('-d')) {
      if (textureType === 'map') score += 3;
    }
    if (fileLower.includes('_n') || fileLower.includes('-n')) {
      if (textureType === 'normalMap') score += 3;
    }
    if (fileLower.includes('_r') || fileLower.includes('-r')) {
      if (textureType === 'roughnessMap') score += 3;
    }
    if (fileLower.includes('_m') || fileLower.includes('-m')) {
      if (textureType === 'metalnessMap') score += 3;
    }
    if (fileLower.includes('_ao') || fileLower.includes('-ao')) {
      if (textureType === 'aoMap') score += 3;
    }
    
    for (const [otherType, otherKeywords] of Object.entries(typeKeywords)) {
      if (otherType === textureType) continue;
      for (const keyword of otherKeywords) {
        if (fileLower.includes(keyword)) {
          score -= 2;
          break;
        }
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = file;
    }
  }
  
  return bestMatch;
}

function getTexturePath(textureDir, textureFile) {
  return `${textureDir}/${textureFile}`;
}

function applyExternalTextures(object, modelPath) {
  const textureDir = findTextureDirectory(modelPath);
  if (!textureDir) {
    console.log(`[TEXTURE] ⚠️ No texture directory found for ${modelPath}`);
    return { 
      texturesFound: 0, 
      texturesApplied: 0, 
      missingTextures: ['texture_directory_not_found'],
      appliedTextures: {},
      textureDir: null
    };
  }
  
  console.log(`[TEXTURE] Found texture directory: ${textureDir}`);
  
  const textureLoader = new THREE.TextureLoader();
  
  // Collect all mesh and material names
  const meshNames = [];
  const materialNames = [];
  
  object.traverse((child) => {
    if (child.isMesh) {
      if (child.name) meshNames.push(child.name);
      if (child.material) {
        if (Array.isArray(child.material)) {
          for (const mat of child.material) {
            if (mat.name) materialNames.push(mat.name);
          }
        } else {
          if (child.material.name) materialNames.push(child.material.name);
        }
      }
    }
  });
  
  const uniqueMeshNames = [...new Set(meshNames)];
  const uniqueMaterialNames = [...new Set(materialNames)];
  
  // Generate possible texture file names to try
  const possibleTextureNames = [];
  
  for (const name of [...uniqueMeshNames, ...uniqueMaterialNames, 'default', 'material', 'mesh']) {
    const base = getBaseName(name);
    const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.tga', '.bmp', '.tif', '.tiff', '.dds'];
    for (const ext of extensions) {
      possibleTextureNames.push(`${base}${ext}`);
      possibleTextureNames.push(`${base}_BaseColor${ext}`);
      possibleTextureNames.push(`${base}_Diffuse${ext}`);
      possibleTextureNames.push(`${base}_Albedo${ext}`);
      possibleTextureNames.push(`${base}_Color${ext}`);
      possibleTextureNames.push(`${base}_Normal${ext}`);
      possibleTextureNames.push(`${base}_Roughness${ext}`);
      possibleTextureNames.push(`${base}_Metallic${ext}`);
      possibleTextureNames.push(`${base}_AO${ext}`);
      possibleTextureNames.push(`${base}__BaseColor${ext}`);
      possibleTextureNames.push(`${base}__Normal${ext}`);
      possibleTextureNames.push(`${base}__Roughness${ext}`);
      possibleTextureNames.push(`${base}__Metallic${ext}`);
      possibleTextureNames.push(`${base}__AO${ext}`);
    }
  }
  
  // Add common texture names
  const commonNames = ['basecolor', 'diffuse', 'albedo', 'color', 'normal', 'roughness', 'metallic', 'ao', 'texture'];
  const extensions = ['.png', '.jpg', '.jpeg', '.webp'];
  for (const name of commonNames) {
    for (const ext of extensions) {
      possibleTextureNames.push(`${name}${ext}`);
      possibleTextureNames.push(`${name}_map${ext}`);
      possibleTextureNames.push(`${name}-map${ext}`);
      possibleTextureNames.push(`_${name}${ext}`);
      possibleTextureNames.push(`_${name}_map${ext}`);
    }
  }
  
  // Try to find textures by checking if they exist
  const foundTextures = [];
  for (const texName of possibleTextureNames) {
    const texPath = `/${textureDir}/${texName}`;
    try {
      const response = fetch(texPath, { method: 'HEAD' });
      if (response.ok) {
        foundTextures.push(texName);
      }
    } catch (e) {
      // Texture doesn't exist
    }
  }
  
  // Remove duplicates
  const uniqueFoundTextures = [...new Set(foundTextures)];
  console.log(`[TEXTURE] Found ${uniqueFoundTextures.length} texture files in ${textureDir}:`, uniqueFoundTextures.slice(0, 10));
  
  // Apply textures to materials
  let texturesApplied = 0;
  const appliedTextures = {};
  const missingTextures = [];
  
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.material) return;
    
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const meshName = child.name || 'default';
    
    for (const material of materials) {
      const matName = material.name || meshName || 'default';
      const baseName = getBaseName(matName);
      
      // Try to find and load textures for this material
      const textureTypes = {
        map: ['basecolor', 'diffuse', 'albedo', 'color', 'texture', 'col', 'base'],
        normalMap: ['normal', 'norm', 'nrm'],
        roughnessMap: ['roughness', 'rough', 'rgh'],
        metalnessMap: ['metallic', 'metal', 'met'],
        aoMap: ['ao', 'ambient', 'occlusion']
      };
      
      for (const [type, keywords] of Object.entries(textureTypes)) {
        if (material[type]) continue;
        
        let loaded = false;
        
        // Try to find a matching texture
        for (const keyword of keywords) {
          const possibleNames = [
            `${baseName}_${keyword}`,
            `${baseName}__${keyword}`,
            `${keyword}`,
            `${baseName}_${keyword}_map`,
            `${baseName}__${keyword}__map`,
            `${baseName}_${keyword}_texture`,
            `_${keyword}`,
            `${keyword}_${baseName}`,
          ];
          
          const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.tga', '.bmp'];
          
          for (const nameBase of possibleNames) {
            for (const ext of extensions) {
              const texFile = `${nameBase}${ext}`;
              if (uniqueFoundTextures.includes(texFile)) {
                try {
                  const texPath = `/${textureDir}/${texFile}`;
                  const tex = textureLoader.load(texPath);
                  material[type] = tex;
                  material.needsUpdate = true;
                  texturesApplied++;
                  appliedTextures[`${matName}_${type}`] = texFile;
                  loaded = true;
                  console.log(`[TEXTURE] ✅ Applied ${type} to ${matName}: ${texFile}`);
                  break;
                } catch (e) {
                  // Failed to load texture
                }
              }
            }
            if (loaded) break;
          }
          if (loaded) break;
        }
        
        if (!loaded && !material[type]) {
          missingTextures.push(`${matName}_${type}`);
        }
      }
    }
  });
  
  // Second pass: try more aggressive matching for materials without textures
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.material) return;
    
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const meshName = child.name || 'default';
    
    for (const material of materials) {
      const matName = material.name || meshName || 'default';
      
      if (!material.map) {
        // Try to find any texture
        const baseName = getBaseName(matName);
        const possibleNames = [
          `${baseName}`,
          `${baseName}_BaseColor`,
          `${baseName}_Diffuse`,
          `${baseName}_Albedo`,
          `${baseName}_Color`,
          `${baseName}__BaseColor`,
          `${baseName}__Diffuse`,
          `${baseName}__Albedo`,
          `${baseName}__Color`,
          `${baseName}_texture`,
          `${baseName}__texture`,
          `texture`,
          `_texture`,
        ];
        
        const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.tga', '.bmp'];
        
        for (const nameBase of possibleNames) {
          for (const ext of extensions) {
            const texFile = `${nameBase}${ext}`;
            if (uniqueFoundTextures.includes(texFile)) {
              try {
                const texPath = `/${textureDir}/${texFile}`;
                const tex = textureLoader.load(texPath);
                material.map = tex;
                material.needsUpdate = true;
                texturesApplied++;
                appliedTextures[`${matName}_map`] = texFile;
                console.log(`[TEXTURE] ✅ Applied map to ${matName}: ${texFile}`);
                break;
              } catch (e) {
                // Failed to load texture
              }
            }
          }
          if (material.map) break;
        }
      }
    }
  });
  
  // Check for transparent/glass materials
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!child.material) return;
    
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    
    for (const material of materials) {
      // Check if material should be transparent (glass-like)
      if (material.opacity < 1 || material.transparent) {
        console.log(`[TEXTURE] 🔍 Found transparent material: ${material.name || 'unnamed'}`);
      }
    }
  });
  
  return {
    texturesFound: uniqueFoundTextures.length,
    texturesApplied,
    missingTextures,
    appliedTextures,
    textureDir,
    allTextureFiles: uniqueFoundTextures
  };
}

async function loadRawModel(relPath) {
  const ext = relPath.slice(relPath.lastIndexOf(".")).toLowerCase();
  const url = "/" + relPath;
  
  let root = null;
  let textureReport = null;
  
  console.log(`\n[MODEL_LOAD] Loading: ${relPath}`);
  
  try {
    if (ext === ".fbx") {
      root = await fbxLoader.loadAsync(url);
      textureReport = applyExternalTextures(root, relPath);
      
    } else if (ext === ".glb" || ext === ".gltf") {
      const gltf = await gltfLoader.loadAsync(url);
      root = gltf.scene;
      
      let hasEmbeddedTextures = false;
      let hasExternalTextures = false;
      
      root.traverse((child) => {
        if (child.isMesh && child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of materials) {
            if (mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap) {
              hasEmbeddedTextures = true;
            }
            // Check if material is transparent (glass)
            if (mat.opacity < 1 || mat.transparent) {
              console.log(`[TEXTURE] 🔍 GLB has transparent material: ${mat.name || 'unnamed'}`);
            }
          }
        }
      });
      
      if (!hasEmbeddedTextures) {
        textureReport = applyExternalTextures(root, relPath);
        hasExternalTextures = textureReport.texturesApplied > 0;
      } else {
        textureReport = {
          texturesFound: 0,
          texturesApplied: 0,
          missingTextures: [],
          appliedTextures: {},
          textureDir: null,
          embeddedTextures: true
        };
        console.log(`[TEXTURE] ✅ ${relPath} uses embedded textures`);
      }
      
    } else if (ext === ".obj") {
      const mtlPath = relPath.replace(/\.[^/.]+$/, ".mtl");
      const mtlUrl = "/" + mtlPath;
      
      let mtlLoaded = false;
      try {
        const materials = await mtlLoader.loadAsync(mtlUrl);
        materials.preload();
        objLoader.setMaterials(materials);
        root = await objLoader.loadAsync(url);
        mtlLoaded = true;
        console.log(`[TEXTURE] ✅ Loaded MTL for ${relPath}`);
        
        // Check if MTL has textures
        let hasTextures = false;
        root.traverse((child) => {
          if (child.isMesh && child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of materials) {
              if (mat.map) hasTextures = true;
            }
          }
        });
        
        if (!hasTextures) {
          textureReport = applyExternalTextures(root, relPath);
        } else {
          textureReport = {
            texturesFound: 0,
            texturesApplied: 0,
            missingTextures: [],
            appliedTextures: {},
            textureDir: null,
            mtlLoaded: true
          };
        }
        
      } catch (mtlErr) {
        console.log(`[TEXTURE] ⚠️ No MTL file for ${relPath}, trying external textures`);
        root = await objLoader.loadAsync(url);
        textureReport = applyExternalTextures(root, relPath);
      }
      
    } else {
      throw new PipelineError(`Unsupported model extension: ${relPath}`, {
        code: "UNSUPPORTED_MODEL_EXTENSION",
        hint: "Only .fbx, .glb, .gltf and .obj are supported.",
      });
    }
    
    // Log texture report
    if (textureReport) {
      const meshCount = countMeshes(root);
      const materialCount = countMaterials(root);
      
      console.log(`\n📊 [MODEL_TEXTURE_REPORT] ${relPath}`);
      console.log(`  meshes: ${meshCount}`);
      console.log(`  materials: ${materialCount}`);
      console.log(`  texturesFound: ${textureReport.texturesFound}`);
      console.log(`  texturesApplied: ${textureReport.texturesApplied}`);
      
      if (textureReport.textureDir) {
        console.log(`  textureDir: ${textureReport.textureDir}`);
      }
      if (textureReport.embeddedTextures) {
        console.log(`  ✅ embeddedTextures: true`);
      }
      if (textureReport.mtlLoaded) {
        console.log(`  ✅ mtlLoaded: true`);
      }
      
      if (textureReport.allTextureFiles && textureReport.allTextureFiles.length > 0) {
        console.log(`  allTextures: ${textureReport.allTextureFiles.slice(0, 10).join(", ")}${textureReport.allTextureFiles.length > 10 ? `... (${textureReport.allTextureFiles.length} total)` : ""}`);
      }
      
      if (textureReport.missingTextures && textureReport.missingTextures.length > 0) {
        console.log(`  ❌ missingTextures: ${textureReport.missingTextures.slice(0, 10).join(", ")}${textureReport.missingTextures.length > 10 ? `... (${textureReport.missingTextures.length} total)` : ""}`);
      }
      
      if (textureReport.appliedTextures && Object.keys(textureReport.appliedTextures).length > 0) {
        console.log(`  ✅ appliedTextures:`);
        for (const [key, value] of Object.entries(textureReport.appliedTextures).slice(0, 5)) {
          console.log(`    ${key}: ${value}`);
        }
        if (Object.keys(textureReport.appliedTextures).length > 5) {
          console.log(`    ... and ${Object.keys(textureReport.appliedTextures).length - 5} more`);
        }
      }
      
      if (textureReport.texturesApplied === 0 && !textureReport.embeddedTextures && !textureReport.mtlLoaded) {
        console.log(`  ⚠️ WARNING: No textures applied! This model may appear white.`);
      }
      
      console.log("");
    }
    
    root.updateMatrixWorld(true);
    const rawDimensions = computeRawDimensions(root);
    
    return { root, rawDimensions, textureReport };
    
  } catch (err) {
    console.error(`[LOAD_ERROR] ${relPath}:`, err.message);
    throw err;
  }
}

function countMeshes(object) {
  let count = 0;
  object.traverse((child) => {
    if (child.isMesh) count++;
  });
  return count;
}

function countMaterials(object) {
  const materials = new Set();
  object.traverse((child) => {
    if (child.isMesh && child.material) {
      if (Array.isArray(child.material)) {
        for (const mat of child.material) {
          if (mat.uuid) materials.add(mat.uuid);
        }
      } else {
        if (child.material.uuid) materials.add(child.material.uuid);
      }
    }
  });
  return materials.size;
}

function computeRawDimensions(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    return { width: 1, height: 1, depth: 1 };
  }
  const size = new THREE.Vector3();
  box.getSize(size);
  return {
    width: Math.max(size.x, 0.001),
    height: Math.max(size.y, 0.001),
    depth: Math.max(size.z, 0.001)
  };
}

export async function preloadAllModels(manifest, onProgress) {
  const allFiles = [];
  for (const className of manifest.classes) {
    for (const relPath of manifest.models[className]) {
      allFiles.push({ relPath, className });
    }
  }

  let done = 0;
  const dimensionLogs = [];
  const textureIssues = [];
  
  for (const { relPath, className } of allFiles) {
    try {
      const { root, rawDimensions, textureReport } = await loadRawModel(relPath);
      rawCache.set(relPath, { root, rawDimensions, textureReport });
      
      dimensionLogs.push({
        file: relPath,
        className,
        rawWidth: rawDimensions.width,
        rawHeight: rawDimensions.height,
        rawDepth: rawDimensions.depth,
        textureReport
      });
      
      // Track models without textures
      if (textureReport && textureReport.texturesApplied === 0 && !textureReport.embeddedTextures && !textureReport.mtlLoaded) {
        textureIssues.push({
          className,
          file: relPath,
          textureDir: textureReport.textureDir,
          missingTextures: textureReport.missingTextures || []
        });
      }
      
      console.log(`[MODEL_DIMENSIONS] ${className}: ${relPath} -> ${rawDimensions.height.toFixed(3)}h x ${rawDimensions.width.toFixed(3)}w x ${rawDimensions.depth.toFixed(3)}d`);
    } catch (err) {
      failedFiles.add(relPath);
      console.error(
        `[MODEL_LOAD_ERROR] ${relPath} -> ${err && err.message ? err.message : err}. This file will be skipped for the rest of the run.`
      );
    }
    done++;
    if (onProgress) onProgress(done, allFiles.length, relPath);
  }

  // Log texture issues summary
  if (textureIssues.length > 0) {
    console.log(`\n⚠️ ⚠️ ⚠️ TEXTURE ISSUES SUMMARY ⚠️ ⚠️ ⚠️`);
    console.log(`Found ${textureIssues.length} model(s) with missing textures:`);
    for (const issue of textureIssues) {
      console.log(`  ❌ ${issue.className}: ${issue.file}`);
      if (issue.textureDir) {
        console.log(`     textureDir: ${issue.textureDir}`);
      }
      if (issue.missingTextures && issue.missingTextures.length > 0) {
        console.log(`     missing: ${issue.missingTextures.slice(0, 5).join(", ")}${issue.missingTextures.length > 5 ? `... (${issue.missingTextures.length} total)` : ""}`);
      }
    }
    console.log(`\nTo fix: Check that texture files exist in the correct directory.`);
  }

  const classStats = {};
  for (const log of dimensionLogs) {
    if (!classStats[log.className]) {
      classStats[log.className] = { heights: [], widths: [], depths: [], textures: [] };
    }
    classStats[log.className].heights.push(log.rawHeight);
    classStats[log.className].widths.push(log.rawWidth);
    classStats[log.className].depths.push(log.rawDepth);
    if (log.textureReport) {
      classStats[log.className].textures.push({
        texturesApplied: log.textureReport.texturesApplied,
        texturesFound: log.textureReport.texturesFound,
        missingTextures: log.textureReport.missingTextures?.length || 0,
        embeddedTextures: log.textureReport.embeddedTextures || false,
        mtlLoaded: log.textureReport.mtlLoaded || false
      });
    }
  }
  
  console.log(`\n📊 CLASS STATISTICS:`);
  for (const [className, stats] of Object.entries(classStats)) {
    const avgH = stats.heights.reduce((a,b) => a+b, 0) / stats.heights.length;
    const avgW = stats.widths.reduce((a,b) => a+b, 0) / stats.widths.length;
    const avgD = stats.depths.reduce((a,b) => a+b, 0) / stats.depths.length;
    console.log(`  ${className}: avg ${avgH.toFixed(3)}h x ${avgW.toFixed(3)}w x ${avgD.toFixed(3)}d (${stats.heights.length} files)`);
    
    if (stats.textures.length > 0) {
      const avgApplied = stats.textures.reduce((a,b) => a + b.texturesApplied, 0) / stats.textures.length;
      const avgFound = stats.textures.reduce((a,b) => a + b.texturesFound, 0) / stats.textures.length;
      const embeddedCount = stats.textures.filter(t => t.embeddedTextures).length;
      const mtlCount = stats.textures.filter(t => t.mtlLoaded).length;
      console.log(`    textures: avg ${avgApplied.toFixed(1)} applied / ${avgFound.toFixed(1)} found, ${embeddedCount} embedded, ${mtlCount} with MTL`);
    }
  }

  return { failed: Array.from(failedFiles), dimensionLogs };
}

export function getFailedFiles() {
  return Array.from(failedFiles);
}

/**
 * Returns the raw (pre-scale) {width,height,depth} of a preloaded model
 * file, as measured right after loading. Used by the scale calibrator
 * (src/calibrate.js) to convert a "target height in meters" slider value
 * into an absolute Three.js scale factor (scale = targetHeight / rawHeight).
 */
export function getRawDimensions(file) {
  const cached = rawCache.get(file);
  return cached ? cached.rawDimensions : null;
}

function calculateBaseScale(className, rawHeight, classCfg, fileOverrides) {
  if (fileOverrides && fileOverrides[className]) {
    return fileOverrides[className] / rawHeight;
  }
  
  if (classSizeProfiles && classSizeProfiles[className]) {
    const profile = classSizeProfiles[className];
    const targetHeight = profile.realHeightMeters;
    const variance = profile.sizeVariance || 0.1;
    const variationFactor = 1 + (Math.random() - 0.5) * variance * 2;
    const adjustedTarget = targetHeight * variationFactor;
    return adjustedTarget / rawHeight;
  }
  
  if (classCfg && classCfg.targetHeightMeters) {
    return classCfg.targetHeightMeters / rawHeight;
  }
  
  return (classCfg && classCfg.scale) || 1;
}

export function calculateSceneFactor(groundPolygons, imageWidth, imageHeight) {
  if (!groundPolygons || groundPolygons.length === 0) {
    return 1.0;
  }
  
  let totalArea = 0;
  for (const poly of groundPolygons) {
    totalArea += poly.area || 0;
  }
  
  const imageArea = imageWidth * imageHeight;
  const groundAreaRatio = totalArea / imageArea;
  const referenceGroundRatio = 0.4;
  
  let sceneFactor = Math.sqrt(Math.max(groundAreaRatio / referenceGroundRatio, 0.05));
  sceneFactor = Math.min(Math.max(sceneFactor, 0.15), 2.0);
  
  return sceneFactor;
}

export function calculateShotScaleFactor(objects, classSizeProfiles) {
  let totalOccupancy = 0;
  let objectCount = objects.length;
  
  for (const obj of objects) {
    const profile = classSizeProfiles && classSizeProfiles[obj.className];
    if (profile) {
      totalOccupancy += profile.occupancyRatio || 0.05;
    } else {
      totalOccupancy += 0.05;
    }
  }
  
  if (objectCount === 1) {
    const maxSingleOccupancy = 0.9;
    if (totalOccupancy <= maxSingleOccupancy) {
      return 1.0;
    }
    return maxSingleOccupancy / totalOccupancy;
  }
  
  const maxOccupancy = 0.7;
  if (totalOccupancy <= maxOccupancy) {
    return 1.0;
  }
  
  return maxOccupancy / totalOccupancy;
}

/**
 * Resolves the final Three.js scale factor for one object instance.
 *
 * Priority order:
 *   1) forcedScale            - used only by the calibrator (src/calibrate.js)
 *                                to preview an exact scale live; bypasses
 *                                everything else, no safety cap.
 *   2) scaleOverrides[background][file]
 *                              - a manually-calibrated absolute scale for
 *                                this exact file on this exact background
 *                                (saved from /calibrate.html). Already
 *                                accounts for that background's ground
 *                                geometry, so sceneFactor is NOT reapplied,
 *                                only shotScaleFactor (multi-object shot
 *                                shrink) still applies.
 *   3) scaleOverrides._default[file]
 *                              - a manually-calibrated scale not tied to a
 *                                specific background; sceneFactor still
 *                                applies since this wasn't calibrated
 *                                against a particular ground zone.
 *   4) legacy automatic scaling (classSizeProfiles / classCfg), same as
 *      before, kept as a fallback for any file that hasn't been
 *      calibrated yet.
 */
function resolveFinalScale({ className, file, rawDimensions, classCfg, fileOverrides, sceneFactor, shotScaleFactor, background, scaleOverrides, forcedScale }) {
  if (forcedScale != null && Number.isFinite(forcedScale) && forcedScale > 0) {
    return forcedScale;
  }

  const bgMap = (scaleOverrides && background && scaleOverrides[background]) || null;
  const defaultMap = (scaleOverrides && scaleOverrides._default) || null;

  if (bgMap && Number.isFinite(bgMap[file])) {
    return bgMap[file] * shotScaleFactor;
  }

  if (defaultMap && Number.isFinite(defaultMap[file])) {
    return defaultMap[file] * sceneFactor * shotScaleFactor;
  }

  const baseScale = calculateBaseScale(className, rawDimensions.height, classCfg, fileOverrides);
  let finalScale = baseScale * sceneFactor * shotScaleFactor;

  const maxDimension = Math.max(rawDimensions.width, rawDimensions.height, rawDimensions.depth);
  if (maxDimension > 10) {
    const extraScale = Math.min(1, 10 / maxDimension);
    finalScale *= extraScale;
  }
  return finalScale;
}

// Parts that should NEVER get the random body-paint color, even in
// "procedural" mode: tires/rims stay black/metal, glass stays glass,
// hydraulics/cables/interior stay whatever the source model made them.
// Matched against the material name first, falling back to the mesh name,
// case-insensitive substring match. A class or a specific file can extend
// this via generation.config.json: "paintExclude": ["extraKeyword"], or
// replace it entirely with an allowlist via "paintInclude": ["body"]
// (when paintInclude is set, ONLY names containing one of those keywords
// get painted; everything else is left alone).
const DEFAULT_PAINT_EXCLUDE_KEYWORDS = [
  "tire", "tyre", "wheel", "rim", "track", "tread",
  "glass", "window", "windshield", "windscreen", "mirror", "lens",
  "light", "lamp", "headlight", "taillight", "beacon", "led", "emissive", "glow",
  "chrome", "license", "plate", "logo", "badge",
  "interior", "seat", "leather", "dashboard",
  "cable", "wire", "hose", "hydraulic", "chain", "rope", "hook",
  "rubber", "exhaust", "muffler",
];

function shouldPaintMaterial(mat, mesh, matPlan) {
  const name = ((mat && mat.name) || (mesh && mesh.name) || "").toLowerCase();
  const includeList = matPlan.paintInclude;
  if (includeList && includeList.length > 0) {
    return includeList.some((kw) => name.includes(String(kw).toLowerCase()));
  }
  const excludeList = [...DEFAULT_PAINT_EXCLUDE_KEYWORDS, ...(matPlan.paintExclude || [])];
  return !excludeList.some((kw) => name.includes(String(kw).toLowerCase()));
}

export function instantiateModel({
  className,
  file,
  color,
  classCfg,
  sceneFactor = 1.0,
  shotScaleFactor = 1.0,
  fileOverrides = null,
  background = null,
  scaleOverrides = null,
  forcedScale = null,
  materialOverrides = null,
}) {
  const cached = rawCache.get(file);
  if (!cached) {
    throw new PipelineError(`Model not preloaded: ${file} (class ${className})`, {
      code: "MODEL_NOT_PRELOADED",
      hint: "This usually means the file failed during preload; check the console for a MODEL_LOAD_ERROR above.",
    });
  }

  const clone = cached.root.clone(true);
  const ownerId = nextOwnerId++;
  const clonedMaterials = [];

  const finalScale = resolveFinalScale({
    className,
    file,
    rawDimensions: cached.rawDimensions,
    classCfg,
    fileOverrides,
    sceneFactor,
    shotScaleFactor,
    background,
    scaleOverrides,
    forcedScale,
  });

  // ---- material plan: "procedural" (solid painted-metal color, randomized
  // per shot, ignores whatever texture the source file did or didn't have)
  // vs "original" (leave the file's own material/texture completely alone).
  // A specific file entry in materialOverrides wins over the class default
  // in classCfg, so a single exceptional file can be flipped either way.
  const fileMatOverride = materialOverrides && materialOverrides[file];
  const matPlan = fileMatOverride || classCfg || {};
  const isProcedural = matPlan.mode === "procedural";
  let appliedColor = null;
  if (isProcedural) {
    const palette = (fileMatOverride && fileMatOverride.colors) || matPlan.colors || (color ? [color] : ["#8a8a8a"]);
    appliedColor = palette[Math.floor(Math.random() * palette.length)];
  }

  clone.traverse((child) => {
    if (child.isMesh) {
      child.userData.ownerId = ownerId;
      child.userData.className = className;
      child.castShadow = false;
      child.receiveShadow = false;

      if (isProcedural) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        const resolvedMaterials = materials.map((mat) => {
          if (shouldPaintMaterial(mat, child, matPlan)) {
            const painted = new THREE.MeshStandardMaterial({
              color: new THREE.Color(appliedColor),
              metalness: matPlan.metalness ?? 0.5,
              roughness: matPlan.roughness ?? 0.5,
            });
            clonedMaterials.push(painted);
            return painted;
          }
          // Not bodywork (tire, glass, hydraulic, interior, etc.) - keep
          // whatever material the source file already had for this part.
          const cloned = mat.clone();
          clonedMaterials.push(cloned);
          return cloned;
        });
        child.material = Array.isArray(child.material) ? resolvedMaterials : resolvedMaterials[0];
      } else {
        const cloneMaterial = (mat) => {
          const cloned = mat.clone();
          clonedMaterials.push(cloned);
          return cloned;
        };
        child.material = Array.isArray(child.material)
          ? child.material.map(cloneMaterial)
          : cloneMaterial(child.material);
      }
    }
  });

  clone.scale.setScalar(finalScale);
  clone.userData.ownerId = ownerId;
  clone.userData.className = className;
  clone.userData.__clonedMaterials = clonedMaterials;
  clone.userData.__rawDimensions = cached.rawDimensions;
  clone.userData.__finalScale = finalScale;
  clone.userData.__textureReport = cached.textureReport;
  clone.userData.__materialMode = isProcedural ? "procedural" : "original";
  clone.userData.__appliedColor = appliedColor;

  return clone;
}

export function disposeInstance(object3D) {
  const materials = object3D.userData.__clonedMaterials || [];
  for (const mat of materials) {
    if (mat.map) { mat.map.dispose(); }
    if (mat.normalMap) { mat.normalMap.dispose(); }
    if (mat.roughnessMap) { mat.roughnessMap.dispose(); }
    if (mat.metalnessMap) { mat.metalnessMap.dispose(); }
    if (mat.aoMap) { mat.aoMap.dispose(); }
    if (mat.emissiveMap) { mat.emissiveMap.dispose(); }
    if (mat.displacementMap) { mat.displacementMap.dispose(); }
    if (mat.specularMap) { mat.specularMap.dispose(); }
    mat.dispose();
  }
}