export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return "< 1 min";
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}
