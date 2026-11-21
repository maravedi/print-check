// Node test suite verifying every check failure mode and slicer calibration.
// Run with: node --test tests/precheck.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseStl, writeBinaryStl, StlError } from "../js/stl.js";
import { lowerFloating, fixAccepted, badIds } from "../js/fix.js";
import { runChecks } from "../js/checks.js";
import { estimate } from "../js/slicer.js";
import { PRINTERS } from "../js/printers.js";
import {
  boxTris,
  encodeBinaryStl,
  makePassingExampleStl,
  makeFloatingExampleStl,
  makeTooSlowExampleStl,
} from "../js/samples.js";

// Real student models are private: their file names (which contain student names) live in
// tests/private-fixtures.json, which is git-ignored. Without it those tests are skipped.
const fixtures = existsSync(new URL("./private-fixtures.json", import.meta.url))
  ? JSON.parse(readFileSync(new URL("./private-fixtures.json", import.meta.url), "utf8")) : {};
const studentFile = (alias) => new URL(`../../${fixtures[alias] ?? "missing-fixture.stl"}`, import.meta.url);

test("rejects empty or invalid STL buffers", () => {
  assert.throws(() => parseStl(new ArrayBuffer(4)), StlError);
  assert.throws(() => parseStl(new TextEncoder().encode("not an stl file at all").buffer), StlError);
});

test("passing sample trophy passes all mesh checks and fits under 30 min on both printers", () => {
  const buf = makePassingExampleStl();
  const pos = parseStl(buf);
  for (const pid of ["p1s", "ad5m"]) {
    const printer = PRINTERS[pid];
    const r = runChecks(pos, printer);
    assert.equal(r.verdict, "pass", `expected pass on ${pid}`);
    const s = estimate(r.mesh, printer);
    assert.ok(s.minutes > 1 && s.minutes <= 30, `expected 1..30 min on ${pid}, got ${s.minutes}`);
    assert.equal(s.emptyLayers.length, 0);
  }
});

test("floating sample fails the floating check and highlights the upper box", () => {
  const buf = makeFloatingExampleStl();
  const r = runChecks(parseStl(buf), PRINTERS.p1s);
  assert.equal(r.verdict, "fail");
  const fl = r.results.find((x) => x.id === "floating" && x.status === "fail");
  assert.ok(fl, "expected floating fail result");
  assert.ok(fl.highlight?.faces?.length > 0, "expected highlighted faces on floating part");
});

test("open-edge mesh fails the open surface check", () => {
  // Remove one triangle from a 20mm cube so 3 edges are open
  const tris = boxTris(-10, -10, 0, 10, 10, 20).slice(1);
  const buf = encodeBinaryStl(tris);
  const r = runChecks(parseStl(buf), PRINTERS.p1s);
  assert.equal(r.verdict, "fail");
  const op = r.results.find((x) => x.id === "open" && x.status === "fail");
  assert.ok(op, "expected open surface failure");
  assert.ok(op.highlight?.segments?.length > 0);
});

test("oversized mesh fails bed fit on AD5M (220mm) and P1S (256mm)", () => {
  const tris = boxTris(0, 0, 0, 240, 50, 10);
  const buf = encodeBinaryStl(tris);
  const rAd5m = runChecks(parseStl(buf), PRINTERS.ad5m);
  assert.equal(rAd5m.verdict, "fail");
  assert.ok(rAd5m.results.some((x) => x.id === "fit" && x.status === "fail"));

  const rP1s = runChecks(parseStl(buf), PRINTERS.p1s);
  assert.ok(rP1s.results.some((x) => x.id === "fit" && x.status === "pass"));
});

test("too-slow sample exceeds 30 minutes", () => {
  const buf = makeTooSlowExampleStl();
  const r = runChecks(parseStl(buf), PRINTERS.p1s);
  const s = estimate(r.mesh, PRINTERS.p1s);
  assert.ok(s.minutes > 30, `expected >30 min, got ${s.minutes}`);
});

test("separate objects are highlighted as one coloured group each", () => {
  const tris = [...boxTris(-40, -10, 0, -20, 10, 10), ...boxTris(20, -10, 0, 40, 10, 10)];
  const r = runChecks(parseStl(encodeBinaryStl(tris)), PRINTERS.p1s);
  const sep = r.results.find((x) => x.id === "separate");
  assert.ok(sep, "expected separate-objects warning");
  assert.equal(sep.highlight.groups.length, 2);
  assert.equal(sep.highlight.faces.length, sep.highlight.groups.flat().length);
});

test("STL with no usable triangles reports an empty file with a size", () => {
  const r = runChecks(new Float32Array(9), PRINTERS.p1s); // one degenerate triangle
  assert.equal(r.verdict, "fail");
  assert.ok(r.results.some((x) => x.id === "empty"));
  assert.deepEqual(r.size, [0, 0, 0]);
});

test("rejects STL files containing NaN or infinite coordinates", () => {
  const bad = encodeBinaryStl(boxTris(0, 0, 0, 10, 10, 10));
  new DataView(bad).setFloat32(84 + 12, NaN, true);
  assert.throws(() => parseStl(bad), StlError);
  const inf = encodeBinaryStl(boxTris(0, 0, 0, 10, 10, 10));
  new DataView(inf).setFloat32(84 + 12, Infinity, true);
  assert.throws(() => parseStl(inf), StlError);
});

test("real student STLs match OrcaSlicer ground truth on floating parts and 30-min decisions", { skip: !existsSync(studentFile("keychain")) }, () => {
  // Keyboard Keychain: ~24 min on P1S. Its key legends sit 0.2 to 0.4 mm above the base, and
  // OrcaSlicer (supports off) warns "floating regions", so it must fail the floating check.
  const kc = parseStl(readFileSync(studentFile("keychain")));
  const rKc = runChecks(kc, PRINTERS.p1s);
  assert.equal(rKc.verdict, "fail");
  assert.ok(rKc.results.some((x) => x.id === "floating" && x.status === "fail"));
  const sKc = estimate(rKc.mesh, PRINTERS.p1s);
  assert.ok(Math.abs(sKc.minutes - 24.2) < 3.0, `Keyboard Keychain P1S expected ~24.2m, got ${sKc.minutes.toFixed(1)}m`);

  // Frog: passes mesh checks (with warnings), ~29-31m on P1S, ~31-36m on AD5M
  const frog = parseStl(readFileSync(studentFile("frog")));
  const rFrog = runChecks(frog, PRINTERS.p1s);
  assert.equal(rFrog.verdict, "pass");
  const sFrog = estimate(rFrog.mesh, PRINTERS.p1s);
  assert.ok(Math.abs(sFrog.minutes - 30.4) < 3.5);

  // Duck: has a real floating part at z=60mm and takes >120 min
  const duck = parseStl(readFileSync(studentFile("duck")));
  const rDuck = runChecks(duck, PRINTERS.p1s);
  assert.equal(rDuck.verdict, "fail");
  assert.ok(rDuck.results.some((x) => x.id === "floating" && x.status === "fail"));
  const sDuck = estimate(rDuck.mesh, PRINTERS.p1s);
  assert.ok(Math.abs(sDuck.minutes - 121.0) < 10.0);
});

test("egg letters: only the one resting on the tip counts as supported (matches OrcaSlicer)", { skip: !existsSync(studentFile("egg")) }, () => {
  const r = runChecks(parseStl(readFileSync(studentFile("egg"))), PRINTERS.p1s);
  const fl = r.results.find((x) => x.id === "floating");
  assert.equal(fl.status, "fail");
  assert.match(fl.title, /^2 parts/); // the left letter and the right letter; the middle one touches the tip
});

test("floating needs support from below: sideways contact and gaps over 0.15 mm do not count", () => {
  const base = boxTris(-20, -20, 0, 20, 20, 10);
  const verdict = (extra) => runChecks(parseStl(encodeBinaryStl([...base, ...extra])), PRINTERS.p1s)
    .results.find((x) => x.id === "floating").status;
  assert.equal(verdict(boxTris(-5, -5, 10.1, 5, 5, 15)), "pass");  // sits 0.1 mm above: fuses
  assert.equal(verdict(boxTris(-5, -5, 10.3, 5, 5, 15)), "fail");  // 0.3 mm gap: starts in the air
  assert.equal(verdict(boxTris(20.05, -5, 8, 30, 5, 15)), "fail"); // hangs off the side, nothing beneath
  assert.equal(verdict(boxTris(-5, -5, 9, 5, 5, 15)), "pass");     // sunk into the base
});

test("floating pieces get a measured gap ruler and a lower-by amount", () => {
  const base = boxTris(-20, -20, 0, 20, 20, 10);
  const run = (extra) => runChecks(parseStl(encodeBinaryStl([...base, ...extra])), PRINTERS.p1s)
    .results.find((x) => x.id === "floating");
  const near = run(boxTris(-5, -5, 10.3, 5, 5, 15));
  const m = near.highlight.markers[0];
  assert.equal(m.kind, "part");
  assert.ok(Math.abs(m.gap - 0.3) < 0.02, `gap ${m.gap}`);
  assert.ok(Math.abs(m.z0 - 10.3) < 0.01 && Math.abs(m.z1 - 10) < 0.01);
  assert.match(near.fix, /about 0\.50 mm|about 0\.5 mm/);
  const far = run(boxTris(60, -5, 12, 70, 5, 20)); // nothing under it
  assert.equal(far.highlight.markers[0].kind, "bed");
  assert.ok(Math.abs(far.highlight.markers[0].gap - 12) < 0.05);
});

test("ASCII STL with uppercase keywords and CRLF line endings is read", () => {
  const tris = boxTris(0, 0, 0, 10, 10, 10);
  const pos = parseStl(encodeBinaryStl(tris));
  let text = "SOLID T\r\n";
  for (let t = 0; t < pos.length / 9; t++) {
    text += "FACET NORMAL 0 0 0\r\nOUTER LOOP\r\n";
    for (let k = 0; k < 3; k++) text += `VERTEX ${pos[t * 9 + k * 3]} ${pos[t * 9 + k * 3 + 1]} ${pos[t * 9 + k * 3 + 2]}\r\n`;
    text += "ENDLOOP\r\nENDFACET\r\n";
  }
  assert.equal(parseStl(new TextEncoder().encode(text + "ENDSOLID T\r\n").buffer).length, pos.length);
});

test("an absurdly large model does not exhaust memory in the slicer", () => {
  const r = runChecks(parseStl(encodeBinaryStl(boxTris(0, 0, 0, 1e6, 1e6, 10))), PRINTERS.p1s);
  const s = estimate(r.mesh, PRINTERS.p1s); // grid is capped, so this returns instead of throwing RangeError
  assert.ok(Number.isFinite(s.minutes));
});

test("Fix it: lowering a floating part clears the floating check without new failures", () => {
  const pos = parseStl(makeFloatingExampleStl());
  const before = runChecks(pos, PRINTERS.p1s);
  assert.equal(before.results.find((x) => x.id === "floating").fixable, "lower");
  const { pos: fixed, applied } = lowerFloating(pos, PRINTERS.p1s);
  assert.ok(applied.length > 0);
  const after = runChecks(fixed, PRINTERS.p1s);
  assert.equal(after.results.find((x) => x.id === "floating").status, "pass");
  const failing = (r) => r.results.filter((x) => x.status === "fail").map((x) => x.id);
  assert.ok(failing(after).every((id) => failing(before).includes(id)));
  // A part 0.3 mm above the base is lowered by gap + 0.1 mm.
  const near = parseStl(encodeBinaryStl([...boxTris(-20, -20, 0, 20, 20, 10), ...boxTris(-5, -5, 10.3, 5, 5, 15)]));
  const low = lowerFloating(near, PRINTERS.p1s);
  assert.match(low.applied[0], /0\.4\d? mm|0\.40 mm/);
  assert.equal(runChecks(low.pos, PRINTERS.p1s).results.find((x) => x.id === "floating").status, "pass");
});

test("Fix it: a fix that creates a new failing check is rejected", () => {
  // A 0.3 x 0.3 mm column resting 0.1 mm above a base holds at full size (enough contact area)
  // but not at 40% (contact area under 0.05 mm2), so scaling down adds a failing "floating".
  const model = parseStl(encodeBinaryStl([...boxTris(-20, -20, 0, 20, 20, 10), ...boxTris(-0.15, -0.15, 10.1, 0.15, 0.15, 14)]));
  const failing = (p) => badIds(runChecks(p, PRINTERS.p1s).results);
  assert.deepEqual(failing(model), []);
  const small = Float32Array.from(model, (n) => n * 0.4);
  assert.deepEqual(failing(small), ["floating"]);
  assert.equal(fixAccepted(new Set(["time", "empty_layers"]), failing(small)), false); // fewer, but a new id
  assert.equal(fixAccepted(new Set(["time", "empty_layers"]), ["time"]), true);
  assert.equal(fixAccepted(new Set(["time"]), ["time"]), false); // nothing improved
  assert.equal(fixAccepted(new Set(["time"]), []), true);
});

test("writeBinaryStl round-trips through parseStl", () => {
  const pos = parseStl(makeFloatingExampleStl());
  assert.deepEqual(parseStl(writeBinaryStl(pos)), pos);
});

test("Fix it: thin-wall warnings count against a fix, and a drop into a hidden obstacle is refused", () => {
  const fake = (id, status) => ({ id, status });
  assert.deepEqual(badIds([{ ...fake("thin", "warn"), severe: true }, fake("overhang", "warn"), fake("floating", "fail"), fake("fit", "pass")]), ["thin", "floating"]);
  assert.deepEqual(badIds([{ ...fake("thin", "warn"), severe: false }]), []); // mild thin walls do not block
  assert.equal(fixAccepted(new Set(["time"]), ["thin"]), false);
  // A thin pillar under the floater that the gap ruler's sample points can miss: dropping to the
  // base would push the floater through it, so no fix is offered and the file is left alone.
  const base = [...boxTris(-30, -30, 0, 30, 30, 10), ...boxTris(3.1, 2.9, 9, 3.5, 3.3, 19.5)];
  const pos = parseStl(encodeBinaryStl([...base, ...boxTris(-10, -10, 20, 10, 10, 24)]));
  const r = lowerFloating(pos, PRINTERS.p1s);
  assert.deepEqual(r.applied, []);
  assert.equal(r.pos, pos);
});

// A 30 mm plaque with six raised 8 mm bars: bar width w, spaced `gap` apart.
const plaque = (w, gap) => {
  const tris = boxTris(-15, -15, 0, 15, 15, 1.2);
  for (let i = 0; i < 6; i++) { const x = -6 + i * (w + gap); tris.push(...boxTris(x, -4, 1.2, x + w, 4, 2.2)); }
  return parseStl(encodeBinaryStl(tris));
};
const reliefOf = (pos) => runChecks(pos, PRINTERS.ad5m).results.find((r) => r.id === "relief-detail");

test("relief detail: raised strokes narrower than a nozzle line are flagged", () => {
  const r = reliefOf(plaque(0.3, 1.5));
  assert.equal(r.status, "warn");
  assert.ok(r.data.thinMm2 > 10, `thin ${r.data.thinMm2}`);
  assert.ok(r.highlight.faces.length > 0);
});

test("relief detail: gaps narrower than a nozzle line (letters fusing) are flagged", () => {
  const r = reliefOf(plaque(1.0, 0.25));
  assert.equal(r.status, "warn");
  assert.ok(r.data.gapMm2 > 5, `gap ${r.data.gapMm2}`);
  assert.ok(r.data.thinMm2 < 1, `thin ${r.data.thinMm2}`);
});

test("relief detail: strokes and gaps of 1.2 mm pass; corners alone do not trip it", () => {
  const r = reliefOf(plaque(1.2, 1.2));
  assert.equal(r.status, "pass");
  assert.ok(r.data.thinMm2 < 0.5 && r.data.gapMm2 < 0.5);
});

test("relief detail: size search can skip it (relief: false) without changing other checks", () => {
  const pos = plaque(0.3, 1.5);
  const full = runChecks(pos, PRINTERS.ad5m), lean = runChecks(pos, PRINTERS.ad5m, undefined, { relief: false });
  assert.equal(lean.results.find((r) => r.id === "relief-detail"), undefined);
  const others = (c) => c.results.filter((r) => r.id !== "relief-detail").map((r) => `${r.id}:${r.status}`);
  assert.deepEqual(others(lean), others(full));
});

test("relief detail: tall parts are not treated as relief", () => {
  assert.equal(reliefOf(makePassingExampleStl()), undefined);
});
