import { describe, expect, it } from 'vitest';
import { pickEntity } from '../src/picking';

describe('pickEntity', () => {
  it('点在目标的点选半径内就选中它', () => {
    const candidates = [{ id: 7, x: 100, y: 100, radius: 20 }];
    expect(pickEntity(candidates, 100, 100)).toBe(7);
    expect(pickEntity(candidates, 112, 110)).toBe(7);
    expect(pickEntity(candidates, 120, 100)).toBe(7);
  });

  it('点在半径外面时不选中任何目标', () => {
    const candidates = [{ id: 7, x: 100, y: 100, radius: 20 }];
    expect(pickEntity(candidates, 121, 100)).toBe(0);
    expect(pickEntity(candidates, 300, 300)).toBe(0);
    expect(pickEntity([], 100, 100)).toBe(0);
  });

  it('几个目标都在范围内时选离点击位置最近的', () => {
    const candidates = [
      { id: 1, x: 100, y: 100, radius: 40 },
      { id: 2, x: 130, y: 100, radius: 40 },
      { id: 3, x: 160, y: 100, radius: 40 },
    ];
    expect(pickEntity(candidates, 105, 100)).toBe(1);
    expect(pickEntity(candidates, 126, 104)).toBe(2);
    expect(pickEntity(candidates, 170, 100)).toBe(3);
  });

  it('离得更近但半径够不着的目标不算', () => {
    const candidates = [
      { id: 1, x: 100, y: 100, radius: 5 },
      { id: 2, x: 140, y: 100, radius: 40 },
    ];
    expect(pickEntity(candidates, 110, 100)).toBe(2);
  });
});
