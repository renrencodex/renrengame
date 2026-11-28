/** 一个可以被点选的目标在屏幕上的位置（像素）和点选半径。 */
export interface PickCandidate {
  id: number;
  x: number;
  y: number;
  radius: number;
}

/** 投影之后的点：x、y、z 都是归一化设备坐标，范围大约是 [-1, 1]。 */
export interface ProjectedPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * 把一个立在地面上的目标（脚和头顶的投影）换成屏幕上的点选圆。
 * 脚或头有一个落在镜头后面/太近（z 超出 [-1, 1]）时返回 null：
 * 那种情况下透视除法会把屏幕坐标撑到几万像素，点选半径盖住整块画布，
 * 点空地也会被当成选中远处的怪物，角色就不朝点击的方向走了。
 */
export function screenPickCandidate(
  id: number,
  foot: ProjectedPoint,
  head: ProjectedPoint,
  width: number,
  height: number,
  minRadius: number,
): PickCandidate | null {
  if (!inClip(foot) || !inClip(head)) return null;
  const footX = (foot.x + 1) * 0.5 * width;
  const footY = (1 - foot.y) * 0.5 * height;
  const headX = (head.x + 1) * 0.5 * width;
  const headY = (1 - head.y) * 0.5 * height;
  if (![footX, footY, headX, headY].every(Number.isFinite)) return null;
  return {
    id,
    x: (footX + headX) / 2,
    y: (footY + headY) / 2,
    radius: Math.max(minRadius, Math.hypot(headX - footX, headY - footY) * 0.6),
  };
}

function inClip(p: ProjectedPoint): boolean {
  return Number.isFinite(p.x + p.y + p.z) && p.z >= -1 && p.z <= 1;
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
