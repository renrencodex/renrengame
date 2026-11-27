import { MAX_MOVE_DISTANCE } from './constants';
import { isWalkable } from './map';
import type { GameMap } from './map';
import type { Point } from './pathfinding';

/** 沿路径移动的实体。path 为 null 表示静止。 */
export interface Mover {
  x: number;
  z: number;
  path: Point[] | null;
  /** 正在走向 path[pathIndex]。 */
  pathIndex: number;
}

export function setPath(m: Mover, path: Point[] | null): void {
  m.path = path && path.length > 1 ? path : null;
  m.pathIndex = 1;
}

/** 沿路径前进 dist 的距离。返回这一步之后是否还在移动。 */
export function stepMover(m: Mover, dist: number): boolean {
  while (m.path && dist > 0) {
    const p = m.path[m.pathIndex];
    const dx = p.x - m.x;
    const dz = p.z - m.z;
    const d = Math.hypot(dx, dz);
    if (d <= dist) {
      m.x = p.x;
      m.z = p.z;
      dist -= d;
      m.pathIndex++;
      if (m.pathIndex >= m.path.length) m.path = null;
    } else {
      m.x += (dx / d) * dist;
      m.z += (dz / d) * dist;
      dist = 0;
    }
  }
  return m.path !== null;
}

/** moveTo 的目标是否合法：数值有效、在地图内、可行走、离当前位置不太远。 */
export function isValidMoveTarget(
  map: GameMap,
  fromX: number,
  fromZ: number,
  x: number,
  z: number,
  maxDistance: number = MAX_MOVE_DISTANCE,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (!isWalkable(map, x, z)) return false;
  return Math.hypot(x - fromX, z - fromZ) <= maxDistance;
}
