// Printability checks for a Tinkercad STL, ported from scripts/kiln/print_check.py and
// tuned for students: every result carries a plain-language reason and a Tinkercad fix.

import { buildMesh, topology, components, faceNormalArea } from "./mesh.js";
import { BVH, bvhTouch } from "./bvh.js";

export const LIMITS = {
  minWall: 0.8,        // mm: two extrusions; thinner walls print weak or patchy
  criticalWall: 0.4,   // mm: one extrusion; thinner usually doesn't print at all
  thinShareWarn: 0.02, // share of exposed surface
  thinShareFail: 0.02,
  bedTol: 0.2,         // one layer
  fuseGap: 0.4,        // one extrusion width: closer parts fuse together
  restGap: 0.15,       // a part's underside must sit this close to what is below it (OrcaSlicer calls a bigger gap floating)
  restMm2: 0.05,       // ...over at least this much area (any real overlap with the layer below)
  overhangDeg: 45,
  overhangWarn: 0.05,
  sliverMm3: 1e-3,
  tinyModelMm: 3,
  smallContactMm2: 25,
  maxSamples: 40000,
};

const FIX = {
  group: "In Tinkercad, select everything (Ctrl+A / Cmd+A) and click Group, then export again.",
};

export function runChecks(pos, printer, onProgress = () => {}) {
  const results = [];
  const add = (r) => results.push({ highlight: null, fix: "", ...r });

  onProgress("Reading the shape", 0.05);
  const mesh = buildMesh(pos);
  const { V, F, nT } = mesh;
  if (nT === 0) {
    add({ id: "empty", status: "fail", title: "The file has no shape in it",
      message: "No triangles were found. The export may have been empty.",
      fix: "Make sure your design is on the workplane, select it, then click Export and choose .STL." });
    return { results, mesh, size: [0, 0, 0], verdict: "fail" };
  }

  // ---- Place on the bed: drop the lowest point of real parts (volume >= sliverMm3) to Z=0 and centre.
  const comps0 = components(mesh, topology(mesh));
  const realComps0 = comps0.filter((c) => Math.abs(c.volume) >= LIMITS.sliverMm3);
  const bboxComps = realComps0.length ? realComps0 : comps0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const c of bboxComps) for (let k = 0; k < 3; k++) {
    if (c.min[k] < min[k]) min[k] = c.min[k];
    if (c.max[k] > max[k]) max[k] = c.max[k];
  }
  const shift = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) V[i + k] += shift[k];
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const moved = Math.abs(shift[2]) > 0.01;
  add({ id: "placed", status: "info", title: "Placed on the print bed",
    message: (moved ? `Your model was ${fmt(Math.abs(min[2]))} mm ${min[2] > 0 ? "above" : "below"} the workplane, so it was moved down onto the bed. ` : "")
      + `It was centred on the bed. Its rotation was not changed. Size: ${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm.` });

  // ---- Size
  const [bx, by, bz] = printer.bed;
  const fitsXY = (size[0] <= bx && size[1] <= by) || (size[1] <= bx && size[0] <= by);
  if (!fitsXY || size[2] > bz) {
    const k = Math.min(bx / Math.max(size[0], size[1]), by / Math.min(size[0], size[1]), bz / size[2]);
    add({ id: "fit", status: "fail", title: "Too big for the printer",
      message: `Your model is ${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm. The ${printer.name} can print up to ${bx} × ${by} × ${bz} mm.`,
      fix: `In Tinkercad, select everything and scale it down to about ${Math.floor(k * 100)}% (hold Shift while dragging a corner to keep the proportions).` });
  } else {
    add({ id: "fit", status: "pass", title: "Fits on the printer",
      message: `${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm fits the ${bx} × ${by} × ${bz} mm build area.` });
  }
  if (Math.max(...size) < LIMITS.tinyModelMm) {
    add({ id: "tiny", status: "fail", title: "Model is extremely small",
      message: `The whole model is only ${fmt(Math.max(...size))} mm across. That is smaller than a grain of rice and won't print.`,
      fix: "In Tinkercad, check the size with the ruler. Make sure the export was in millimetres, then scale the model up." });
  }

  // ---- Topology
  onProgress("Checking the surface for holes", 0.15);
  const topo = topology(mesh);
  const comps = components(mesh, topo);
  const segs = (edges) => edges.slice(0, 2000).map((e) => [topo.edgeA[e], topo.edgeB[e]].flatMap((v) => [V[v * 3], V[v * 3 + 1], V[v * 3 + 2]]));

  if (topo.open.length) {
    add({ id: "open", status: "fail", title: "The surface has holes",
      message: `${topo.open.length} edge${s(topo.open.length)} of the surface ${topo.open.length === 1 ? "is" : "are"} not connected to anything. The slicer can't tell inside from outside, so parts of the print may be missing or filled wrongly.`,
      fix: `${FIX.group} If a shape was imported from somewhere else, try deleting and re-adding it.`,
      highlight: { segments: segs(topo.open) } });
  }
  if (topo.nonManifoldBad.length) {
    add({ id: "nonmanifold", status: "fail", title: "Surfaces are joined wrongly",
      message: `${topo.nonManifoldBad.length} edge${s(topo.nonManifoldBad.length)} ${topo.nonManifoldBad.length === 1 ? "is" : "are"} shared by more than two faces in a way that doesn't close up, like extra pages glued into a book's spine.`,
      fix: `${FIX.group} If two shapes only touch on an edge or a corner, overlap them a little (about 0.5 mm) instead.`,
      highlight: { segments: segs(topo.nonManifoldBad) } });
  }
  const kissing = topo.nonManifold.length - topo.nonManifoldBad.length;
  if (kissing) {
    add({ id: "kissing", status: "info", title: "Shapes touch exactly along an edge",
      message: `${kissing} place${s(kissing)} where two shapes meet only along an edge. The slicer handles this, but the joint may be weak.`,
      fix: "If that joint needs to be strong, overlap the shapes by about 0.5 mm.", highlight: { segments: segs(topo.nonManifold), color: "orange" } });
  }
  if (topo.flipped.length) {
    add({ id: "flipped", status: "fail", title: "Some faces point the wrong way",
      message: `${topo.flipped.length} edge${s(topo.flipped.length)} join faces that point in opposite directions, so part of the surface is inside out.`,
      fix: `${FIX.group}`, highlight: { segments: segs(topo.flipped) } });
  }
  const cl = mesh.cleaned;
  if (cl && cl.degenerate + cl.duplicate + cl.backToBack) {
    add({ id: "cleaned", status: "info", title: "Tidied up leftover triangles",
      message: `Removed ${cl.degenerate + cl.duplicate + 2 * cl.backToBack} empty or doubled-up triangles that Tinkercad sometimes leaves behind. The slicer ignores them too.` });
  }
  const bad = topo.open.length + topo.nonManifoldBad.length + topo.flipped.length;
  if (!bad) add({ id: "watertight", status: "pass", title: "Surface is watertight",
    message: `All ${nT.toLocaleString()} triangles join up into closed shapes with no holes.` });

  // ---- Parts: slivers, inverted, floating
  onProgress("Checking that every part touches the bed", 0.3);
  const solid = comps.filter((c) => Math.abs(c.volume) >= LIMITS.sliverMm3);
  const slivers = comps.length - solid.length;
  for (const c of solid) c.bvh = new BVH(V, F, c.faces);
  const inside = (p, q) => { // a vertex of p lies inside closed part q
    if (!q.closed || !boxOverlap(p, q, 0)) return false;
    const fs = p.faces, step = Math.max(1, Math.floor(fs.length / 40));
    for (let i = 0; i < fs.length; i += step) {
      const v = F[fs[i] * 3] * 3;
      if (q.bvh.contains(V[v], V[v + 1], V[v + 2])) return true;
    }
    return false;
  };
  const near = (p, q) => {
    if (!boxOverlap(p, q, LIMITS.fuseGap)) return false;
    return bvhTouch(p.bvh, q.bvh, LIMITS.fuseGap);
  };
  // Does the lowest part of c's underside sit on h? The slicer only prints a region that
  // overlaps something in the layer below, so sideways contact or a gap over one layer
  // (0.15 mm) does not count. Checked against OrcaSlicer's own floating-region warning.
  const restCache = new Map();
  const rests = (c, h) => {
    const key = c.id * 100000 + h.id;
    if (restCache.has(key)) return restCache.get(key);
    let ok = false;
    if (h.max[2] >= c.min[2] - LIMITS.restGap && boxOverlap(c, h, LIMITS.restGap)) {
      c.low ??= lowUndersidePoints(V, F, c);
      const pts = c.low;
      let area = 0;
      for (let i = 0; i < pts.length && !ok; i += 4) {
        const x = pts[i], y = pts[i + 1], z = pts[i + 2];
        if (h.bvh.raycast(x, y, z + 1e-3, 1e-7, 1e-7, -1) <= LIMITS.restGap || (h.closed && h.bvh.contains(x, y, z))) {
          area += pts[i + 3];
          ok = area >= LIMITS.restMm2;
        }
      }
    }
    restCache.set(key, ok);
    return ok;
  };
  // Inverted: negative volume and not a cavity inside another part.
  const inverted = solid.filter((c) => c.closed && c.volume < 0 && !solid.some((q) => q !== c && q.volume > 0 && inside(c, q)));
  if (inverted.length) {
    add({ id: "inverted", status: "fail", title: "A part is inside out",
      message: `${inverted.length} part${s(inverted.length)} ${inverted.length === 1 ? "has" : "have"} the surface facing inwards, so the slicer treats ${inverted.length === 1 ? "it" : "them"} as empty space.`,
      fix: FIX.group, highlight: { faces: inverted.flatMap((c) => Array.from(c.faces)) } });
  }
  const held = new Set(solid.filter((c) => c.min[2] <= LIMITS.bedTol));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of solid) {
      if (held.has(c)) continue;
      for (const h of held) {
        if (inside(c, h) || inside(h, c) || rests(c, h)) { held.add(c); grew = true; break; }
      }
    }
  }
  const floating = solid.filter((c) => !held.has(c));
  if (floating.length) {
    const lowest = Math.min(...floating.map((c) => c.min[2]));
    // Where each floating piece's underside is closest to something below it, for the gap ruler.
    const markers = floating.map((c) => gapMarker(V, F, c, solid));
    const measured = markers.filter((m) => m.kind === "part").map((m) => m.gap);
    const lo = Math.min(...measured), hi = Math.max(...measured);
    const gapNote = !measured.length ? "" : measured.length === 1
      ? ` The gap under it is about ${fmtGap(lo)} mm.`
      : ` The gaps under them range from ${fmtGap(lo)} to ${fmtGap(hi)} mm.`;
    const lowerBy = floating.length === 1 && measured.length === 1 ? ` (about ${fmtGap(lo + 0.2)} mm)` : "";
    const fixText = measured.length
      ? `Lower ${floating.length === 1 ? "it" : "each piece"} by its gap plus about 0.2 mm${lowerBy} so it overlaps the part below it. In Tinkercad, set the Snap Grid at the bottom right of the workplane to 0.1 mm to move that little. Then group everything.`
      : "Move the piece down so it overlaps the part below it (touching the side is not enough), or drop it onto the workplane (select it and press D). Then group everything.";
    add({ id: "floating", status: "fail", title: `${floating.length} part${s(floating.length)} floating in the air`,
      message: `${floating.length === 1 ? "One piece isn't" : `${floating.length} pieces aren't`} resting on the bed or on another part (shown in red). The lowest one starts ${fmt(lowest)} mm up. The printer would have to print it in mid-air, and it would turn into spaghetti or fall off.${gapNote}`,
      fix: fixText,
      highlight: { faces: floating.flatMap((c) => Array.from(c.faces)),
        markers: spreadOut(markers) } });
  } else if (solid.length) {
    add({ id: "floating", status: "pass", title: "Every part is connected",
      message: solid.length === 1 ? "The model is one solid piece sitting on the bed." :
        `All ${solid.length} shapes rest on the bed or on another shape.` });
  }
  if (slivers) add({ id: "slivers", status: "info", title: "Tiny leftover pieces ignored",
    message: `${slivers} piece${s(slivers)} with almost no volume ${slivers === 1 ? "was" : "were"} ignored. ${slivers === 1 ? "It" : "They"} won't print.` });
  const islandParts = solid.filter((c) => c.min[2] <= LIMITS.bedTol && !solid.some((q) => q !== c && (inside(c, q) || near(c, q)) && q.min[2] <= LIMITS.bedTol));
  const islands = islandParts.length;
  if (islands > 1) add({ id: "separate", status: "warn", title: `${islands} separate objects on the bed`,
    message: `Your file has ${islands} objects that don't touch each other. They will all print together and come off the bed as separate pieces. Each one is shown in its own colour.`,
    fix: "If they should be one object, overlap them and group them. If they are meant to be separate pieces, this is fine.",
    highlight: { faces: islandParts.flatMap((c) => Array.from(c.faces)), groups: islandParts.map((c) => Array.from(c.faces)), color: "orange" } });

  // ---- Surface sampling: buried faces, wall thickness, overhangs, bed contact.
  onProgress("Measuring wall thickness", 0.45);
  const samples = sampleFaces(V, F, nT, LIMITS.maxSamples);
  const compOf = topo.compOf;
  const solidIdx = new Map(solid.map((c) => [c.id, c]));
  const n = [0, 0, 0];
  let exposed = 0, thinCrit = 0, thinWarn = 0, overhang = 0, downArea = 0, contact = 0;
  const thinFaces = [], critFaces = [], overFaces = [];
  const minThin = [];
  const cosOver = Math.sin((LIMITS.overhangDeg + 0.5) * Math.PI / 180);
  let done = 0;
  for (const { t, w } of samples) {
    if ((++done & 2047) === 0) onProgress("Measuring wall thickness", 0.45 + 0.4 * done / samples.length);
    const c = solidIdx.get(compOf[t]);
    if (!c) continue;
    faceNormalArea(V, F, t, n);
    const sign = c.volume < 0 ? -1 : 1;
    const nx = n[0] * sign, ny = n[1] * sign, nz = n[2] * sign;
    const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, d = F[t * 3 + 2] * 3;
    const cx = (V[a] + V[b] + V[d]) / 3, cy = (V[a + 1] + V[b + 1] + V[d + 1]) / 3, cz = (V[a + 2] + V[b + 2] + V[d + 2]) / 3;
    const zmax = Math.max(V[a + 2], V[b + 2], V[d + 2]);
    if (zmax < 0.05 && nz < -0.99) { contact += w; exposed += w; continue; }
    if (buried(solid, c, cx + nx * 0.02, cy + ny * 0.02, cz + nz * 0.02)) continue;
    exposed += w;
    if (nz < 0) downArea += w;
    if (nz < -cosOver) { overhang += w; if (overFaces.length < 20000) overFaces.push(t); }
    if (!c.closed) continue;
    const dist = c.bvh.raycast(cx - nx * 1e-4, cy - ny * 1e-4, cz - nz * 1e-4, -nx, -ny, -nz, t, LIMITS.minWall + 0.01, sign);
    if (dist <= LIMITS.minWall) {
      // A wall that continues into another overlapping shape is not thin.
      const bx2 = cx - nx * (dist + 0.05), by2 = cy - ny * (dist + 0.05), bz2 = cz - nz * (dist + 0.05);
      if (buried(solid, c, bx2, by2, bz2)) continue;
      thinWarn += w;
      if (thinFaces.length < 20000) thinFaces.push(t);
      if (dist <= LIMITS.criticalWall) { thinCrit += w; if (critFaces.length < 20000) critFaces.push(t); }
      if (minThin.length < 2000) minThin.push(dist);
    }
  }
  if (exposed > 0) {
    const crit = thinCrit / exposed, warn = thinWarn / exposed;
    const thinnest = minThin.length ? Math.min(...minThin) : null;
    if (warn > LIMITS.thinShareWarn) {
      const msg = crit > 0.01
        ? `${pct(warn)} of the surface belongs to walls thinner than ${LIMITS.minWall} mm (${pct(crit)} is thinner than one nozzle width, ${LIMITS.criticalWall} mm). Thin text, fine grooves, or thin spikes may come out faint, rough, or missing.`
        : `${pct(warn)} of the surface belongs to walls thinner than ${LIMITS.minWall} mm (orange). They will print, but may be weak or rough.`;
      add({ id: "thin", status: "warn", title: "Some walls or details are very thin",
        message: msg,
        fix: `Make the orange areas at least ${LIMITS.minWall} mm thick (1 to 2 mm is safer) if they need to show up clearly or be strong.`,
        highlight: { faces: thinFaces, color: "orange" } });
    } else {
      add({ id: "thin", status: "pass", title: "Walls are thick enough",
        message: `Almost every wall is at least ${LIMITS.minWall} mm thick.` });
    }
    const over = overhang / exposed;
    if (over > LIMITS.overhangWarn) {
      add({ id: "overhang", status: "warn", title: "Needs support material",
        message: `${pct(over)} of the surface hangs over empty space at a steep angle (purple). The printer will add removable supports underneath. Those are counted in the print time and leave rough marks.`,
        fix: "Optional: flatten the bottom or rotate the model so less of it hangs out. Angles of 45° or less print without supports.",
        highlight: { faces: overFaces, color: "purple" } });
    } else {
      add({ id: "overhang", status: "pass", title: "Few or no overhangs",
        message: "Almost nothing hangs out steeply, so very little support material is needed." });
    }
    if (contact < LIMITS.smallContactMm2) {
      add({ id: "contact", status: "warn", title: "Very small contact with the bed",
        message: `Only about ${fmt(contact)} mm² of the model sits flat on the bed. It could wobble or come loose while printing.`,
        fix: "Give the model a flat bottom, or add a thin flat base (a box 1 to 2 mm thick) underneath and group it." });
    }
  }

  onProgress("Checks done", 0.9);
  const verdict = results.some((r) => r.status === "fail") ? "fail" : "pass";
  return { results, mesh, topo, comps: solid, size, verdict, topologyOk: bad === 0 && !inverted.length };
}

// Straight-down measurement from a floating piece to whatever is beneath it: the point on its
// underside with the smallest gap, or its lowest point measured to the bed when nothing is below.
function gapMarker(V, F, c, solid) {
  c.low ??= lowUndersidePoints(V, F, c);
  const pts = c.low, step = Math.max(4, Math.floor(pts.length / 4 / 200) * 4);
  const others = solid.filter((q) => q !== c && q.min[0] <= c.max[0] && q.max[0] >= c.min[0] && q.min[1] <= c.max[1] && q.max[1] >= c.min[1] && q.min[2] < c.max[2]);
  let best = null, lowest = null;
  for (let i = 0; i < pts.length; i += step) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    if (!lowest || z < lowest.z) lowest = { x, y, z };
    for (const q of others) {
      const d = q.bvh.raycast(x, y, z + 1e-3, 1e-7, 1e-7, -1) - 1e-3;
      if (d >= 0 && Number.isFinite(d) && (!best || d < best.gap)) best = { kind: "part", x, y, z0: z, z1: z - d, gap: d };
    }
  }
  if (best) return best;
  const p = lowest ?? { x: (c.min[0] + c.max[0]) / 2, y: (c.min[1] + c.max[1]) / 2, z: c.min[2] };
  return { kind: "bed", x: p.x, y: p.y, z0: p.z, z1: 0, gap: p.z };
}

// Up to 4 gap markers, smallest gaps first, kept at least 12 mm apart so their labels don't pile up.
function spreadOut(markers) {
  const picked = [];
  for (const m of [...markers].sort((a, b) => a.gap - b.gap)) {
    if (picked.every((p) => Math.hypot(p.x - m.x, p.y - m.y) >= 12)) picked.push(m);
    if (picked.length === 4) break;
  }
  return picked;
}

// 0.25 -> "0.25", 3.04 -> "3.0": small gaps need the extra digit.
const fmtGap = (x) => (x < 1 ? x.toFixed(2) : x.toFixed(1));

// Area-weighted points on the downward-facing surface within 0.4 mm of the part's lowest point.
// Returns x,y,z,weight repeating, capped near 1500 points.
function lowUndersidePoints(V, F, part) {
  const zcut = part.min[2] + 0.4, n3 = [0, 0, 0];
  const low = [];
  let total = 0;
  for (const t of part.faces) {
    const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
    if (Math.min(V[a + 2], V[b + 2], V[c + 2]) > zcut) continue;
    const area = faceNormalArea(V, F, t, n3);
    if (n3[2] > -0.5) continue;
    low.push(t, area);
    total += area;
  }
  const spacing = Math.max(0.2, Math.sqrt(total / 1500));
  const out = [];
  for (let k = 0; k < low.length; k += 2) {
    const t = low[k], area = low[k + 1];
    const a = F[t * 3] * 3, b = F[t * 3 + 1] * 3, c = F[t * 3 + 2] * 3;
    const n = Math.max(1, Math.ceil(Math.sqrt(area) / spacing)), w = area / (n * n);
    const at = (u, v) => {
      const z = V[a + 2] + (V[b + 2] - V[a + 2]) * u + (V[c + 2] - V[a + 2]) * v;
      if (z <= zcut) out.push(
        V[a] + (V[b] - V[a]) * u + (V[c] - V[a]) * v,
        V[a + 1] + (V[b + 1] - V[a + 1]) * u + (V[c + 1] - V[a + 1]) * v,
        z, w);
    };
    for (let i = 0; i < n; i++) for (let j = 0; i + j < n; j++) {
      at((i + 1 / 3) / n, (j + 1 / 3) / n);
      if (i + j < n - 1) at((i + 2 / 3) / n, (j + 2 / 3) / n);
    }
  }
  return out;
}

function buried(solid, self, x, y, z) {
  for (const q of solid) {
    if (q === self || !q.closed || q.volume <= 0) continue;
    if (x < q.min[0] || y < q.min[1] || z < q.min[2] || x > q.max[0] || y > q.max[1] || z > q.max[2]) continue;
    if (q.bvh.contains(x, y, z)) return true;
  }
  return false;
}

function boxOverlap(p, q, pad) {
  for (let k = 0; k < 3; k++) if (p.min[k] > q.max[k] + pad || q.min[k] > p.max[k] + pad) return false;
  return true;
}

// All faces (weight = area) when few; otherwise area-weighted systematic sample.
function sampleFaces(V, F, nT, max) {
  const n = [0, 0, 0];
  const area = new Float64Array(nT);
  let total = 0;
  for (let t = 0; t < nT; t++) { area[t] = faceNormalArea(V, F, t, n); total += area[t]; }
  if (nT <= max) return Array.from({ length: nT }, (_, t) => ({ t, w: area[t] }));
  const out = [], step = total / max;
  let acc = 0, next = step / 2;
  for (let t = 0; t < nT; t++) {
    acc += area[t];
    while (acc >= next) { out.push({ t, w: step }); next += step; }
  }
  return out;
}

const fmt = (x) => x == null ? "?" : (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(1));
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const s = (n) => (n === 1 ? "" : "s");
