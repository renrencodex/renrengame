import { describe, expect, it } from 'vitest';
import { pickEntity, screenPickCandidate } from '../src/picking';

describe('screenPickCandidate', () => {
  it('脚和头都在画面里时，按身高算出点选圆', () => {
    // 脚在屏幕正中偏下，头在正中偏上：身高大约占画面高度的 1/4。
    const c = screenPickCandidate(
      7,
      { x: 0, y: -0.25, z: 0.2 },
      { x: 0, y: 0.25, z: 0.2 },
      800,
      600,
      22,
    );
    expect(c).toEqual({ id: 7, x: 400, y: 300, radius: 90 });
  });

  it('头落到镜头后面时不参与点选：避免点选半径盖住整块画布', () => {
    // 拉近镜头时，远处侧边的怪物脚还在视锥里，头已经穿到镜头后面；
    // 这时透视除法会把头顶坐标撑到几万像素，以前会把点空地也当成选中它。
    expect(
      screenPickCandidate(111, { x: 0.2, y: -0.1, z: -0.75 }, { x: 8, y: -12, z: 5.5 }, 1280, 720, 22),
    ).toBeNull();
  });

  it('脚在视锥外面时也不参与点选', () => {
    expect(
      screenPickCandidate(1, { x: 0, y: 0, z: -1.2 }, { x: 0, y: 0.1, z: -1.1 }, 800, 600, 22),
    ).toBeNull();
  });

  it('目标很小时至少有最小点选半径', () => {
    const c = screenPickCandidate(3, { x: 0, y: 0, z: 0.5 }, { x: 0, y: 0.01, z: 0.5 }, 800, 600, 22);
    expect(c?.radius).toBe(22);
  });
});

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
