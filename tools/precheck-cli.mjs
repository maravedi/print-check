#!/usr/bin/env node
// Run the same checks (and time estimate) the web page runs, from the command line.
// Usage: node tools/precheck-cli.mjs [--printer p1s|ad5m] [--preset orca] [--json]
//        [--3mf plate.3mf [--pause-z 2.12[,…]]] file.stl [...]
// --3mf puts every input file on one OrcaSlicer plate with the colour-change pause(s) already placed
// (default: the topmost pause detected), so a single-extruder two-colour print needs no manual step.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseStl } from "../js/stl.js";
import { runChecks } from "../js/checks.js";
import { PRINTERS } from "../js/printers.js";
import { analyzePrintTraits, generateOrcaPreset } from "../js/preset.js";
import { calculateCoins } from "../js/format.js";
import { buildPauseProject } from "../js/threemf.js";

const args = process.argv.slice(2);
let printer = "p1s", json = false, noSlice = false, exportPreset = null, out3mf = null, pauseZ = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--printer") printer = args[++i];
  else if (args[i] === "--preset") exportPreset = args[++i] || "orca";
  else if (args[i] === "--json") json = true;
  else if (args[i] === "--3mf") out3mf = args[++i];
  else if (args[i] === "--pause-z") pauseZ = args[++i].split(",").map(Number);
  else if (args[i] === "--no-slice") noSlice = true;
  else files.push(args[i]);
}
const P = PRINTERS[printer];
let slicer = null;
if (!noSlice) { try { slicer = await import("../js/slicer.js"); } catch { slicer = null; } }
const out = [];
const plate = [];
for (const f of files) {
  const t0 = performance.now();
  const pos = parseStl(readFileSync(f));
  const r = runChecks(pos, P);
  const t1 = performance.now();
  let est = null;
  if (slicer && r.topologyOk) est = slicer.estimate(r.mesh, P);
  const t2 = performance.now();

  const traits = analyzePrintTraits(r.mesh, r.size, r.results, est, P);
  plate.push({ name: basename(f, ".stl"), pos, traits });
  const orcaPreset = generateOrcaPreset(basename(f, ".stl") + " Preset", printer, traits);
  const coinsInfo = est ? calculateCoins(est.seconds / 60, 30) : null;

  const rec = {
    file: basename(f),
    verdict: r.verdict,
    checksMs: Math.round(t1 - t0),
    sliceMs: Math.round(t2 - t1),
    results: r.results.map(({ id, status, title, message }) => ({ id, status, title, message })),
    traits,
    coins: coinsInfo?.coins,
    estimate: est && { ...est, layerAreas: undefined, zLevels: undefined, layers: undefined },
    preset: exportPreset ? orcaPreset : undefined,
  };
  out.push(rec);

  if (!json) {
    console.log(`\n== ${rec.file}  [${rec.verdict.toUpperCase()}]  checks ${rec.checksMs} ms, slice ${rec.sliceMs} ms`);
    for (const x of rec.results) if (x.status !== "info") console.log(`  ${x.status.padEnd(4)} ${x.title} — ${x.message.slice(0, 140)}`);
    if (est) console.log(`  time ${(est.seconds / 60).toFixed(1)} min (Cost: 🪙 ${coinsInfo.label})`, JSON.stringify(est.breakdown));

    // Print recommendations
    console.log("  [Slicer Recommendations]");
    console.log(`    Layer Height:   ${traits.recommendedLayerHeight} mm ${traits.isRelief ? "(fine relief detected)" : "(standard)"}`);
    console.log(`    Wall Generator: ${traits.wallGenerator} ${traits.wallGenerator === "arachne" ? "(preserves text/ridges down to one nozzle line)" : ""}`);
    if (traits.reliefTooFine) console.log("    Raised text:    finer than the nozzle; no slicer setting fixes this, enlarge or embolden it");
    console.log(`    Supports:       ${traits.needsSupport ? "Enabled" : "Disabled (flat bed contact, 0 overhangs)"}`);
    (traits.colorChanges ?? []).forEach((c, i) => {
      console.log(`    Layer Pause:    before layer ${c.layerIdx} (Z = ${c.layerTopMm} mm @ ${traits.recommendedLayerHeight} mm layers; ${i ? "upper tier" : "relief"} starts at ${c.zMm} mm) - ${c.dropPct}% area transition for 2-color print`);
    });

    if (exportPreset === "orca") {
      const outPresetFile = basename(f, ".stl") + ".orca.json";
      writeFileSync(outPresetFile, JSON.stringify(orcaPreset, null, 2));
      console.log(`    Exported Preset: ${outPresetFile}`);
    }
  }
}
if (out3mf) {
  const lead = plate.find((p) => p.traits.colorChanges?.length);
  const pauses = pauseZ ?? (lead ? [lead.traits.colorChanges.at(-1).layerTopMm] : []);
  const layerHeight = (lead ?? plate[0]).traits.recommendedLayerHeight;
  // Orca's GUI keeps the pause only when the .3mf carries project settings; we have an AD5M template only.
  const projectSettings = printer === "ad5m" ? JSON.parse(readFileSync(new URL("../js/orca-project-ad5m.json", import.meta.url))) : null;
  if (!projectSettings) console.error(`No ${printer} project template: OrcaSlicer's GUI will import this .3mf as geometry only and drop the pause.`);
  writeFileSync(out3mf, buildPauseProject(plate, { pauseZ: pauses, layerHeight, bed: P.bed, projectSettings }));
  const msg = `Wrote ${out3mf}: ${plate.length} part(s), ${layerHeight} mm layers, ` +
    (pauses.length ? `pause before the layer at Z ${pauses.join(", ")} mm` : "no pause (none detected; pass --pause-z)");
  if (json) console.error(msg); else console.log("\n" + msg);
}
if (json) console.log(JSON.stringify(out, null, 1));
