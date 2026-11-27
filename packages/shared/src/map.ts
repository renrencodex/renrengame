import { MAP_SIZE, SPAWN_CLEAR_RADIUS } from './constants';

/** 一个长方体障碍物。x、z 是最小角所在的格子，w、d 是占的格数，h 是高度。 */
export interface Obstacle {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface GameMap {
  readonly seed: number;
  readonly size: number;
  /** size×size 的网格，1 表示不可行走。下标为 cz * size + cx。 */
  readonly blocked: Uint8Array;
  readonly obstacles: readonly Obstacle[];
}

/** 确定性的伪随机数生成器。同一个种子在前后端产生完全相同的序列。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function emptyMap(size: number = MAP_SIZE, seed = 0): GameMap {
  return { seed, size, blocked: new Uint8Array(size * size), obstacles: [] };
}

/** 按种子生成地图。服务端只下发种子，客户端用同一个函数得到相同的地图。 */
export function generateMap(seed: number, size: number = MAP_SIZE): GameMap {
  const rand = mulberry32(seed);
  const blocked = new Uint8Array(size * size);
  const obstacles: Obstacle[] = [];
  const center = size / 2;
  const attempts = Math.floor((size * size) / 110);

  for (let i = 0; i < attempts; i++) {
    const w = 1 + Math.floor(rand() * 5);
    const d = 1 + Math.floor(rand() * 5);
    const h = 1 + Math.round(rand() * 6) / 2;
    const x = 1 + Math.floor(rand() * (size - w - 2));
    const z = 1 + Math.floor(rand() * (size - d - 2));

    const nearestX = Math.max(x, Math.min(center, x + w));
    const nearestZ = Math.max(z, Math.min(center, z + d));
    if (Math.hypot(nearestX - center, nearestZ - center) < SPAWN_CLEAR_RADIUS) continue;

    // 障碍物之间至少留一格通道。
    if (!areaFree(blocked, size, x - 1, z - 1, w + 2, d + 2)) continue;

    for (let cz = z; cz < z + d; cz++) {
      for (let cx = x; cx < x + w; cx++) blocked[cz * size + cx] = 1;
    }
    obstacles.push({ x, z, w, d, h });
  }

  return { seed, size, blocked, obstacles };
}

function areaFree(blocked: Uint8Array, size: number, x: number, z: number, w: number, d: number): boolean {
  for (let cz = z; cz < z + d; cz++) {
    for (let cx = x; cx < x + w; cx++) {
      if (blocked[cz * size + cx] === 1) return false;
    }
  }
  return true;
}

/** 世界坐标 (x, z) 是否在地图内且可行走。 */
export function isWalkable(map: GameMap, x: number, z: number): boolean {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  if (!(cx >= 0 && cz >= 0 && cx < map.size && cz < map.size)) return false;
  return map.blocked[cz * map.size + cx] !== 1;
}
