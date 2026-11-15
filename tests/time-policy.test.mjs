import test from "node:test";
import assert from "node:assert/strict";
import { timeStatus, findScaleCandidate } from "../js/time-policy.js";
import { makeTooSlowExampleStl } from "../js/samples.js";
import { parseStl } from "../js/stl.js";
import { runChecks } from "../js/checks.js";
import { estimate } from "../js/slicer.js";
import { PRINTERS } from "../js/printers.js";

test("class time review boundaries are explicit", () => {
  assert.equal(timeStatus(23.99, 30), "pass");
  assert.equal(timeStatus(24, 30), "review");
  assert.equal(timeStatus(30, 30), "review");
  assert.equal(timeStatus(30.01, 30), "fail");
});

test("a proposed scale is resliced and checked; unsafe candidates are rejected", () => {
  const pos = parseStl(makeTooSlowExampleStl());
  const original = runChecks(pos, PRINTERS.p1s);
  const args = { mesh: original.mesh, size: original.size, printers: [PRINTERS.p1s], limit: 30, estimate,
    check: (scale, printer) => runChecks(Float32Array.from(pos, n => n * scale), printer) };
  const candidate = findScaleCandidate(args);
  assert.ok(candidate);
  assert.ok(candidate.percent < 100);
  assert.ok(candidate.minutes < 24);
  assert.equal(findScaleCandidate({ ...args, check: () => ({ results: [{ id: "thin", status: "warn" }] }) }), null);
});

test("a rejected search records why each size failed", () => {
  const pos = parseStl(makeTooSlowExampleStl());
  const original = runChecks(pos, PRINTERS.p1s);
  const trace = [];
  const none = findScaleCandidate({ mesh: original.mesh, size: original.size, printers: [PRINTERS.p1s], limit: 30, estimate, trace,
    check: () => ({ results: [{ id: "thin", status: "warn" }] }) });
  assert.equal(none, null);
  assert.ok(trace.some((x) => x.why === "time" && x.minutes > 24)); // big sizes are too slow
  assert.ok(trace.some((x) => x.why === "checks" && x.bad.includes("thin"))); // fast sizes fail the check
});
