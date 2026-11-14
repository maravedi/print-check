#!/usr/bin/env node
// Compare and calibrate js/slicer.js against OrcaSlicer ground truth (tools/calibration-*.json).
import { readFileSync } from "node:fs";
import { parseStl } from "../js/stl.js";
import { buildMesh } from "../js/mesh.js";
import { estimate } from "../js/slicer.js";
import { PRINTERS } from "../js/printers.js";

const meshCache = new Map();
function getMesh(file) {
  if (!meshCache.has(file)) {
    const pos = parseStl(readFileSync(`../${file}`));
    const m = buildMesh(pos);
    // Shift min Z to 0 like runChecks
    let minZ = Infinity;
    for (let i = 2; i < m.V.length; i += 3) if (m.V[i] < minZ) minZ = m.V[i];
    for (let i = 2; i < m.V.length; i += 3) m.V[i] -= minZ;
    meshCache.set(file, m);
  }
  return meshCache.get(file);
}

// Non-negative multiplicative update to minimize relative squared error sum(((X w - y)/y)^2)
function fitNNLS(rows, targets) {
  const k = rows[0].length;
  const w = new Array(k).fill(1.0);
  for (let iter = 0; iter < 15000; iter++) {
    const grad = new Array(k).fill(0);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], y = targets[i];
      let pred = 0;
      for (let j = 0; j < k; j++) pred += r[j] * w[j];
      const err = (pred - y) / (y * y);
      for (let j = 0; j < k; j++) grad[j] += err * r[j];
    }
    const lr = 0.15 / rows.length;
    for (let j = 0; j < k; j++) {
      const g = grad[j] * w[j];
      w[j] = Math.max(0.01, w[j] * Math.exp(-Math.max(-0.05, Math.min(0.05, lr * g))));
    }
  }
  return w;
}

const allCal = JSON.parse(readFileSync("tools/calibration-all.json", "utf8")).filter((r) => r.model_s > 0);
for (const pid of ["p1s", "ad5m"]) {
  const cal = allCal.filter((r) => r.printer === pid);
  const P = { ...PRINTERS[pid], fit: null };
  const rows = [], targets = [], meta = [];
  for (const r of cal) {
    const m = getMesh(r.file);
    const est = estimate(m, P, r.scale);
    const f = est.features;
    rows.push([f.wallSec, f.infillSec, f.supportSec, f.cornerSec, f.travelSec, f.coolSec, f.nLayers]);
    targets.push(r.model_s);
    meta.push({ file: r.file, scale: r.scale, orcaMin: r.model_s / 60, rawMin: est.minutes });
  }
  const w = fitNNLS(rows, targets);
  const fit = {
    wall: +w[0].toFixed(4),
    infill: +w[1].toFixed(4),
    support: +w[2].toFixed(4),
    corner: +w[3].toFixed(4),
    travel: +w[4].toFixed(4),
    cool: +w[5].toFixed(4),
    layerOverhead: +w[6].toFixed(4),
  };
  console.log(`\n=== ${pid.toUpperCase()} fit ===`, JSON.stringify(fit));
  let absPctSum = 0, within10 = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const predMin = (
      r[0] * fit.wall + r[1] * fit.infill + r[2] * fit.support +
      r[3] * fit.corner + r[4] * fit.travel + r[5] * fit.cool + r[6] * fit.layerOverhead
    ) / 60;
    const orcaMin = targets[i] / 60;
    const relPct = ((predMin - orcaMin) / orcaMin) * 100;
    absPctSum += Math.abs(relPct);
    if (Math.abs(relPct) <= 12) within10++;
    console.log(`  x${meta[i].scale.toFixed(1)}  orca ${orcaMin.toFixed(1).padStart(6)}m  est ${predMin.toFixed(1).padStart(6)}m  (${relPct >= 0 ? "+" : ""}${relPct.toFixed(1)}%)  ${meta[i].file}`);
  }
  console.log(`  MAPE: ${(absPctSum / rows.length).toFixed(1)}%  (${within10}/${rows.length} within ±12%)`);
}
