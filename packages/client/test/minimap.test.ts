import { describe, expect, it } from 'vitest';
import { minimapMarker } from '../src/minimap';

describe('小地图标记', () => {
  it('以玩家为中心，东边在右、北边在上', () => {
    expect(minimapMarker(128, 128, { x: 128, z: 128 })).toEqual({ x: 0, z: 0 });
    expect(minimapMarker(128, 128, { x: 144, z: 120 })).toEqual({ x: 0.5, z: -0.25 });
  });

  it('隐藏圆形视野以外或会被边框裁掉的标记', () => {
    expect(minimapMarker(0, 0, { x: 20, z: 20 })).not.toBeNull();
    expect(minimapMarker(0, 0, { x: 21, z: 21 })).toBeNull();
    expect(minimapMarker(0, 0, { x: 30, z: 0 })).toBeNull();
  });
});
