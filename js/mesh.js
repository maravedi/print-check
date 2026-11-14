// Mesh topology on raw triangles. Vertices are matched only when bit-identical
// (no welding), as in scripts/kiln/print_check.py: welding hides real defects.

export function buildMesh(pos) {
  const nT = pos.length / 9;
  const keyOf = new Map();
  const verts = [];
  const F = new Uint32Array(nT * 3);
  const f32 = new Float32Array(3);
  const u32 = new Uint32Array(f32.buffer);
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      f32[0] = pos[o]; f32[1] = pos[o + 1]; f32[2] = pos[o + 2];
      // -0 and +0 must match
      if (f32[0] === 0) f32[0] = 0; if (f32[1] === 0) f32[1] = 0; if (f32[2] === 0) f32[2] = 0;
      const key = u32[0] + "," + u32[1] + "," + u32[2];
      let id = keyOf.get(key);
      if (id === undefined) { id = verts.length / 3; keyOf.set(key, id); verts.push(f32[0], f32[1], f32[2]); }
      F[t * 3 + k] = id;
    }
  }
  const V = Float64Array.from(verts);
  return cleanFaces({ V, F, nV: V.length / 3, nT });
}

// Drop faces that repeat a vertex id, exact duplicate faces, and back-to-back face
// pairs (same three vertices, opposite winding: a zero-thickness double wall).
// Tinkercad's CSG leaves these behind; slicers discard them too.
function cleanFaces(mesh) {
  const { F, nT } = mesh;
  const keep = new Uint8Array(nT).fill(1);
  const seen = new Map();
  let degenerate = 0, duplicate = 0, backToBack = 0;
  for (let t = 0; t < nT; t++) {
    const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2];
    if (a === b || b === c || a === c) { keep[t] = 0; degenerate++; continue; }
    // canonical rotation keeps winding: start at the smallest id
    let r = [a, b, c];
    const m = Math.min(a, b, c);
    while (r[0] !== m) r = [r[1], r[2], r[0]];
    const fwd = r.join(","), rev = [r[0], r[2], r[1]].join(",");
    if (seen.has(fwd)) { keep[t] = 0; duplicate++; continue; }
    if (seen.has(rev)) { keep[t] = 0; keep[seen.get(rev)] = 0; seen.delete(rev); backToBack++; continue; }
    seen.set(fwd, t);
  }
  let n = 0;
  const F2 = new Uint32Array(nT * 3);
  for (let t = 0; t < nT; t++) if (keep[t]) { F2[n * 3] = F[t * 3]; F2[n * 3 + 1] = F[t * 3 + 1]; F2[n * 3 + 2] = F[t * 3 + 2]; n++; }
  return { ...mesh, F: F2.slice(0, n * 3), nT: n, rawT: nT, cleaned: { degenerate, duplicate, backToBack } };
}

// Edges keyed by (min,max) vertex id. Returns per-edge face lists and topology counts.
export function topology(mesh) {
  const { F, nT, nV } = mesh;
  const edgeMap = new Map(); // key -> index
  const edgeA = [], edgeB = [], edgeFaces = [], edgeDir = [];
  let degenerate = 0;
  for (let t = 0; t < nT; t++) {
    const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2];
    if (a === b || b === c || a === c) { degenerate++; }
    const tri = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const u = tri[k], v = tri[(k + 1) % 3];
      if (u === v) continue;
      const lo = u < v ? u : v, hi = u < v ? v : u;
      const key = lo * nV + hi; // safe below 2^53 for any realistic mesh
      let e = edgeMap.get(key);
      if (e === undefined) { e = edgeA.length; edgeMap.set(key, e); edgeA.push(lo); edgeB.push(hi); edgeFaces.push([]); edgeDir.push([]); }
      edgeFaces[e].push(t);
      edgeDir[e].push(u === lo ? 1 : -1);
    }
  }
  const open = [], nonManifold = [], flipped = [];
  for (let e = 0; e < edgeA.length; e++) {
    const n = edgeFaces[e].length;
    if (n === 1) open.push(e);
    else if (n > 2) nonManifold.push(e);
    else if (edgeDir[e][0] === edgeDir[e][1]) flipped.push(e);
  }
  // Parts: faces joined through edges with exactly two faces (union-find). Like
  // OrcaSlicer, shapes that only kiss along an edge (4+ faces) stay separate parts.
  const parent = new Int32Array(nT).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const fs of edgeFaces) if (fs.length === 2) {
    const ra = find(fs[0]), rb = find(fs[1]);
    if (ra !== rb) parent[ra] = rb;
  }
  const compOf = new Int32Array(nT);
  const roots = new Map();
  for (let t = 0; t < nT; t++) {
    const r = find(t);
    let c = roots.get(r);
    if (c === undefined) { c = roots.size; roots.set(r, c); }
    compOf[t] = c;
  }
  const nComp = roots.size;
  // A part is closed when every edge has an equal number of forward and backward faces
  // within that part. Non-manifold edges where forward === backward are self-touching /
  // kissing edges that slicers resolve cleanly; unequal counts are real open/broken edges.
  const compOpen = new Int32Array(nComp);
  for (let e = 0; e < edgeFaces.length; e++) {
    const fs = edgeFaces[e];
    if (fs.length === 2 && edgeDir[e][0] !== edgeDir[e][1]) continue;
    const bal = new Map();
    for (let i = 0; i < fs.length; i++) {
      const c = compOf[fs[i]];
      const cur = bal.get(c) || [0, 0];
      cur[edgeDir[e][i] > 0 ? 0 : 1]++;
      bal.set(c, cur);
    }
    for (const [c, [p, q]] of bal) if (p !== q) compOpen[c]++;
  }
  const nonManifoldBad = nonManifold.filter((e) => {
    let fwd = 0, rev = 0;
    for (let i = 0; i < edgeFaces[e].length; i++) {
      if (edgeDir[e][i] > 0) fwd++; else rev++;
    }
    return fwd !== rev;
  });
  return { edgeA, edgeB, edgeFaces, open, nonManifold, nonManifoldBad, flipped, degenerate, compOf, nComp, compOpen };
}

export function faceNormalArea(V, F, t, out) {
  const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
  const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
  const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  out[0] = len ? nx / len : 0; out[1] = len ? ny / len : 0; out[2] = len ? nz / len : 0;
  return len / 2;
}

// Per-component stats: signed volume, bbox, face list.
export function components(mesh, topo) {
  const { V, F, nT } = mesh;
  const comps = Array.from({ length: topo.nComp }, (_, i) => ({
    id: i, faces: [], volume: 0, area: 0,
    min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
    closed: topo.compOpen[i] === 0,
  }));
  const n = [0, 0, 0];
  for (let t = 0; t < nT; t++) {
    const c = comps[topo.compOf[t]];
    c.faces.push(t);
    const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, d = F[t * 3 + 2] * 3;
    c.volume += (V[a] * (V[b + 1] * V[d + 2] - V[b + 2] * V[d + 1])
      - V[a + 1] * (V[b] * V[d + 2] - V[b + 2] * V[d])
      + V[a + 2] * (V[b] * V[d + 1] - V[b + 1] * V[d])) / 6;
    c.area += faceNormalArea(V, F, t, n);
    for (const o of [a, b, d]) for (let k = 0; k < 3; k++) {
      if (V[o + k] < c.min[k]) c.min[k] = V[o + k];
      if (V[o + k] > c.max[k]) c.max[k] = V[o + k];
    }
  }
  for (const c of comps) c.faces = Uint32Array.from(c.faces);
  return comps;
}
