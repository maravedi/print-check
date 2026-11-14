// Minimal BVH over a subset of triangles: ray casts (nearest hit, hit count) and
// nearest-surface distance. Dependency-free so it runs in a Worker and in Node tests.

export class BVH {
  constructor(V, F, faces) {
    this.V = V; this.F = F;
    const n = faces.length;
    this.tri = Uint32Array.from(faces);
    const cen = new Float64Array(n * 3);
    const bmin = new Float64Array(n * 3), bmax = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = this.tri[i];
      for (let k = 0; k < 3; k++) {
        let lo = Infinity, hi = -Infinity;
        for (let j = 0; j < 3; j++) { const v = V[F[t * 3 + j] * 3 + k]; if (v < lo) lo = v; if (v > hi) hi = v; }
        bmin[i * 3 + k] = lo; bmax[i * 3 + k] = hi; cen[i * 3 + k] = (lo + hi) / 2;
      }
    }
    // nodes: [minx,miny,minz,maxx,maxy,maxz] + left/right or start/count
    this.nb = []; this.nl = []; this.nr = []; this.ns = []; this.nc = [];
    const idx = new Uint32Array(n).map((_, i) => i);
    const build = (start, end) => {
      const node = this.nl.length;
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = start; i < end; i++) {
        const j = idx[i];
        for (let k = 0; k < 3; k++) {
          if (bmin[j * 3 + k] < b[k]) b[k] = bmin[j * 3 + k];
          if (bmax[j * 3 + k] > b[k + 3]) b[k + 3] = bmax[j * 3 + k];
        }
      }
      this.nb.push(...b); this.nl.push(-1); this.nr.push(-1); this.ns.push(start); this.nc.push(end - start);
      if (end - start <= 6) return node;
      let axis = 0, ext = -1;
      for (let k = 0; k < 3; k++) if (b[k + 3] - b[k] > ext) { ext = b[k + 3] - b[k]; axis = k; }
      const mid = (b[axis] + b[axis + 3]) / 2;
      let i = start, j = end - 1;
      while (i <= j) {
        if (cen[idx[i] * 3 + axis] < mid) i++;
        else { const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; j--; }
      }
      if (i === start || i === end) i = (start + end) >> 1;
      const l = build(start, i), r = build(i, end);
      this.nl[node] = l; this.nr[node] = r; this.nc[node] = 0;
      return node;
    };
    if (n) build(0, n);
    this.order = Uint32Array.from(idx, (j) => this.tri[j]);
    this.bounds = n ? this.nb.slice(0, 6) : null;
  }

  // Möller–Trumbore. Returns distance t > eps or Infinity.
  rayTri(t, ox, oy, oz, dx, dy, dz) {
    const V = this.V, F = this.F;
    const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
    const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
    const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) return Infinity;
    const inv = 1 / det;
    const sx = ox - V[a], sy = oy - V[a + 1], sz = oz - V[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return Infinity;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return Infinity;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return d > 1e-6 ? d : Infinity;
  }

  boxRay(node, ox, oy, oz, idx, idy, idz, tmax) {
    const b = this.nb, o = node * 6;
    let t0 = 0, t1 = tmax;
    const o3 = [ox, oy, oz], i3 = [idx, idy, idz];
    for (let k = 0; k < 3; k++) {
      let ta = (b[o + k] - o3[k]) * i3[k], tb = (b[o + k + 3] - o3[k]) * i3[k];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    return true;
  }

  // Nearest exit-wall hit along a ray (skipping triangle `skip`): when `onlyExitSign` is ±1,
  // only hits whose outward normal (scaled by `onlyExitSign`) points along the ray count.
  raycast(ox, oy, oz, dx, dy, dz, skip = -1, tmax = Infinity, onlyExitSign = 0) {
    if (!this.bounds) return Infinity;
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
    const V = this.V, F = this.F;
    let best = tmax, bestTri = -1;
    const stack = [0];
    while (stack.length) {
      const nd = stack.pop();
      if (!this.boxRay(nd, ox, oy, oz, idx, idy, idz, best)) continue;
      if (this.nc[nd] > 0) {
        for (let i = this.ns[nd], e = i + this.nc[nd]; i < e; i++) {
          const t = this.order[i];
          if (t === skip) continue;
          const d = this.rayTri(t, ox, oy, oz, dx, dy, dz);
          if (d < best) { best = d; bestTri = t; }
        }
      } else { stack.push(this.nl[nd], this.nr[nd]); }
    }
    if (onlyExitSign && bestTri >= 0) {
      const a = F[bestTri * 3] * 3, b = F[bestTri * 3 + 1] * 3, c = F[bestTri * 3 + 2] * 3;
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
      const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
      const nx = (uy * vz - uz * vy) * onlyExitSign;
      const ny = (uz * vx - ux * vz) * onlyExitSign;
      const nz = (ux * vy - uy * vx) * onlyExitSign;
      if (nx * dx + ny * dy + nz * dz <= 0) return Infinity;
    }
    return best;
  }

  countHits(ox, oy, oz, dx, dy, dz) {
    if (!this.bounds) return 0;
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
    let n = 0;
    const stack = [0];
    while (stack.length) {
      const nd = stack.pop();
      if (!this.boxRay(nd, ox, oy, oz, idx, idy, idz, Infinity)) continue;
      if (this.nc[nd] > 0) {
        for (let i = this.ns[nd], e = i + this.nc[nd]; i < e; i++)
          if (this.rayTri(this.order[i], ox, oy, oz, dx, dy, dz) < Infinity) n++;
      } else { stack.push(this.nl[nd], this.nr[nd]); }
    }
    return n;
  }

  // Point inside a closed surface: majority vote of 3 skewed rays (robust to edge hits).
  contains(x, y, z) {
    if (!this.bounds) return false;
    const b = this.bounds;
    if (x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5]) return false;
    let votes = 0;
    const dirs = [[0.5773, 0.5774, 0.5775], [-0.6123, 0.3536, 0.7071], [0.2673, -0.8018, 0.5345]];
    for (const [dx, dy, dz] of dirs) if (this.countHits(x, y, z, dx, dy, dz) % 2 === 1) votes++;
    return votes >= 2;
  }

  // Is any surface point within r of p?
  near(px, py, pz, r) {
    if (!this.bounds) return false;
    const b = this.nb, V = this.V, F = this.F;
    const stack = [0];
    const r2 = r * r;
    while (stack.length) {
      const nd = stack.pop(), o = nd * 6;
      const dx = Math.max(b[o] - px, 0, px - b[o + 3]);
      const dy = Math.max(b[o + 1] - py, 0, py - b[o + 4]);
      const dz = Math.max(b[o + 2] - pz, 0, pz - b[o + 5]);
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (this.nc[nd] > 0) {
        for (let i = this.ns[nd], e = i + this.nc[nd]; i < e; i++)
          if (pointTriDist2(V, F, this.order[i], px, py, pz) <= r2) return true;
      } else { stack.push(this.nl[nd], this.nr[nd]); }
    }
    return false;
  }
}

// Squared distance from point to triangle (Ericson, Real-Time Collision Detection 5.1.5).
export function pointTriDist2(V, F, t, px, py, pz) {
  const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
  const ax = V[a], ay = V[a + 1], az = V[a + 2];
  const abx = V[b] - ax, aby = V[b + 1] - ay, abz = V[b + 2] - az;
  const acx = V[c] - ax, acy = V[c + 1] - ay, acz = V[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  const set = (u, v) => { qx = ax + abx * u + acx * v; qy = ay + aby * u + acy * v; qz = az + abz * u + acz * v; };
  if (d1 <= 0 && d2 <= 0) set(0, 0);
  else {
    const bpx = px - V[b], bpy = py - V[b + 1], bpz = pz - V[b + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - V[c], cpy = py - V[c + 1], cpz = pz - V[c + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) set(1, 0);
    else if (d6 >= 0 && d5 <= d6) set(0, 1);
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) set(d1 / (d1 - d3), 0);
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) set(0, d2 / (d2 - d6));
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); set(1 - w, w); }
    else { const den = 1 / (va + vb + vc); set(vb * den, vc * den); }
  }
  const ex = px - qx, ey = py - qy, ez = pz - qz;
  return ex * ex + ey * ey + ez * ez;
}

// Does any triangle of bvhA intersect or come within `gap` of any triangle of bvhB?
// Uses a simultaneous BVH traversal plus exact segment-triangle and vertex-triangle checks.
export function bvhTouch(bvhA, bvhB, gap = 0.4) {
  if (!bvhA.bounds || !bvhB.bounds) return false;
  const g2 = gap * gap;
  const ba = bvhA.nb, bb = bvhB.nb, V = bvhA.V, F = bvhA.F;
  const boxOverlap = (na, nb) => {
    const oa = na * 6, ob = nb * 6;
    for (let k = 0; k < 3; k++) if (ba[oa + k] > bb[ob + k + 3] + gap || bb[ob + k] > ba[oa + k + 3] + gap) return false;
    return true;
  };
  const stack = [0, 0];
  while (stack.length) {
    const nb = stack.pop(), na = stack.pop();
    if (!boxOverlap(na, nb)) continue;
    const ca = bvhA.nc[na], cb = bvhB.nc[nb];
    if (ca > 0 && cb > 0) {
      for (let i = bvhA.ns[na], ea = i + ca; i < ea; i++) {
        const ta = bvhA.order[i];
        for (let j = bvhB.ns[nb], eb = j + cb; j < eb; j++) {
          const tb = bvhB.order[j];
          if (trisTouchOrNear(V, F, ta, tb, g2)) return true;
        }
      }
    } else if (ca > 0) {
      stack.push(na, bvhB.nl[nb], na, bvhB.nr[nb]);
    } else if (cb > 0) {
      stack.push(bvhA.nl[na], nb, bvhA.nr[na], nb);
    } else {
      stack.push(bvhA.nl[na], bvhB.nl[nb], bvhA.nl[na], bvhB.nr[nb],
                 bvhA.nr[na], bvhB.nl[nb], bvhA.nr[na], bvhB.nr[nb]);
    }
  }
  return false;
}

function trisTouchOrNear(V, F, ta, tb, g2) {
  // 1) Any vertex of ta within gap of tb, or vice versa
  for (let k = 0; k < 3; k++) {
    const va = F[ta * 3 + k] * 3;
    if (pointTriDist2(V, F, tb, V[va], V[va + 1], V[va + 2]) <= g2) return true;
    const vb = F[tb * 3 + k] * 3;
    if (pointTriDist2(V, F, ta, V[vb], V[vb + 1], V[vb + 2]) <= g2) return true;
  }
  // 2) Any edge of ta pierces tb, or any edge of tb pierces ta
  return edgesPierceTri(V, F, ta, tb) || edgesPierceTri(V, F, tb, ta);
}

function edgesPierceTri(V, F, te, tt) {
  const a = F[tt * 3] * 3, b = F[tt * 3 + 1] * 3, c = F[tt * 3 + 2] * 3;
  const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
  const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
  for (let k = 0; k < 3; k++) {
    const u = F[te * 3 + k] * 3, v = F[te * 3 + ((k + 1) % 3)] * 3;
    const dx = V[v] - V[u], dy = V[v + 1] - V[u + 1], dz = V[v + 2] - V[u + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det;
    const sx = V[u] - V[a], sy = V[u + 1] - V[a + 1], sz = V[u + 2] - V[a + 2];
    const s = (sx * px + sy * py + sz * pz) * inv;
    if (s < 0 || s > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const t = (dx * qx + dy * qy + dz * qz) * inv;
    if (t < 0 || s + t > 1) continue;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (d >= 0 && d <= 1) return true;
  }
  return false;
}
