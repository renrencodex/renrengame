import { describe, expect, it } from 'vitest';
import { generateMap, isWalkable, MAP_SIZE, merchantPosition, Pathfinder, SHOP_RANGE, SPAWN_CLEAR_RADIUS, Terrain } from '../src/index';
import type { GameMap } from '../src/index';

function reachable({ size, blocked }: GameMap, start: number, canVisit = (i: number) => blocked[i] === 0): Set<number> {
  const visited = new Set<number>([start]);
  const queue = [start];
  const visit = (i: number) => {
    if (!canVisit(i) || visited.has(i)) return;
    visited.add(i);
    queue.push(i);
  };
  for (const i of queue) {
    const x = i % size;
    if (x > 0) visit(i - 1);
    if (x < size - 1) visit(i + 1);
    if (i >= size) visit(i - size);
    if (i < size * (size - 1)) visit(i + size);
  }
  return visited;
}

describe('探索地图', () => {
  it.each([1, 99, 12345, 20261127])('种子 %i 的空地都能从村庄到达', (seed) => {
    const map = generateMap(seed);
    const c = map.size / 2;
    const land = map.blocked.reduce((total, value) => total + (value === 0 ? 1 : 0), 0);
    expect(reachable(map, c * map.size + c).size).toBe(land);
  });

  it('三座五格宽的桥分别连通河岸，桥外的水面不可走', () => {
    const map = generateMap(20261127);
    const c = map.size / 2;
    const pathfinder = new Pathfinder(map);
    expect(map.bridges).toHaveLength(3);
    expect(map.bridges.map((b) => b.z)).toEqual([49, 126, 202]);
    for (const { x, z, w, d } of map.bridges) {
      expect(d).toBe(5);
      for (let row = z; row < z + d; row++) {
        expect(pathfinder.lineOfSight(x + 0.5, row + 0.5, x + w - 0.5, row + 0.5)).toBe(true);
        for (let col = x; col < x + w; col++) expect(map.terrain[row * map.size + col]).toBe(Terrain.Bridge);
      }
    }
    const badWater = map.terrain.findIndex((surface, i) => surface === Terrain.Water && map.blocked[i] === 0);
    expect(badWater).toBe(-1);
    const westBank = reachable(map, c * map.size + c, (i) => map.blocked[i] === 0 && map.terrain[i] !== Terrain.Bridge);
    expect(westBank.has(c * map.size + map.size - 1)).toBe(false);
  });

  it('主路连接村庄、林地、遗迹和草甸，也通往每座桥', () => {
    const map = generateMap(20261127);
    const c = map.size / 2;
    expect(map.size).toBe(MAP_SIZE);
    expect(map.landmarks.map((site) => site.kind)).toEqual(['village', 'forest', 'ruins', 'meadow']);
    const roads = reachable(map, c * map.size + c, (i) =>
      map.blocked[i] === 0 && (map.terrain[i] === Terrain.Road || map.terrain[i] === Terrain.Bridge));
    for (const site of map.landmarks) expect(roads.has(site.z * map.size + site.x), site.name).toBe(true);
    for (const bridge of map.bridges) expect(roads.has(bridge.z * map.size + bridge.x)).toBe(true);
    for (const kind of ['tree', 'rock', 'house', 'stall', 'fence', 'wall']) {
      expect(map.obstacles.some((o) => o.kind === kind), kind).toBe(true);
    }
  });

  it('出生区域和商人的交易范围留空', () => {
    const map = generateMap(20261127);
    const c = map.size / 2;
    const merchant = merchantPosition(map.size);
    for (let z = c - SPAWN_CLEAR_RADIUS; z <= c + SPAWN_CLEAR_RADIUS; z++) {
      for (let x = c - SPAWN_CLEAR_RADIUS; x <= c + SPAWN_CLEAR_RADIUS; x++) {
        if (Math.hypot(x + 0.5 - c, z + 0.5 - c) <= SPAWN_CLEAR_RADIUS ||
          Math.hypot(x + 0.5 - merchant.x, z + 0.5 - merchant.z) <= SHOP_RANGE) {
          expect(isWalkable(map, x + 0.5, z + 0.5)).toBe(true);
        }
      }
    }
  });
});
