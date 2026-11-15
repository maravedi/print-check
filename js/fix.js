// "Fix it for me" helpers shared by the worker, the page and the tests.

import { runChecks } from "./checks.js";

export const MAX_SINK_MM = 0.25; // the fix sinks a part 0.1 mm into what is below it; allow for sampling error

// Deepest any vertex of one part ends up inside another part, for pairs where at least one was
// lowered (both at their post-move positions). Points on both parts are tested, because a thin
// obstacle can poke through a flat underside without touching any point of the lowered part.
function sinkDepth(comps, lowerFixes) {
  const dzOf = new Map(lowerFixes.map((f) => [f.faces, f.dz]));
  let worst = 0;
  for (const p of comps) for (const q of comps) {
    const dzp = dzOf.get(p.faces) ?? 0, dzq = dzOf.get(q.faces) ?? 0;
    if (p === q || !q.closed || (!dzp && !dzq)) continue;
    if (p.min[0] > q.max[0] || q.min[0] > p.max[0] || p.min[1] > q.max[1] || q.min[1] > p.max[1]
      || p.min[2] + dzp > q.max[2] + dzq || q.min[2] + dzq > p.max[2] + dzp) continue;
    const { V, F } = p.bvh, step = Math.max(1, Math.floor(p.faces.length / 150));
    for (let i = 0; i < p.faces.length; i += step) {
      const t = p.faces[i] * 3, a = F[t] * 3, b = F[t + 1] * 3, c = F[t + 2] * 3;
      // the three corners and the centre: a long thin face can pass through a part with no corner inside it
      for (const [x, y, z0] of [[V[a], V[a + 1], V[a + 2]], [V[b], V[b + 1], V[b + 2]], [V[c], V[c + 1], V[c + 2]],
        [(V[a] + V[b] + V[c]) / 3, (V[a + 1] + V[b + 1] + V[c + 1]) / 3, (V[a + 2] + V[b + 2] + V[c + 2]) / 3]]) {
        const z = z0 + dzp - dzq; // in q's own frame
        if (!q.bvh.contains(x, y, z)) continue;
        const depth = Math.min(q.bvh.raycast(x, y, z, 1e-7, 1e-7, 1), q.bvh.raycast(x, y, z, 1e-7, 1e-7, -1));
        if (depth > worst) worst = depth;
      }
    }
  }
  return worst;
}

// Lower every floating part (bottom-up: stacked floaters resolve over several passes).
// Gives up (no change, nothing applied) if a part would sink deeper than MAX_SINK_MM into another.
export function lowerFloating(pos, printer, maxPasses = 5) {
  const start = pos, applied = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    const c = runChecks(pos, printer);
    if (!c.lowerFixes?.length) break;
    if (sinkDepth(c.comps, c.lowerFixes) > MAX_SINK_MM) return { pos: start, applied: [] };
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

// Ids that block a fix from counting as better: every failing check, plus severe thin walls
// (a warning, but scaling down is the change most likely to make details too thin). A mild
// thin-walls warning ("will print, but may be weak") does not block.
export const blocks = (r) => r.status === "fail" || (r.id === "thin" && r.status === "warn" && r.severe);
export const badIds = (results) => results.filter(blocks).map((r) => r.id);

// A fix is kept only if it leaves fewer bad check ids and none that were not bad before.
export const fixAccepted = (before, after) =>
  new Set(after).size < before.size && after.every((id) => before.has(id));
