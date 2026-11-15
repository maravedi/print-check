// A screening margin, not a statistical confidence interval.
export const REVIEW_FRACTION = 0.8;

export function timeStatus(minutes, limit) {
  if (minutes > limit) return "fail";
  return minutes >= limit * REVIEW_FRACTION ? "review" : "pass";
}

// Try a small, bounded set of proportional sizes. A suggestion is only a
// starting point: purpose and fine detail cannot be inferred from an STL.
// Optional `trace` collects why each size was rejected: { percent, printer, minutes, why }.
export function findScaleCandidate({ mesh, size, printers, limit, estimate, check, trace = [] }) {
  for (let percent = 90; percent >= 30; percent -= 5) {
    const scale = percent / 100;
    if (Math.max(...size) * scale < 10) { trace.push({ percent, why: "tiny" }); continue; }
    for (const printer of printers) {
      if (size.some((n, i) => n * scale > printer.bed[i])) continue;
      const slice = estimate(mesh, printer, scale);
      if (timeStatus(slice.minutes, limit) === "fail" || slice.emptyLayers?.length) { trace.push({ percent, printer: printer.name, minutes: slice.minutes, why: "time" }); continue; }
      const result = check(scale, printer);
      const bad = result.results.filter(blocks).map(r => r.id);
      if (bad.length) { trace.push({ percent, printer: printer.name, minutes: slice.minutes, why: "checks", bad }); continue; }
      return { percent, size: size.map(n => n * scale), minutes: slice.minutes, printer: printer.name };
    }
  }
  return null;
}

// A check result that stops a size or a fix counting as better: any failure, or a severe
// thin-walls warning (a mild one means "will print, but may be weak" and does not block).
export const blocks = (r) => r.status === "fail" || (r.id === "thin" && r.status === "warn" && r.severe);
