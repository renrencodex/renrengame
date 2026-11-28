import { MAP_SIZE, SPAWN_CLEAR_RADIUS } from './constants';
import type { Point } from './pathfinding';

export const Terrain = {
  Grass: 0,
  Forest: 1,
  Meadow: 2,
  Village: 3,
  Stone: 4,
  Bank: 5,
  Water: 6,
  Road: 7,
  Bridge: 8,
} as const;
export type Terrain = (typeof Terrain)[keyof typeof Terrain];

/** x、z 是最小角所在的格子，w、d 是占的格数。 */
interface CellRect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface Obstacle extends CellRect {
  kind: 'tree' | 'rock' | 'wall' | 'house' | 'fence' | 'stall';
  h: number;
}

export type Bridge = CellRect;

export interface Landmark extends Point {
  kind: 'village' | 'forest' | 'ruins' | 'meadow';
  name: string;
}

export interface GameMap {
  readonly seed: number;
  readonly size: number;
  /** size×size 的网格，1 表示不可行走。下标为 cz * size + cx。 */
  readonly blocked: Uint8Array;
  /** 同一套格子上记录地表，画面和小地图一起使用。 */
  readonly terrain: Uint8Array;
  readonly obstacles: readonly Obstacle[];
  readonly bridges: readonly Bridge[];
  readonly landmarks: readonly Landmark[];
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
  return {
    seed,
    size,
    blocked: new Uint8Array(size * size),
    terrain: new Uint8Array(size * size),
    obstacles: [],
    bridges: [],
    landmarks: [],
  };
}

/** 先确定河道、桥和地标之间的通路，再放置会挡路的景物。 */
export function generateMap(seed: number, size: number = MAP_SIZE): GameMap {
  const { terrain, blocked } = emptyMap(size, seed);
  const rand = mulberry32(seed);
  const reserved = new Uint8Array(size * size);
  const obstacles: Obstacle[] = [];
  const center = size / 2;
  const c = Math.floor(center);
  const scale = size / MAP_SIZE;
  const landmarks: Landmark[] = [];
  const bridges: Bridge[] = [];

  function place(obstacle: Obstacle, setback = 0): void {
    const { x, z, w, d } = obstacle;
    if (x - setback < 1 || x + w + setback >= size || z - setback < 1 || z + d + setback >= size) return;
    for (let cz = z - setback; cz < z + d + setback; cz++) {
      for (let cx = x - setback; cx < x + w + setback; cx++) {
        const index = cz * size + cx;
        if (blocked[index] || reserved[index]) return;
      }
    }
    paintRect(blocked, size, obstacle, 1);
    obstacles.push(obstacle);
  }

  // 多留半格余量，安全区边缘的模型也不会压到圆圈里。
  paintEllipse(reserved, size, center, center, SPAWN_CLEAR_RADIUS + 0.5, SPAWN_CLEAR_RADIUS + 0.5, 1);

  if (size >= 128) {
    const village: Landmark = { kind: 'village', name: '石溪村', x: c, z: c };
    const forest: Landmark = { kind: 'forest', name: '松影林', x: Math.round(size * 0.25), z: Math.round(size * 0.26) };
    const ruins: Landmark = { kind: 'ruins', name: '东岸遗迹', x: Math.round(size * 0.84), z: c };
    const meadow: Landmark = { kind: 'meadow', name: '南风草甸', x: Math.round(size * 0.37), z: Math.round(size * 0.76) };
    landmarks.push(village, forest, ruins, meadow);

    paintEllipse(terrain, size, forest.x, forest.z, 47 * scale, 37 * scale, Terrain.Forest);
    paintEllipse(terrain, size, forest.x + 28 * scale, forest.z - 18 * scale, 33 * scale, 22 * scale, Terrain.Forest);
    paintEllipse(terrain, size, forest.x - 17 * scale, forest.z + 18 * scale, 28 * scale, 32 * scale, Terrain.Forest);
    paintEllipse(terrain, size, meadow.x, meadow.z, 44 * scale, 33 * scale, Terrain.Meadow);
    paintEllipse(terrain, size, meadow.x + 24 * scale, meadow.z + 14 * scale, 29 * scale, 22 * scale, Terrain.Meadow);
    paintEllipse(terrain, size, ruins.x, ruins.z, 17 * scale, 14 * scale, Terrain.Stone);
    paintEllipse(terrain, size, c, c, Math.max(16, 22 * scale), Math.max(15, 19 * scale), Terrain.Village);
    paintEllipse(reserved, size, forest.x, forest.z, 4, 4, 1);
    paintEllipse(reserved, size, meadow.x, meadow.z, 7 * scale, 5 * scale, 1);
    paintEllipse(reserved, size, ruins.x, ruins.z, 4 * scale, 4 * scale, 1);

    bridges.push(...paintRiver(terrain, blocked, reserved, size, rand));
    const west = Math.round(size * 0.607);
    const east = Math.round(size * 0.785);
    const north = bridges[0].z + 2.5;
    const middle = bridges[1].z + 2.5;
    const south = bridges[2].z + 2.5;
    const road = (width: number, ...points: Point[]) => paintRoad(terrain, reserved, size, width, points);
    road(2.35, { x: c, z: middle }, { x: ruins.x + 4 * scale, z: middle });
    road(1.55, village, { x: c - 22 * scale, z: c - 6 * scale }, { x: forest.x + 22 * scale, z: forest.z + 13 * scale }, forest);
    road(1.65, village, { x: c - 7 * scale, z: c + 24 * scale }, { x: meadow.x + 10 * scale, z: meadow.z - 9 * scale }, meadow);
    road(1.45, forest, { x: forest.x + 28 * scale, z: north - 6 * scale }, { x: west, z: north });
    road(1.45, meadow, { x: meadow.x + 29 * scale, z: south + 6 * scale }, { x: west, z: south });
    road(1.45, { x: west, z: north }, { x: west + 4 * scale, z: (north + middle) / 2 }, { x: west, z: middle },
      { x: west - 5 * scale, z: (middle + south) / 2 }, { x: west, z: south });
    road(1.45, { x: east, z: north }, { x: east + 4 * scale, z: (north + middle) / 2 }, { x: east, z: middle },
      { x: east + 5 * scale, z: (middle + south) / 2 }, { x: east, z: south });
    for (const z of [north, south]) road(1.7, { x: west, z }, { x: east, z });

    // 这些建筑的入口和缺口随道路一起规划。不同种子改变周边景物，不挪动地标。
    place({ kind: 'house', x: c - 14, z: c - 15, w: 6, d: 4, h: 3.1 });
    place({ kind: 'house', x: c - 3, z: c - 20, w: 6, d: 4, h: 3.5 });
    place({ kind: 'house', x: c + 10, z: c + 12, w: 6, d: 5, h: 3.1 });
    place({ kind: 'house', x: c - 17, z: c + 9, w: 6, d: 5, h: 3.2 });
    place({ kind: 'stall', x: c + 10, z: c - 14, w: 4, d: 3, h: 2.3 });
    place({ kind: 'stall', x: c + 15, z: c - 9, w: 3, d: 3, h: 2.1 });
    place({ kind: 'fence', x: c - 18, z: c + 10, w: 1, d: 6, h: 0.95 });
    place({ kind: 'fence', x: c + 10, z: c + 18, w: 7, d: 1, h: 0.95 });
    place({ kind: 'fence', x: c - 15, z: c - 15, w: 1, d: 5, h: 0.95 });
    if (size >= 200) placeRuins(ruins, place);
    else {
      place({ kind: 'wall', x: ruins.x - 3, z: ruins.z - 5, w: 6, d: 1, h: 2.6 });
      place({ kind: 'wall', x: ruins.x - 3, z: ruins.z + 5, w: 6, d: 1, h: 2.1 });
    }
  }

  for (let i = 0; i < Math.floor(size * size / 80); i++) {
    const x = 1 + Math.floor(rand() * (size - 2));
    const z = 1 + Math.floor(rand() * (size - 2));
    const surface = terrain[z * size + x];
    if (surface === Terrain.Village || surface === Terrain.Stone || surface === Terrain.Bank) continue;
    if (size >= 128 && Math.hypot(x - center, z - center) < 23) continue;
    if (surface === Terrain.Meadow && rand() > 0.16) continue;
    if (surface === Terrain.Grass && rand() > 0.63) continue;
    const tree = surface === Terrain.Forest || (size >= 128 && rand() < 0.47);
    const w = tree ? 1 : 1 + Math.floor(rand() * 3);
    const d = tree ? 1 : 1 + Math.floor(rand() * 2);
    place({ kind: tree ? 'tree' : 'rock', x, z, w, d, h: tree ? 3.8 + rand() * 2.9 : 0.8 + rand() * 2.3 }, 1);
  }

  const forest = landmarks.find((site) => site.kind === 'forest');
  if (forest) {
    // 林区按小片取样，留出林间空隙和主路的视野。
    for (let i = 0; i < size * 2; i++) {
      const x = Math.floor(forest.x + (rand() - 0.5) * 100 * scale);
      const z = Math.floor(forest.z + (rand() - 0.5) * 80 * scale);
      if (x < 0 || x >= size || z < 0 || z >= size || terrain[z * size + x] !== Terrain.Forest) continue;
      place({ kind: 'tree', x, z, w: 1, d: 1, h: 4.1 + rand() * 3.05 }, 1);
    }
  }

  keepLandConnected(blocked, size, c * size + c, obstacles);
  return { seed, size, terrain, blocked, obstacles, bridges, landmarks };
}

function paintRect(grid: Uint8Array, size: number, { x, z, w, d }: CellRect, value: number): void {
  for (let row = z; row < z + d; row++) grid.fill(value, row * size + x, row * size + x + w);
}

function paintEllipse(grid: Uint8Array, size: number, x: number, z: number, rx: number, rz: number, value: number): void {
  for (let row = Math.max(0, Math.floor(z - rz)); row < Math.min(size, z + rz); row++) {
    for (let col = Math.max(0, Math.floor(x - rx)); col < Math.min(size, x + rx); col++) {
      if (((col + 0.5 - x) / rx) ** 2 + ((row + 0.5 - z) / rz) ** 2 <= 1) grid[row * size + col] = value;
    }
  }
}

function paintRiver(
  terrain: Uint8Array,
  blocked: Uint8Array,
  reserved: Uint8Array,
  size: number,
  random: () => number,
): Bridge[] {
  const center = Math.round(size * 0.702);
  const amplitude = Math.round(size * 0.026);
  const bends = Array.from({ length: 7 }, (_, i) => (i % 2 ? 1 : -1) * Math.round(amplitude * (0.45 + 0.55 * random())));
  const left = new Int16Array(size);
  const right = new Int16Array(size);
  for (let z = 0; z < size; z++) {
    const segment = (z * (bends.length - 1)) / (size - 1);
    const from = Math.min(bends.length - 2, Math.floor(segment));
    const x = center + Math.round(bends[from] + (bends[from + 1] - bends[from]) * (segment - from));
    left[z] = x - 3;
    right[z] = x + 3;
    for (let col = left[z] - 2; col <= right[z] + 2; col++) {
      const wet = col >= left[z] && col <= right[z];
      const index = z * size + col;
      terrain[index] = wet ? Terrain.Water : Terrain.Bank;
      blocked[index] = wet ? 1 : 0;
    }
  }

  return [Math.floor(size * 0.2), Math.floor(size / 2), Math.floor(size * 0.8)].map((row) => {
    const z = row - 2;
    const d = 5;
    const x = Math.min(...left.subarray(z, z + d)) - 2;
    const end = Math.max(...right.subarray(z, z + d)) + 3;
    const bridge = { x, z, w: end - x, d };
    paintRect(terrain, size, bridge, Terrain.Bridge);
    paintRect(blocked, size, bridge, 0);
    paintRect(reserved, size, bridge, 1);
    return bridge;
  });
}

function paintRoad(terrain: Uint8Array, reserved: Uint8Array, size: number, radius: number, points: readonly Point[]): void {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    for (let z = Math.max(0, Math.floor(Math.min(a.z, b.z) - radius)); z < Math.min(size, Math.max(a.z, b.z) + radius); z++) {
      for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius)); x < Math.min(size, Math.max(a.x, b.x) + radius); x++) {
        const index = z * size + x;
        if (terrain[index] === Terrain.Water || terrain[index] === Terrain.Bridge) continue;
        const u = x + 0.5 - a.x;
        const v = z + 0.5 - a.z;
        const t = lengthSquared > 0 ? Math.max(0, Math.min(1, (u * dx + v * dz) / lengthSquared)) : 0;
        if ((u - dx * t) ** 2 + (v - dz * t) ** 2 <= radius ** 2) {
          terrain[index] = Terrain.Road;
          reserved[index] = 1;
        }
      }
    }
  }
}

function placeRuins(site: Point, place: (obstacle: Obstacle) => void): void {
  const wall = (x: number, z: number, w: number, d: number, h: number) =>
    place({ kind: 'wall', x: site.x + x, z: site.z + z, w, d, h });
  wall(-11, -8, 2, 6, 2.55);
  wall(-11, 3, 2, 5, 2.85);
  wall(-9, -9, 7, 2, 3.15);
  wall(-2, -9, 5, 2, 2.15);
  wall(5, -9, 5, 2, 2.65);
  wall(10, -9, 2, 7, 3.3);
  wall(10, 1, 2, 8, 2.4);
  wall(-10, 8, 7, 2, 2.35);
  wall(1, 8, 9, 2, 2.8);
  for (const [x, z, h] of [[-5, -4, 3.2], [5, -4, 2.45], [-5, 4, 2.4], [5, 4, 3.2]]) wall(x, z, 2, 2, h);
}

/** 障碍物围出死胡同时，只拆掉贴着那片孤立空地的障碍，避免误删别处的景物。 */
function keepLandConnected(blocked: Uint8Array, size: number, start: number, obstacles: Obstacle[]): void {
  if (blocked.length === 0) return;
  const reached = new Uint8Array(blocked.length);
  const queue = new Int32Array(blocked.length);
  for (;;) {
    reached.fill(0);
    let count = 0;
    const visit = (index: number) => {
      if (!blocked[index] && !reached[index]) {
        reached[index] = 1;
        queue[count++] = index;
      }
    };
    visit(start);
    for (let i = 0; i < count; i++) {
      const index = queue[i];
      const x = index % size;
      if (x > 0) visit(index - 1);
      if (x < size - 1) visit(index + 1);
      if (index >= size) visit(index - size);
      if (index < blocked.length - size) visit(index + size);
    }
    if (!blocked.some((value, index) => !value && !reached[index])) return;

    const stranded = (x: number, z: number) => {
      const index = z * size + x;
      return !blocked[index] && !reached[index];
    };
    const opensPocket = ({ x, z, w, d }: Obstacle) => {
      for (let col = x; col < x + w; col++) if (stranded(col, z - 1) || stranded(col, z + d)) return true;
      for (let row = z; row < z + d; row++) if (stranded(x - 1, row) || stranded(x + w, row)) return true;
      return false;
    };
    const removable = obstacles.filter(opensPocket);
    if (removable.length === 0) throw new Error('地图上存在桥也无法连通的陆地');
    for (const obstacle of removable) paintRect(blocked, size, obstacle, 0);
    const removed = new Set(removable);
    const remaining = obstacles.filter((obstacle) => !removed.has(obstacle));
    obstacles.splice(0, obstacles.length, ...remaining);
  }
}

/** 世界坐标 (x, z) 是否在地图内且可行走。 */
export function isWalkable(map: GameMap, x: number, z: number): boolean {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  if (!(cx >= 0 && cz >= 0 && cx < map.size && cz < map.size)) return false;
  return map.blocked[cz * map.size + cx] !== 1;
}
