#!/usr/bin/env node
// CLI tool for teachers to validate and register a new pre-approved fidget into the Fidget Store.
// Usage: node tools/add-fidget.mjs path/to/model.stl --id slug --name "Name" --desc "Description" [--tags "Tag1,Tag2"]
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, resolve, extname } from "node:path";
import { parseStl } from "../js/stl.js";
import { runChecks } from "../js/checks.js";
import { PRINTERS } from "../js/printers.js";
import { STORE_FIDGETS } from "../js/store-catalog.js";

const args = process.argv.slice(2);
let stlPath = null, id = null, name = null, desc = null, tags = ["Print-in-Place"], highlights = "0 supports";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--id") id = args[++i];
  else if (args[i] === "--name") name = args[++i];
  else if (args[i] === "--desc") desc = args[++i];
  else if (args[i] === "--tags") tags = args[++i].split(",").map(s => s.trim());
  else if (args[i] === "--highlights") highlights = args[++i];
  else if (!stlPath) stlPath = args[i];
}

if (!stlPath) {
  console.error("Usage: node tools/add-fidget.mjs <file.stl> --id <slug> --name <Title> --desc <Description>");
  process.exit(1);
}

const fileBase = basename(stlPath, extname(stlPath));
id = id || fileBase.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
name = name || fileBase.replace(/[_-]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
desc = desc || "Pre-approved print-in-place fidget model.";

console.log(`Checking ${stlPath} for inclusion in Fidget Store...`);
const buf = readFileSync(stlPath);
const pos = parseStl(buf);
const printer = PRINTERS.p1s;
const r = runChecks(pos, printer);

if (!r.topologyOk) {
  console.error("❌ FAILED: Mesh has open edges or invalid topology.");
  process.exit(1);
}

const slicer = await import("../js/slicer.js");
const est = slicer.estimate(r.mesh, printer);
const mins = Math.round(est.seconds / 60);

if (mins > 30) {
  console.error(`❌ FAILED: Model takes ${mins} min, exceeding the 30-min class limit.`);
  process.exit(1);
}

const fails = r.results.filter(x => x.status === "fail");
if (fails.length) {
  console.error("❌ FAILED checks:");
  for (const f of fails) console.error(`  - ${f.title}: ${f.message}`);
  process.exit(1);
}

const destFile = `models/fidgets/${id}.stl`;
copyFileSync(stlPath, resolve(destFile));
console.log(`✓ Copied STL to ${destFile}`);

const dims = [Math.round(r.size[0]), Math.round(r.size[1]), Math.round(r.size[2])];
const newEntry = {
  id,
  name,
  coins: 3,
  timeMinutes: Math.max(1, mins),
  dimensionsMm: dims,
  tags,
  description: desc,
  stlPath: `./${destFile}`,
  highlights
};

const existingIdx = STORE_FIDGETS.findIndex(x => x.id === id);
let updatedList = [...STORE_FIDGETS];
if (existingIdx >= 0) {
  updatedList[existingIdx] = newEntry;
  console.log(`✓ Updated existing catalog entry '${id}'`);
} else {
  updatedList.push(newEntry);
  console.log(`✓ Added new catalog entry '${id}'`);
}

const catalogCode = `// Pre-approved fidget catalog for Tinkercad 3D Print Pre-Check.
// All models are pre-validated to pass all checks, require zero supports, and fit within class limits.

export const STORE_FIDGETS = ${JSON.stringify(updatedList, null, 2)};
`;

writeFileSync(resolve("js/store-catalog.js"), catalogCode);
console.log("✓ Updated js/store-catalog.js");
console.log("\nNext steps to publish to GitHub Pages:");
console.log(`  git add ${destFile} js/store-catalog.js`);
console.log(`  git commit -m "Add ${name} to Fidget Store"`);
console.log("  git push");
