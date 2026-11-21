export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return "< 1 min";
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

export function calculateCoins(minutes, maxMinutes = 30, minutesPerCoin = 10) {
  const minCoins = Math.max(1, Math.ceil(maxMinutes / minutesPerCoin));
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { coins: minCoins, label: `${minCoins} coins`, allowed: true, minCoins };
  }
  const calculatedCoins = Math.ceil(minutes / minutesPerCoin);
  const coins = Math.max(minCoins, calculatedCoins);
  const allowed = minutes <= maxMinutes;
  return {
    coins,
    label: `${coins} ${coins === 1 ? "coin" : "coins"}`,
    allowed,
    minCoins
  };
}

