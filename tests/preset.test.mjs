// Unit tests for print trait analysis and OrcaSlicer preset generation.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzePrintTraits, generateOrcaPreset } from "../js/preset.js";

test("identifies coin/relief morphology correctly", () => {
  const mesh = {};
  const size = [42.0, 42.0, 2.0];
  const results = [
    { id: "thin", status: "warn", severe: false },
    { id: "contact", status: "pass" },
    { id: "overhang", status: "pass" },
  ];
  const est = {
    layerAreas: [1200, 1200, 1200, 1200, 1200, 500, 500],
    zLevels: [0.1, 0.3, 0.5, 0.7, 0.9, 1.2, 1.5],
  };
  const printer = { name: "ad5m" };

  const traits = analyzePrintTraits(mesh, size, results, est, printer);
  assert.equal(traits.isRelief, true, "expected low-profile relief detection");
  assert.equal(traits.recommendedLayerHeight, 0.12, "expected 0.12mm layer height for relief");
  assert.equal(traits.wallGenerator, "arachne", "expected arachne for thin relief");
  assert.equal(traits.needsSupport, false, "expected no support");
  assert.equal(traits.goodContact, true, "expected good contact");
  assert.ok(traits.colorChange, "expected color change detection");
  // No mesh: boundary is midway between the 0.9/1.2 samples (1.05); at 0.12 mm layers the first
  // layer whose middle is above 1.05 is layer 9 (0.20 + 8 x 0.12 = 1.16, middle 1.10).
  assert.equal(traits.colorChange.zMm, 1.05);
  assert.equal(traits.colorChange.layerIdx, 9);
  assert.equal(traits.colorChange.layerTopMm, 1.16);
});

test("reports a second pause where taller face items rise above the rims", () => {
  const est = {
    layerAreas: [1380, 1380, 1380, 1380, 1380, 1380, 570, 570, 570, 570, 570, 270, 270, 270],
    zLevels: [0.1, 0.3, 0.5, 0.7, 0.9, 1.1, 1.3, 1.5, 1.7, 1.9, 1.95, 2.1, 2.3, 2.45],
  };
  const traits = analyzePrintTraits({}, [42, 42, 2.48], [], est, { name: "ad5m" });
  assert.equal(traits.colorChanges.length, 2);
  assert.equal(traits.colorChange, traits.colorChanges[0]);
  // Boundary midway between 1.95 and 2.1 (2.03): first 0.12 mm layer whose middle is above it is
  // layer 17 (0.20 + 16 x 0.12 = 2.12, middle 2.06).
  assert.equal(traits.colorChanges[1].layerIdx, 17);
  assert.equal(traits.colorChanges[1].layerTopMm, 2.12);
});

test("generates valid OrcaSlicer preset JSON for AD5M and P1S", () => {
  const traits = {
    isRelief: true,
    hasThinFeatures: true,
    recommendedLayerHeight: 0.12,
    wallGenerator: "arachne",
    needsSupport: false,
    goodContact: true,
    colorChange: { zMm: 1.2, layerIdx: 6, prevAreaMm2: 1200, newAreaMm2: 500, dropPct: 58 },
  };

  const ad5mPreset = generateOrcaPreset("Coin Profile AD5M", "ad5m", traits);
  assert.equal(ad5mPreset.type, "process");
  assert.equal(ad5mPreset.name, "Coin Profile AD5M");
  assert.equal(ad5mPreset.layer_height, "0.12");
  assert.equal(ad5mPreset.wall_generator, "arachne");
  assert.equal(ad5mPreset.enable_support, "0");
  assert.ok(ad5mPreset.compatible_printers.some((p) => p.includes("Adventurer 5M")));

  const p1sPreset = generateOrcaPreset("Coin Profile P1S", "p1s", traits);
  assert.equal(p1sPreset.type, "process");
  assert.equal(p1sPreset.layer_height, "0.12");
  assert.ok(p1sPreset.compatible_printers.some((p) => p.includes("P1S")));
});

test("relief detail warning surfaces as reliefTooFine", () => {
  const results = [{ id: "relief-detail", status: "warn" }];
  assert.equal(analyzePrintTraits({}, [42, 42, 2], results, null, {}).reliefTooFine, true);
  assert.equal(analyzePrintTraits({}, [42, 42, 2], [], null, {}).reliefTooFine, false);
});

test("two-color project 3MF carries the pause and per-object layer height", async () => {
  const { buildPauseProject } = await import("../js/threemf.js");
  // One tetrahedron as STL triangle soup.
  const P = [[0, 0, 5], [10, 0, 5], [0, 10, 5], [0, 0, 8]];
  const tri = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];
  const pos = new Float32Array(tri.flatMap((t) => t.flatMap((i) => P[i])));
  const zip = buildPauseProject([{ name: "a", pos }, { name: "b<&>", pos }], { pauseZ: [2.12], layerHeight: 0.12, bed: [220, 220] });
  // Walk the stored-zip local headers.
  const dv = new DataView(zip.buffer), dec = new TextDecoder(), files = {};
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const size = dv.getUint32(p + 18, true), nlen = dv.getUint16(p + 26, true);
    const name = dec.decode(zip.subarray(p + 30, p + 30 + nlen));
    files[name] = dec.decode(zip.subarray(p + 30 + nlen, p + 30 + nlen + size));
    p += 30 + nlen + size;
  }
  assert.deepEqual(Object.keys(files).sort(), ["3D/3dmodel.model", "Metadata/custom_gcode_per_layer.xml", "Metadata/model_settings.config", "[Content_Types].xml", "_rels/.rels"]);
  assert.match(files["Metadata/custom_gcode_per_layer.xml"], /<layer top_z="2.12" type="1" /);
  assert.equal(files["Metadata/model_settings.config"].match(/key="layer_height" value="0.12"/g).length, 2);
  assert.match(files["3D/3dmodel.model"], /name="b&lt;&amp;&gt;"/);
  // Parts rest on the bed (z offset -5) side by side, not overlapping.
  const tf = [...files["3D/3dmodel.model"].matchAll(/transform="1 0 0 0 1 0 0 0 1 ([-\d.]+) ([-\d.]+) ([-\d.]+)"/g)].map((m) => m.slice(1).map(Number));
  assert.equal(tf.length, 2);
  assert.ok(tf.every((t) => t[2] === -5));
  assert.ok(tf[1][0] - tf[0][0] >= 10);
});
