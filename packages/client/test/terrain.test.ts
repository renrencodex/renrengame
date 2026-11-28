import { describe, expect, it } from 'vitest';
import { emptyMap, Terrain } from '@mmo/shared';
import { terrainLayers } from '../src/terrain';

describe('地形材质遮罩', () => {
  it('水面留在河道格子，桥和河岸排在水面阈值之外', () => {
    const map = emptyMap(16);
    for (let z = 3; z < 12; z++) {
      for (let x = 3; x < 9; x++) {
        map.terrain[z * map.size + x] = z === 8 ? Terrain.Bridge : Terrain.Water;
      }
    }
    const { layers } = terrainLayers(map);
    const depth = (x: number, z: number) => layers[(z * map.size + x) * 4 + 3];
    expect(depth(6, 5)).toBeGreaterThan(depth(3, 5));
    expect(depth(3, 5)).toBeGreaterThan(127);
    expect(depth(2, 5)).toBeLessThan(128);
    expect(depth(5, 8)).toBeLessThan(128);
  });

  it('按种子稳定生成，并区分泥路、石板和草地', () => {
    const map = emptyMap(32, 123);
    map.terrain.set([Terrain.Road, Terrain.Stone, Terrain.Forest], 8);
    const first = terrainLayers(map);
    const mask = (x: number) => first.layers.slice(x * 4, x * 4 + 2);
    expect(mask(8)).toEqual(Uint8Array.of(255, 0));
    expect(mask(9)).toEqual(Uint8Array.of(0, 255));
    expect(mask(10)).toEqual(Uint8Array.of(0, 0));
    expect(terrainLayers(map)).toEqual(first);
  });
});
