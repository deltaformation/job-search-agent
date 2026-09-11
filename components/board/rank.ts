/**
 * Fractional rank for a card dropped at `toIndex` among the target column's
 * ascending ranks (with the dragged card already excluded). Ends extend by
 * whole steps; middles split the gap. Tied or inverted neighbors (only
 * possible from out-of-band writes — the UI always writes distinct ranks)
 * degrade to just-after-prev so the card still moves.
 */
export function computeDropRank(ranks: number[], toIndex: number): number {
  const clamped = Math.max(0, Math.min(toIndex, ranks.length));
  if (ranks.length === 0) {
    return 0;
  }
  const first = ranks[0] as number;
  const last = ranks[ranks.length - 1] as number;
  if (clamped === 0) {
    return first - 1;
  }
  if (clamped >= ranks.length) {
    return last + 1;
  }
  const prev = ranks[clamped - 1] as number;
  const next = ranks[clamped] as number;
  if (next > prev) {
    return prev + (next - prev) / 2;
  }
  return prev + 1;
}
