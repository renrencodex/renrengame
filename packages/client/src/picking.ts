/** 一个可以被点选的目标在屏幕上的位置（像素）和点选半径。 */
export interface PickCandidate {
  id: number;
  x: number;
  y: number;
  radius: number;
}

/**
 * 按屏幕距离点选：返回点击位置落在其点选半径内、并且离得最近的那个目标的 id，没有时返回 0。
 *
 * 用屏幕距离而不是射线和模型求交，是因为小目标和触摸屏上很难点准，
 * 这样可以给每个目标一个不小于手指大小的点选范围。
 */
export function pickEntity(candidates: readonly PickCandidate[], px: number, py: number): number {
  let bestId = 0;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - px, c.y - py);
    if (d <= c.radius && d < bestDistance) {
      bestDistance = d;
      bestId = c.id;
    }
  }
  return bestId;
}
