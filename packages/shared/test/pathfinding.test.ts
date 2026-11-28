import { describe, expect, it } from 'vitest';
import {
  emptyMap,
  generateMap,
  isValidMoveTarget,
  isWalkable,
  MAX_MOVE_DISTANCE,
  MOVE_SPEED,
  mulberry32,
  Pathfinder,
  setPath,
  stepMover,
} from '../src/index';
import type { GameMap, Mover, Point } from '../src/index';

function mapWithWalls(size: number, cells: Array<[number, number]>): GameMap {
  const map = emptyMap(size);
  for (const [cx, cz] of cells) map.blocked[cz * size + cx] = 1;
  return map;
}

/** 沿折线密集取样，确认每个点都在可行走的格子里。 */
function expectPathWalkable(map: GameMap, path: Point[]): void {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.02);
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (!isWalkable(map, x, z)) throw new Error(`path enters a blocked cell at (${x}, ${z})`);
    }
  }
}

function pathLength(path: Point[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return len;
}

describe('generateMap', () => {
  it('同一个种子生成完全相同的地图', () => {
    const a = generateMap(12345);
    const b = generateMap(12345);
    expect(Array.from(a.blocked)).toEqual(Array.from(b.blocked));
    expect(a.terrain).toEqual(b.terrain);
    expect(a.obstacles).toEqual(b.obstacles);
    expect(a.bridges).toEqual(b.bridges);
    expect(a.landmarks).toEqual(b.landmarks);
    expect(a.obstacles.length).toBeGreaterThan(100);
  });

  it('不同种子生成不同的地图', () => {
    expect(generateMap(1).obstacles).not.toEqual(generateMap(2).obstacles);
  });

  it('地图中心的出生区域没有障碍物', () => {
    const map = generateMap(777);
    const c = map.size / 2;
    for (let dz = -10; dz <= 10; dz++) {
      for (let dx = -10; dx <= 10; dx++) {
        if (Math.hypot(dx, dz) <= 10) expect(isWalkable(map, c + dx, c + dz)).toBe(true);
      }
    }
  });
});

describe('Pathfinder', () => {
  it('空地上直接走直线', () => {
    const pf = new Pathfinder(emptyMap(32));
    expect(pf.findPath(2.5, 2.5, 20.25, 11.75)).toEqual([
      { x: 2.5, z: 2.5 },
      { x: 20.25, z: 11.75 },
    ]);
  });

  it('绕开挡在中间的墙', () => {
    // x = 10 处一堵墙，只在 z = 15 留一个缺口。
    const wall: Array<[number, number]> = [];
    for (let z = 0; z < 20; z++) if (z !== 15) wall.push([10, z]);
    const map = mapWithWalls(20, wall);
    const pf = new Pathfinder(map);

    const path = pf.findPath(5.5, 3.5, 15.5, 3.5);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 5.5, z: 3.5 });
    expect(path![path!.length - 1]).toEqual({ x: 15.5, z: 3.5 });
    // 路径不穿墙，所以只能从缺口绕过去。
    expectPathWalkable(map, path!);
    // 平滑之后只剩少数几个拐点，长度接近最短的绕行距离（约 26）。
    expect(path!.length).toBeLessThanOrEqual(6);
    expect(pathLength(path!)).toBeGreaterThan(25);
    expect(pathLength(path!)).toBeLessThan(28);
  });

  it('不会斜着擦过障碍物的角', () => {
    const map = mapWithWalls(8, [
      [3, 3],
      [4, 4],
    ]);
    const pf = new Pathfinder(map);
    const path = pf.findPath(3.5, 4.5, 4.5, 3.5);
    expect(path).not.toBeNull();
    expectPathWalkable(map, path!);
  });

  it('终点被围住时返回 null', () => {
    const ring: Array<[number, number]> = [];
    for (let i = 9; i <= 11; i++) {
      ring.push([i, 9], [i, 11]);
    }
    ring.push([9, 10], [11, 10]);
    const pf = new Pathfinder(mapWithWalls(20, ring));
    expect(pf.findPath(2.5, 2.5, 10.5, 10.5)).toBeNull();
  });

  it('终点在障碍物里、在地图外或不是有效数字时返回 null', () => {
    const pf = new Pathfinder(mapWithWalls(20, [[10, 10]]));
    expect(pf.findPath(2.5, 2.5, 10.5, 10.5)).toBeNull();
    expect(pf.findPath(2.5, 2.5, -1, 5)).toBeNull();
    expect(pf.findPath(2.5, 2.5, 20, 5)).toBeNull();
    expect(pf.findPath(2.5, 2.5, Number.NaN, 5)).toBeNull();
  });

  it('搜索超出展开上限时返回 null', () => {
    const wall: Array<[number, number]> = [];
    for (let z = 0; z < 39; z++) wall.push([20, z]);
    const pf = new Pathfinder(mapWithWalls(40, wall));
    expect(pf.findPath(10.5, 2.5, 30.5, 2.5, 50)).toBeNull();
    expect(pf.findPath(10.5, 2.5, 30.5, 2.5)).not.toBeNull();
  });

  it('在生成的地图上，随机路径始终走在可行走的格子里', () => {
    const map = generateMap(20261127);
    const pf = new Pathfinder(map);
    const rand = mulberry32(42);
    let found = 0;
    for (let i = 0; i < 300; i++) {
      const sx = rand() * map.size;
      const sz = rand() * map.size;
      const angle = rand() * Math.PI * 2;
      const dist = rand() * MAX_MOVE_DISTANCE;
      const tx = sx + Math.cos(angle) * dist;
      const tz = sz + Math.sin(angle) * dist;
      if (!isWalkable(map, sx, sz) || !isValidMoveTarget(map, sx, sz, tx, tz)) continue;
      const path = pf.findPath(sx, sz, tx, tz);
      if (!path) continue;
      found++;
      expect(path[0]).toEqual({ x: sx, z: sz });
      expect(path[path.length - 1]).toEqual({ x: tx, z: tz });
      expectPathWalkable(map, path);
    }
    expect(found).toBeGreaterThan(150);
  });

  it('同样的输入得到同样的路径', () => {
    const map = generateMap(99);
    const a = new Pathfinder(map).findPath(128.2, 128.7, 160.4, 101.3);
    const b = new Pathfinder(map).findPath(128.2, 128.7, 160.4, 101.3);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });
});

describe('movement', () => {
  it('按速度沿路径前进并停在终点', () => {
    const m: Mover = { x: 0, z: 0, path: null, pathIndex: 0 };
    setPath(m, [
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 3, z: 4 },
    ]);
    const dt = 0.05;
    let ticks = 0;
    while (stepMover(m, MOVE_SPEED * dt)) ticks++;
    expect(m).toMatchObject({ x: 3, z: 4, path: null });
    // 总长 7，速度 6，约 1.17 秒，也就是 23 到 24 个 tick。
    expect(ticks).toBeGreaterThanOrEqual(22);
    expect(ticks).toBeLessThanOrEqual(24);
  });

  it('isValidMoveTarget 拒绝太远、不可行走和无效的目标', () => {
    const map = mapWithWalls(256, [[50, 50]]);
    expect(isValidMoveTarget(map, 10, 10, 40, 40)).toBe(true);
    expect(isValidMoveTarget(map, 10, 10, 10 + MAX_MOVE_DISTANCE + 0.5, 10)).toBe(false);
    expect(isValidMoveTarget(map, 40, 40, 50.5, 50.5)).toBe(false);
    expect(isValidMoveTarget(map, 10, 10, -0.5, 10)).toBe(false);
    expect(isValidMoveTarget(map, 10, 10, Number.NaN, 10)).toBe(false);
    expect(isValidMoveTarget(map, 10, 10, Infinity, 10)).toBe(false);
  });
});
