// Web Worker entry point: parses the STL, runs printability checks, slices layers
// for both supported printers, checks the time limit, and returns structured results
// plus geometry buffers for the 3D viewer.

import { parseStl, writeBinaryStl } from "./stl.js";
import { runChecks } from "./checks.js";
import { estimate } from "./slicer.js";
import { timeStatus, findScaleCandidate } from "./time-policy.js";
import { PRINTERS } from "./printers.js";
import { formatMinutes } from "./format.js";
import { lowerFloating } from "./fix.js";

self.onmessage = (ev) => {
  const { buffer, fileName, maxMinutes = 30, apply } = ev.data;
  const progress = (stage, pct) => self.postMessage({ type: "progress", stage, pct });
  try {
    const t0 = performance.now();
    progress("Reading STL file...", 0.03);
    let pos = parseStl(buffer);
    const printer = PRINTERS.p1s;

    // "Fix it for me": apply the requested change, then run the normal checks on the result.
    const applied = [];
    if (apply?.scale > 0 && apply.scale < 1) {
      pos = Float32Array.from(pos, (n) => n * apply.scale);
      applied.push(`Scaled to ${Math.round(apply.scale * 100)}% of the original size`);
    }
    if (apply?.lower) {
      const lowered = lowerFloating(pos, printer);
      pos = lowered.pos;
      applied.push(...lowered.applied);
    }

    const chk = runChecks(pos, printer, progress);
    if (chk.results[0]?.id === "empty") throw new Error("This file has no printable shape in it. Make sure your design is on the workplane, then export it again as .STL.");
    progress("Slicing layers and estimating print time...", 0.9);
    // A model too big for a printer is never sliced for it: a huge typo size would exhaust memory.
    const notSliced = { seconds: 0, minutes: 0, layers: 0, emptyLayers: [], filamentMm: 0, filamentG: 0, breakdown: {}, skipped: true };
    const estimates = Object.values(PRINTERS).map((profile) => {
      const fits = chk.size[0] <= profile.bed[0] && chk.size[1] <= profile.bed[1] && chk.size[2] <= profile.bed[2];
      return { printer: profile, slice: fits ? estimate(chk.mesh, profile, 1.0, progress) : notSliced, fits };
    });
    const fitResult = chk.results.find((r) => r.id === "fit");
    if (fitResult) {
      const fitting = estimates.filter((e) => e.fits);
      fitResult.status = fitting.length ? "pass" : "fail";
      fitResult.title = fitting.length ? "Fits at least one supported printer" : "Too big for both supported printers";
      fitResult.message = fitting.length
        ? `This model fits: ${fitting.map((e) => e.printer.name).join(" and ")}. The teacher will choose which printer to use.`
        : `Your model is ${chk.size.map((n) => n.toFixed(1)).join(" × ")} mm. It exceeds the build volume of both supported printers.`;
    }

    // Empty layer check from slicer
    const emptyLayerEstimate = estimates.find(({ slice }) => slice.emptyLayers?.length);
    if (emptyLayerEstimate) {
      const { printer: profile, slice } = emptyLayerEstimate;
      chk.results.push({
        id: "empty_layers",
        status: "fail",
        title: `Empty gap between layers (${slice.emptyLayers.length} layer${slice.emptyLayers.length === 1 ? "" : "s"})`,
        message: `Layer ${slice.emptyLayers[0]} (around ${(slice.emptyLayers[0] * profile.layer).toFixed(1)} mm up) has nothing in it, so the top of the model is disconnected from the bottom.`,
        fix: "Move the upper part down in Tinkercad until it overlaps the part below it, then click Group.",
        highlight: null,
      });
    }

    // Print time check against maxMinutes
    const viable = estimates.filter((e) => e.fits);
    const underLimit = viable.filter((e) => e.slice.minutes <= maxMinutes);
    const mins = Math.min(...viable.map((e) => e.slice.minutes));
    const minStr = mins < 1 ? "under 1 minute" : formatMinutes(mins);
    if (viable.length && !underLimit.length) {
      progress("Checking smaller sizes...", 0.96);
      // A broken model (floating parts, holes) stays broken at any size, so don't suggest one.
      const brokenAtAnySize = chk.results.some((r) => r.status === "fail" && r.id !== "fit");
      const candidate = brokenAtAnySize ? null : findScaleCandidate({ mesh: chk.mesh, size: chk.size, printers: Object.values(PRINTERS), limit: maxMinutes, estimate,
        check: (scale, profile) => runChecks(Float32Array.from(pos, n => n * scale), profile) });
      const scaleFix = candidate
        ? `One starting point is ${candidate.percent}% of the original size (${candidate.size.map(n => n.toFixed(1)).join(" × ")} mm), estimated at ${formatMinutes(candidate.minutes)} on ${candidate.printer}. Check that holes, text and the overall size will still be useful. Scale uniformly in Tinkercad, export the new STL and check it again. The teacher must confirm the final print time.`
        : "Try reducing the height, simplifying the model or asking your teacher for help. Check that the final size and details remain useful, then export and check the new STL.";
      chk.results.push({
        id: "time",
        status: "fail",
        title: `Print takes too long (${minStr}, limit is ${formatMinutes(maxMinutes)})`,
        message: `The estimated times are ${estimates.map((e) => `${e.printer.name}: ${formatMinutes(e.slice.minutes)}`).join("; ")}. No printer that fits is within the ${formatMinutes(maxMinutes)} class limit.`,
        fix: scaleFix,
        fixable: candidate ? "scale" : undefined,
        fixScale: candidate ? candidate.percent / 100 : undefined,
        highlight: null,
      });
    } else if (underLimit.length) {
      const nearLimit = timeStatus(mins, maxMinutes) === "review";
      chk.results.push({
        id: "time",
        status: nearLimit ? "warn" : "pass",
        needsReview: nearLimit,
        title: nearLimit ? `Print time is close to the ${formatMinutes(maxMinutes)} limit (${minStr})` : `Estimated time is under the ${formatMinutes(maxMinutes)} limit (${minStr})`,
        message: `Estimated times: ${estimates.map((e) => `${e.printer.name}: ${formatMinutes(e.slice.minutes)}`).join("; ")}. At least one printer that fits is within the ${formatMinutes(maxMinutes)} class limit.`,
        fix: nearLimit ? "Ask your teacher to confirm the time in the slicer before printing. Estimates can be inaccurate." : "",
        highlight: null,
      });
    }

    const verdict = chk.results.some((r) => r.status === "fail") ? "fail" : chk.results.some(r => r.needsReview) ? "review" : "pass";

    // Build flat Float32Array of placed triangle positions for the 3D viewer
    const { V, F, nT } = chk.mesh;
    const placedPos = new Float32Array(nT * 9);
    for (let t = 0; t < nT; t++) {
      for (let k = 0; k < 3; k++) {
        const v = F[t * 3 + k] * 3;
        placedPos[t * 9 + k * 3] = V[v];
        placedPos[t * 9 + k * 3 + 1] = V[v + 1];
        placedPos[t * 9 + k * 3 + 2] = V[v + 2];
      }
    }

    const fixedStl = applied.length ? writeBinaryStl(placedPos) : null; // placed: centred, on the bed
    const elapsedMs = Math.round(performance.now() - t0);
    self.postMessage({
      type: "done",
      fileName,
      maxMinutes,
      verdict,
      estimates,
      size: chk.size,
      triangleCount: nT,
      partCount: chk.comps ? chk.comps.length : 1,
      results: chk.results,
      slice: {
        minutes: estimates[0].slice.minutes,
        seconds: estimates[0].slice.seconds,
        layers: estimates[0].slice.layers,
        filamentG: estimates[0].slice.filamentG,
        filamentMm: estimates[0].slice.filamentMm,
        breakdown: estimates[0].slice.breakdown,
      },
      elapsedMs,
      placedPos,
      applied,
      fixedStl,
    }, [placedPos.buffer, ...(fixedStl ? [fixedStl] : [])]);
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err?.message || "Could not read this STL file.",
    });
  }
};
