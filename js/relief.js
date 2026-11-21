// Raised-detail check for low-relief parts (coins, badges, plaques).
// Slices through the raised layer, rasterizes it, and asks what a nozzle line of width w
// can reproduce: strokes narrower than w vanish (morphological opening) and gaps narrower
// than w fill in (closing). Surface-ray wall thickness misses both on embossed text.

export const RELIEF = {
  maxHeight: 6.0,   // mm: taller than this is not a flat relief part
  minSpan: 18.0,    // mm
  dropRatio: 0.65,  // cross-section shrinks below this share of the base where the relief starts
  px: 0.05,         // mm per raster pixel
  maxPixels: 4e6,
  minBlobMm2: 0.1,  // lost/filled patches smaller than this are corner rounding, not detail
  // Absolute, not a share: a wide rim must not dilute a line of unreadable text.
  thinWarnMm2: 2.0, // raised area narrower than one line (strokes that vanish or blob)
  gapWarnMm2: 2.0,  // gap area narrower than one line (letter counters/spacing that fill in)
};

export const isLowRelief = ([dx, dy, dz]) => dz <= RELIEF.maxHeight && Math.max(dx, dy) >= RELIEF.minSpan;

// Oriented segments (interior on the left) where the plane z cuts the mesh.
function sliceSegments(V, F, nT, z) {
  const segs = [], tris = [];
  const p = [];
  for (let t = 0; t < nT; t++) {
    const i = [F[t * 3] * 3, F[t * 3 + 1] * 3, F[t * 3 + 2] * 3];
    p.length = 0;
    for (let k = 0; k < 3; k++) {
      const a = i[k], b = i[(k + 1) % 3];
      const za = V[a + 2] - z, zb = V[b + 2] - z;
      if ((za < 0) !== (zb < 0)) {
        const s = za / (za - zb);
        p.push(V[a] + s * (V[b] - V[a]), V[a + 1] + s * (V[b + 1] - V[a + 1]));
      }
    }
    if (p.length !== 4) continue;
    const a = i[0], b = i[1], c = i[2];
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
    // Interior on the left: direction (-ny, nx) for an outward normal.
    if ((p[2] - p[0]) * -ny + (p[3] - p[1]) * nx >= 0) segs.push(p[0], p[1], p[2], p[3]);
    else segs.push(p[2], p[3], p[0], p[1]);
    tris.push(t);
  }
  return { segs, tris };
}

export const sectionArea = (mesh, z) => Math.abs(segArea(sliceSegments(mesh.V, mesh.F, mesh.nT, z).segs));

const segArea = (s) => { let a = 0; for (let i = 0; i < s.length; i += 4) a += s[i] * s[i + 3] - s[i + 2] * s[i + 1]; return a / 2; };

// Felzenszwalb squared Euclidean distance transform (pixels) to the nearest `true` pixel.
function edt(mask, W, H) {
  const INF = 1e20, D = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) D[i] = mask[i] ? 0 : INF;
  const n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), zb = new Float64Array(n + 1);
  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0; v[0] = 0; zb[0] = -INF; zb[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      while ((s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])) <= zb[k]) k--;
      k++; v[k] = q; zb[k] = s; zb[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (zb[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let x = 0; x < W; x++) pass(H, (y) => D[y * W + x], (y, val) => { D[y * W + x] = val; });
  for (let y = 0; y < H; y++) pass(W, (x) => D[y * W + x], (x, val) => { D[y * W + x] = val; });
  return D;
}

// Clears 8-connected blobs smaller than minPx in place; returns the pixels kept.
function dropSmall(m, W, H, minPx) {
  const seen = new Uint8Array(W * H), stack = [], blob = [];
  let kept = 0;
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || seen[s]) continue;
    blob.length = 0; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(); blob.push(i);
      const x = i % W, y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, j = ny * W + nx;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && m[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (blob.length < minPx) for (const i of blob) m[i] = 0;
    else kept += blob.length;
  }
  return kept;
}

// Returns null when the part is not a low-relief part with a distinct raised layer.
export function analyzeRelief(mesh, size, lineWidth) {
  if (!isLowRelief(size)) return null;
  const { V, F, nT } = mesh;
  const dz = size[2];
  // Find where the cross-section first shrinks: that is the base/relief boundary.
  let base = 0, start = null;
  for (let z = 0.1; z < dz - 0.05; z += 0.1) {
    const a = Math.abs(segArea(sliceSegments(V, F, nT, z).segs));
    if (a > base) base = a;
    else if (a > 0 && a < RELIEF.dropRatio * base) { start = z; break; }
  }
  if (start === null) return null;
  const z = (start + dz) / 2;
  const { segs, tris } = sliceSegments(V, F, nT, z);
  if (!segs.length) return null;

  const r = lineWidth / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < segs.length; i += 2) { x0 = Math.min(x0, segs[i]); x1 = Math.max(x1, segs[i]); y0 = Math.min(y0, segs[i + 1]); y1 = Math.max(y1, segs[i + 1]); }
  const pad = 2 * r + 0.1;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const px = Math.max(RELIEF.px, Math.sqrt(((x1 - x0) * (y1 - y0)) / RELIEF.maxPixels));
  const W = Math.ceil((x1 - x0) / px), H = Math.ceil((y1 - y0) / px);

  // Nonzero-winding scanline fill (tolerates overlapping, un-unioned shells).
  const rows = Array.from({ length: H }, () => []);
  for (let i = 0; i < segs.length; i += 4) {
    const ax = segs[i], ay = segs[i + 1], bx = segs[i + 2], by = segs[i + 3];
    if (ay === by) continue;
    const dir = by > ay ? 1 : -1;
    const lo = Math.min(ay, by), hi = Math.max(ay, by);
    for (let row = Math.max(0, Math.ceil((lo - y0) / px - 0.5)); row < H; row++) {
      const y = y0 + (row + 0.5) * px;
      if (y >= hi) break;
      rows[row].push(ax + (y - ay) / (by - ay) * (bx - ax), dir);
    }
  }
  const filled = new Uint8Array(W * H);
  for (let row = 0; row < H; row++) {
    const c = rows[row];
    const order = Array.from({ length: c.length / 2 }, (_, k) => k).sort((a, b) => c[a * 2] - c[b * 2]);
    let wind = 0;
    for (let k = 0; k < order.length; k++) {
      const prev = wind;
      wind += c[order[k] * 2 + 1];
      if (prev !== 0 && k > 0) {
        const xa = Math.max(0, Math.ceil((c[order[k - 1] * 2] - x0) / px - 0.5));
        const xb = Math.min(W, Math.ceil((c[order[k] * 2] - x0) / px - 0.5));
        for (let x = xa; x < xb; x++) filled[row * W + x] = 1;
      }
    }
  }

  const r2 = (r / px) ** 2, N = W * H;
  const not = (m) => { const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = m[i] ? 0 : 1; return o; };
  const toEmpty = edt(not(filled), W, H);
  const eroded = new Uint8Array(N); for (let i = 0; i < N; i++) eroded[i] = filled[i] && toEmpty[i] > r2 ? 1 : 0;
  const toEroded = edt(eroded, W, H);
  const toFilled = edt(filled, W, H);
  const outsideDilated = new Uint8Array(N); for (let i = 0; i < N; i++) outsideDilated[i] = toFilled[i] > r2 ? 1 : 0;
  const toOutside = edt(outsideDilated, W, H);
  const thin = new Uint8Array(N), gap = new Uint8Array(N);
  let area = 0;
  for (let i = 0; i < N; i++) {
    if (filled[i]) { area++; if (toEroded[i] > r2) thin[i] = 1; }
    else if (toOutside[i] > r2) gap[i] = 1;
  }
  // Every sharp corner loses a small fillet to a round nozzle; that is not lost detail.
  const minPx = Math.ceil(RELIEF.minBlobMm2 / (px * px));
  const thinPx = dropSmall(thin, W, H, minPx), gapPx = dropSmall(gap, W, H, minPx);

  // Faces whose cut edge borders a lost stroke or a filled-in gap, for highlighting.
  const faces = [];
  const at = (x, y) => { const cx = Math.floor((x - x0) / px), cy = Math.floor((y - y0) / px); return cx >= 0 && cy >= 0 && cx < W && cy < H ? cy * W + cx : -1; };
  for (let k = 0; k < tris.length && faces.length < 20000; k++) {
    const i = k * 4, mx = (segs[i] + segs[i + 2]) / 2, my = (segs[i + 1] + segs[i + 3]) / 2;
    const tx = segs[i + 2] - segs[i], ty = segs[i + 3] - segs[i + 1], len = Math.hypot(tx, ty) || 1;
    const ox = -ty / len * px * 1.5, oy = tx / len * px * 1.5; // left = inside
    const inside = at(mx + ox, my + oy), outside = at(mx - ox, my - oy);
    if ((inside >= 0 && thin[inside]) || (outside >= 0 && gap[outside])) faces.push(tris[k]);
  }

  const pa = px * px;
  return {
    z: Math.round(z * 100) / 100,
    lineWidth,
    areaMm2: area * pa,
    thinMm2: thinPx * pa,
    gapMm2: gapPx * pa,
    thinShare: area ? thinPx / area : 0,
    gapShare: area ? gapPx / area : 0,
    faces,
  };
}
