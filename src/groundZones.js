/**
 * groundZones.js
 * -----------------------------------------------------------------------
 * Reads a VIA (VGG Image Annotator) style JSON file (public/config/ground.json)
 * where, for each background image, one or more polygon regions describe
 * where the "floor" of the photo is (region_attributes.label === "ground"
 * or "zone"). Coordinates are in the original image's pixel space.
 *
 * Because the camera and background plane are both fixed and the plane is
 * always sized to exactly fill the camera frustum, a point normalized to
 * [0,1] on the background image maps 1:1 to a normalized screen point.
 * That lets layoutManager.js turn "pick a random point inside this zone"
 * into "pick a random point on screen", then raycast it onto the y=0
 * ground plane to get a real 3D spawn position (see mathUtils.js).
 * -----------------------------------------------------------------------
 */
import { PipelineError } from "../scripts/errors.js";

let cache = null;

export async function loadGroundZonesFile() {
  if (cache) return cache;
  const res = await fetch("/config/ground.json");
  if (!res.ok) {
    throw new PipelineError("ground.json could not be loaded from /config/ground.json", {
      code: "NO_GROUND_ZONES",
      hint: "Make sure public/config/ground.json exists (export it from VGG Image Annotator).",
    });
  }
  cache = await res.json();
  return cache;
}

function polygonArea(xs, ys) {
  let area = 0;
  for (let i = 0; i < xs.length; i++) {
    const j = (i + 1) % xs.length;
    area += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return Math.abs(area / 2);
}

/**
 * Returns an array of normalized polygons ([{x,y}, ...] in 0..1, top-left
 * origin) with label "ground"/"zone" that belong to the given background
 * image, using imgWidth/imgHeight (the actual loaded texture size) to
 * normalize the raw pixel coordinates stored in ground.json.
 */
export function getZonesForBackground(zonesData, backgroundRelPath, imgWidth, imgHeight) {
  const filename = backgroundRelPath.split("/").pop();
  const entry = zonesData[filename];
  if (!entry || !entry.regions) return [];

  const polygons = [];
  for (const key of Object.keys(entry.regions)) {
    const region = entry.regions[key];
    const attrs = region.shape_attributes;
    const label = (region.region_attributes && region.region_attributes.label) || "";
    if (!attrs || attrs.name !== "polygon") continue;
    if (label !== "ground" && label !== "zone") continue;
    const xs = attrs.all_points_x;
    const ys = attrs.all_points_y;
    if (!xs || !ys || xs.length < 3) continue;

    const points = xs.map((x, i) => ({
      x: Math.min(1, Math.max(0, x / imgWidth)),
      y: Math.min(1, Math.max(0, ys[i] / imgHeight)),
    }));
    
    // Calculate area in normalized coordinates
    const normXs = points.map(p => p.x);
    const normYs = points.map(p => p.y);
    const normArea = polygonArea(normXs, normYs);
    
    polygons.push({ points, area: normArea });
  }
  return polygons;
}

function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Picks a uniformly random point (u, v in 0..1) inside one of the given
 * polygons (weighted by area so bigger zones get proportionally more
 * samples), using rejection sampling against each polygon's bbox.
 */
export function randomPointInZones(polygons, maxAttemptsPerTry = 40) {
  if (!polygons || polygons.length === 0) return null;

  const totalArea = polygons.reduce((s, p) => s + Math.max(p.area, 1e-6), 0);
  let r = Math.random() * totalArea;
  let chosen = polygons[polygons.length - 1];
  for (const poly of polygons) {
    r -= Math.max(poly.area, 1e-6);
    if (r <= 0) {
      chosen = poly;
      break;
    }
  }

  const xs = chosen.points.map((p) => p.x);
  const ys = chosen.points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  for (let i = 0; i < maxAttemptsPerTry; i++) {
    const candidate = {
      x: minX + Math.random() * (maxX - minX),
      y: minY + Math.random() * (maxY - minY),
    };
    if (pointInPolygon(candidate, chosen.points)) {
      return candidate;
    }
  }
  // Fallback: polygon centroid (always inside for convex/near-convex shapes)
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
  return { x: cx, y: cy };
}

/**
 * Picks a random point with bias toward the center of the zone.
 * Uses gaussian-like distribution around the centroid.
 */
export function centerBiasedPointInZones(zones) {
  if (!zones || zones.length === 0) return null;
  
  // Pick a zone weighted by area
  const totalArea = zones.reduce((s, p) => s + Math.max(p.area, 1e-6), 0);
  let r = Math.random() * totalArea;
  let chosen = zones[zones.length - 1];
  for (const zone of zones) {
    r -= Math.max(zone.area, 1e-6);
    if (r <= 0) {
      chosen = zone;
      break;
    }
  }
  
  // Calculate centroid
  const xs = chosen.points.map(p => p.x);
  const ys = chosen.points.map(p => p.y);
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
  
  // Find max distance from centroid to any polygon point (for scaling)
  let maxDist = 0;
  for (const p of chosen.points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > maxDist) maxDist = dist;
  }
  
  // Sample with gaussian-like distribution (biased toward center)
  for (let attempt = 0; attempt < 20; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    // Use quadratic falloff for center bias
    const radiusFactor = Math.pow(Math.random(), 1.5);
    const radius = maxDist * radiusFactor * 0.9;
    
    const candidate = {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    };
    
    // Clamp to [0,1]
    candidate.x = Math.max(0, Math.min(1, candidate.x));
    candidate.y = Math.max(0, Math.min(1, candidate.y));
    
    // Check if inside polygon
    if (pointInPolygon(candidate, chosen.points)) {
      return candidate;
    }
  }
  
  // Fallback: return centroid
  return { x: cx, y: cy };
}