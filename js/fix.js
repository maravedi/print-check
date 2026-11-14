// "Fix it for me" helpers shared by the worker, the page and the tests.

import { runChecks } from "./checks.js";

// Lower every floating part (bottom-up: stacked floaters resolve over several passes).
export function lowerFloating(pos, printer, maxPasses = 5) {
  const applied = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    const c = runChecks(pos, printer);
    if (!c.lowerFixes?.length) break;
    const { V, F, nT } = c.mesh;
    const dz = new Float64Array(nT);
    for (const f of c.lowerFixes) for (const t of f.faces) dz[t] = f.dz;
    const out = new Float32Array(nT * 9);
    for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
      const v = F[t * 3 + k] * 3, o = t * 9 + k * 3;
      out[o] = V[v]; out[o + 1] = V[v + 1]; out[o + 2] = V[v + 2] + dz[t];
    }
    pos = out;
    applied.push(...c.lowerFixes.map((f) => `Lowered one piece by ${Math.abs(f.dz).toFixed(2)} mm`));
  }
  return { pos, applied };
}

// A fix is kept only if it leaves fewer failing check ids and none that were not failing before.
export const fixAccepted = (before, after) =>
  new Set(after).size < before.size && after.every((id) => before.has(id));
