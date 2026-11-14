#!/usr/bin/env node
// Run the same checks (and time estimate) the web page runs, from the command line.
// Usage: node tools/precheck-cli.mjs [--printer p1s|ad5m] [--json] file.stl [...]
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseStl } from "../js/stl.js";
import { runChecks } from "../js/checks.js";
import { PRINTERS } from "../js/printers.js";

const args = process.argv.slice(2);
let printer = "p1s", json = false, noSlice = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--printer") printer = args[++i];
  else if (args[i] === "--json") json = true;
  else if (args[i] === "--no-slice") noSlice = true;
  else files.push(args[i]);
}
const P = PRINTERS[printer];
let slicer = null;
if (!noSlice) { try { slicer = await import("../js/slicer.js"); } catch { slicer = null; } }
const out = [];
for (const f of files) {
  const t0 = performance.now();
  const pos = parseStl(readFileSync(f));
  const r = runChecks(pos, P);
  const t1 = performance.now();
  let est = null;
  if (slicer && r.topologyOk) est = slicer.estimate(r.mesh, P);
  const t2 = performance.now();
  const rec = { file: basename(f), verdict: r.verdict, checksMs: Math.round(t1 - t0), sliceMs: Math.round(t2 - t1),
    results: r.results.map(({ id, status, title, message }) => ({ id, status, title, message })), estimate: est && { ...est, layers: undefined } };
  out.push(rec);
  if (!json) {
    console.log(`\n== ${rec.file}  [${rec.verdict.toUpperCase()}]  checks ${rec.checksMs} ms, slice ${rec.sliceMs} ms`);
    for (const x of rec.results) if (x.status !== "info") console.log(`  ${x.status.padEnd(4)} ${x.title} — ${x.message.slice(0, 140)}`);
    if (est) console.log(`  time ${(est.seconds / 60).toFixed(1)} min`, JSON.stringify(est.breakdown));
  }
}
if (json) console.log(JSON.stringify(out, null, 1));
