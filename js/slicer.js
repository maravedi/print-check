// Real 2D layer slicer + physics-based print time estimator in pure JS.
// Slices the triangle mesh at each layer height Z_l, computes exact perimeter length
// and cross-sectional area, detects empty layers and overhanging support columns, and
// simulates extrusion + acceleration + cooling + travel time per layer using the
// printer's OrcaSlicer PLA profile.

export function estimate(mesh, printer, scale = 1.0, onProgress = () => {}) {
  const { V, F, nT } = mesh;
  const lh = printer.layer;
  const flh = printer.firstLayer;

  // Compute scaled Z range (assuming model is already placed with min Z = 0)
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < V.length; i += 3) {
    const x = V[i] * scale, y = V[i + 1] * scale, z = V[i + 2] * scale;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const height = maxZ - minZ;
  if (height <= 0 || !Number.isFinite(height)) {
    return { seconds: 0, minutes: 0, layers: 0, emptyLayers: [], filamentMm: 0, filamentG: 0, breakdown: {} };
  }

  const nLayers = Math.max(1, Math.floor((height - flh) / lh) + 1);
  const zLevels = new Float64Array(nLayers);
  for (let l = 0; l < nLayers; l++) {
    zLevels[l] = minZ + (l === 0 ? flh * 0.5 : flh + (l - 0.5) * lh);
  }

  // Per-layer accumulators: perimeter length (mm), signed 2D area (mm^2), segment count,
  // and sharp 2D corner turn sum (radians of turns > 35 deg, where jerk slows the printhead).
  const perim = new Float64Array(nLayers);
  const area = new Float64Array(nLayers);
  const segCount = new Int32Array(nLayers);
  const turnSum = new Float64Array(nLayers);

  // Precompute per-triangle 2D horizontal unit normal (nx, ny) / hypot(nx, ny)
  const n2x = new Float32Array(nT);
  const n2y = new Float32Array(nT);
  const triZLo = new Float32Array(nT);
  const triZHi = new Float32Array(nT);

  // 2D heightmap grid (2 mm cells): track model floor (lowest Z), ceiling, and lowest overhang
  // Coarser cells for very large models (a typo like 1000 mm for 10 mm) keep memory bounded.
  const cell = Math.max(2.0, Math.sqrt(((maxX - minX) * (maxY - minY)) / 250000));
  const gx = Math.max(1, Math.ceil((maxX - minX) / cell));
  const gy = Math.max(1, Math.ceil((maxY - minY) / cell));
  const cellMinZ = new Float64Array(gx * gy).fill(Infinity);
  const cellMaxZ = new Float64Array(gx * gy).fill(-Infinity);
  const overhangMinZ = new Float64Array(gx * gy).fill(Infinity);
  const cosSupport = Math.sin((printer.supportAngle || 30) * Math.PI / 180);

  onProgress("Slicing layers", 0.92);

  for (let t = 0; t < nT; t++) {
    const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
    const ax = V[a] * scale, ay = V[a + 1] * scale, az = V[a + 2] * scale;
    const bx = V[b] * scale, by = V[b + 1] * scale, bz = V[b + 2] * scale;
    const cx = V[c] * scale, cy = V[c + 1] * scale, cz = V[c + 2] * scale;

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;

    const zLo = Math.min(az, bz, cz), zHi = Math.max(az, bz, cz);
    triZLo[t] = zLo; triZHi[t] = zHi;
    const nh = Math.hypot(nx, ny);
    if (nh > 1e-9) { n2x[t] = nx / nh; n2y[t] = ny / nh; }
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
    const ix = Math.min(gx - 1, Math.max(0, Math.floor((mx - minX) / cell)));
    const iy = Math.min(gy - 1, Math.max(0, Math.floor((my - minY) / cell)));
    const gi = iy * gx + ix;
    if (zLo < cellMinZ[gi]) cellMinZ[gi] = zLo;
    if (zHi > cellMaxZ[gi]) cellMaxZ[gi] = zHi;

    if (zLo > flh * 1.5) {
      const nLen = Math.hypot(nx, ny, nz);
      if (nLen > 0 && nz / nLen < -cosSupport) {
        if (mz < overhangMinZ[gi]) overhangMinZ[gi] = mz;
      }
    }

    if (zHi <= zLevels[0] || zLo >= zLevels[nLayers - 1]) continue;
    let lStart = Math.max(0, Math.ceil((zLo - minZ - flh * 0.5) / lh));
    let lEnd = Math.min(nLayers - 1, Math.floor((zHi - minZ - flh * 0.5) / lh) + 1);
    for (let l = lStart; l <= lEnd; l++) {
      const z = zLevels[l];
      if (z <= zLo || z >= zHi) continue;
      let x0 = 0, y0 = 0, x1 = 0, y1 = 0, pts = 0;
      if ((az < z && bz >= z) || (bz < z && az >= z)) {
        const s = (z - az) / (bz - az);
        x0 = ax + s * (bx - ax); y0 = ay + s * (by - ay); pts++;
      }
      if ((bz < z && cz >= z) || (cz < z && bz >= z)) {
        const s = (z - bz) / (cz - bz);
        const px = bx + s * (cx - bx), py = by + s * (cy - by);
        if (pts === 0) { x0 = px; y0 = py; } else { x1 = px; y1 = py; }
        pts++;
      }
      if (pts < 2 && ((cz < z && az >= z) || (az < z && cz >= z))) {
        const s = (z - cz) / (az - cz);
        const px = cx + s * (ax - cx), py = cy + s * (ay - cy);
        if (pts === 0) { x0 = px; y0 = py; } else { x1 = px; y1 = py; }
        pts++;
      }
      if (pts < 2) continue;
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      perim[l] += len;
      segCount[l]++;
      const sign = (dx * ny - dy * nx) >= 0 ? 1 : -1;
      area[l] += sign * (x0 * y1 - x1 * y0) * 0.5;
    }
  }

  for (let l = 0; l < nLayers; l++) area[l] = Math.abs(area[l]);

  // Accumulate 2D turning angles across mesh edges that span layers:
  // two triangles sharing a non-horizontal edge create a 2D corner of angle acos(n2_a · n2_b)
  // in every layer that intersects that edge's Z span.
  if (!mesh._turnEdges) {
    // Build once per mesh (scale-independent! Angles don't change with uniform scale)
    const edgeMap = new Map();
    const nV = mesh.nV;
    const pairs = [];
    for (let t = 0; t < nT; t++) {
      const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2];
      const tri = [a, b, c];
      for (let k = 0; k < 3; k++) {
        const u = tri[k], v = tri[(k + 1) % 3];
        const lo = u < v ? u : v, hi = u < v ? v : u;
        const key = lo * nV + hi;
        const prev = edgeMap.get(key);
        if (prev === undefined) edgeMap.set(key, t);
        else if (prev >= 0) {
          pairs.push(prev, t, lo, hi);
          edgeMap.set(key, -1);
        }
      }
    }
    mesh._turnEdges = Int32Array.from(pairs);
  }
  const te = mesh._turnEdges;
  for (let i = 0; i < te.length; i += 4) {
    const t1 = te[i], t2 = te[i + 1], u = te[i + 2] * 3, v = te[i + 3] * 3;
    const dot = n2x[t1] * n2x[t2] + n2y[t1] * n2y[t2];
    if (dot > 0.82) continue; // < ~35 deg is smooth faceted cylinder/sphere, no jerk slowdown
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    const uz = V[u + 2] * scale, vz = V[v + 2] * scale;
    const zLo = Math.min(uz, vz), zHi = Math.max(uz, vz);
    if (zHi - zLo < lh * 0.85) continue;
    if (zHi <= zLevels[0] || zLo >= zLevels[nLayers - 1]) continue;
    let lStart = Math.max(0, Math.ceil((zLo - minZ - flh * 0.5) / lh));
    let lEnd = Math.min(nLayers - 1, Math.floor((zHi - minZ - flh * 0.5) / lh) + 1);
    for (let l = lStart; l <= lEnd; l++) {
      const z = zLevels[l];
      if (z > zLo && z < zHi) turnSum[l] += angle;
    }
  }

  const emptyLayers = [];
  for (let l = 0; l < nLayers - 1; l++) {
    if (perim[l] < 0.2 || area[l] < 0.05) emptyLayers.push(l + 1);
  }

  // Support volume (mm^3): one column per 2x2mm cell that has an overhang
  let supportVolMm3 = 0;
  for (let i = 0; i < gx * gy; i++) {
    if (overhangMinZ[i] < Infinity) {
      const h = Math.max(0, overhangMinZ[i] - minZ);
      supportVolMm3 += h * (cell * cell) * 0.18;
    }
  }

  // Per-layer extrusion & kinematics calculation
  const walls = printer.walls;
  const lwOuter = printer.lw.outer, lwInner = printer.lw.inner;
  const lwInfill = printer.lw.infill, lwSolid = printer.lw.solid, lwSupport = printer.lw.support;
  const wallThickness = lwOuter + (walls - 1) * lwInner;
  const sp = printer.speed;
  const maxVol = printer.maxVolumetric;

  const vCap = (vTarget, lw, h) => Math.min(vTarget, maxVol / (lw * h));

  let tOuter = 0, tInner = 0, tSolid = 0, tSparse = 0, tSupport = 0, tTravel = 0, tCorner = 0, tCool = 0;
  let totalExtrudedMm3 = 0;

  for (let l = 0; l < nLayers; l++) {
    const h = l === 0 ? flh : lh;
    const P = perim[l];
    const A = area[l];
    const S = segCount[l];
    if (P <= 0 || A <= 0) continue;

    // Effective wall thickness is bounded by A / P so thin features don't double-count walls
    const effWallThk = Math.min(wallThickness, A / Math.max(P, 1e-3));
    const wallScale = effWallThk / wallThickness;
    const lenOuter = P * Math.min(1, wallScale * 1.3);
    const lenInner = Math.max(0, (walls - 1) * Math.max(0, P - Math.PI * lwOuter)) * wallScale;
    const areaWalls = Math.min(A, P * effWallThk);
    const areaInterior = Math.max(0, A - areaWalls);

    // Solid vs sparse infill: bottom layers, top layers, and step changes in area
    let solidFrac = 0;
    if (l < printer.bottom || l >= nLayers - printer.top) {
      solidFrac = 1.0;
    } else {
      let deltaA = 0;
      for (let d = 1; d <= printer.top; d++) {
        if (l + d < nLayers) deltaA = Math.max(deltaA, Math.max(0, A - area[l + d]));
      }
      for (let d = 1; d <= printer.bottom; d++) {
        if (l - d >= 0) deltaA = Math.max(deltaA, Math.max(0, A - area[l - d]));
      }
      solidFrac = Math.min(1.0, (deltaA * 1.2) / Math.max(1e-3, areaInterior));
    }

    const areaSolid = areaInterior * solidFrac;
    const areaSparse = areaInterior * (1 - solidFrac);
    const lenSolid = areaSolid / lwSolid;
    const lenSparse = (areaSparse * printer.infill) / lwInfill;

    const vOuter = l === 0 ? vCap(sp.first, lwOuter, h) : vCap(sp.outer, lwOuter, h);
    const vInner = l === 0 ? vCap(sp.first, lwInner, h) : vCap(sp.inner, lwInner, h);
    const vSolid = l === 0 ? vCap(sp.firstInfill, lwSolid, h) : vCap(l >= nLayers - 1 ? sp.top : sp.solid, lwSolid, h);
    const vSparse = l === 0 ? vCap(sp.firstInfill, lwInfill, h) : vCap(sp.infill, lwInfill, h);

    const dtOuter = lenOuter / vOuter;
    const dtInner = lenInner / vInner;
    const dtSolid = lenSolid / vSolid;
    const dtSparse = lenSparse / vSparse;
    // Cornering / acceleration time grows with sum of sharp 2D turn angles, gated by
    // wallScale^2 so features thinner than a nozzle line (Arachne-culled) don't add phantom corners.
    const dtCorner = turnSum[l] * 0.25 * (wallScale * wallScale);
    const dtTravel = (P * 0.5 + (lenSolid + lenSparse) * 0.15) / sp.travel;

    let layerTime = dtOuter + dtInner + dtSolid + dtSparse + dtCorner + dtTravel;
    let dtCool = 0;
    if (layerTime < printer.minLayerTime) {
      dtCool = printer.minLayerTime - layerTime;
    }

    tOuter += dtOuter; tInner += dtInner; tSolid += dtSolid; tSparse += dtSparse;
    tCorner += dtCorner; tTravel += dtTravel; tCool += dtCool;
    totalExtrudedMm3 += (lenOuter * lwOuter + lenInner * lwInner + lenSolid * lwSolid + lenSparse * lwInfill) * h;
  }

  const lenSupport = supportVolMm3 / (lwSupport * lh);
  tSupport = lenSupport / vCap(sp.support, lwSupport, lh);
  totalExtrudedMm3 += supportVolMm3;

  const f = printer.fit || { wall: 1, infill: 1, support: 1, corner: 1, travel: 1, cool: 1, layerOverhead: 0 };
  const rawSeconds =
    (tOuter + tInner) * f.wall +
    (tSolid + tSparse) * f.infill +
    tSupport * f.support +
    tCorner * (f.corner ?? 1) +
    tTravel * f.travel +
    tCool * (f.cool ?? 0.5) +
    nLayers * f.layerOverhead;

  const filamentArea = Math.PI * (1.75 / 2) ** 2;
  const filamentMm = totalExtrudedMm3 / filamentArea;
  const filamentG = (totalExtrudedMm3 / 1000) * 1.24;

  return {
    seconds: rawSeconds,
    minutes: rawSeconds / 60,
    layers: nLayers,
    emptyLayers,
    filamentMm,
    filamentG,
    features: {
      wallSec: tOuter + tInner,
      infillSec: tSolid + tSparse,
      supportSec: tSupport,
      cornerSec: tCorner,
      travelSec: tTravel,
      coolSec: tCool,
      nLayers,
    },
    breakdown: {
      wallsMin: ((tOuter + tInner) * f.wall + tCorner * (f.corner ?? 1)) / 60,
      infillMin: ((tSolid + tSparse) * f.infill) / 60,
      supportsMin: (tSupport * f.support) / 60,
      travelMin: (tTravel * f.travel + tCool * (f.cool ?? 0.5) + nLayers * f.layerOverhead) / 60,
    },
  };
}
