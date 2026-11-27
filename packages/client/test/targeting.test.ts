import { describe, expect, it } from 'vitest';
import { ATTACK_RANGE, CLIENT_ATTACK_RANGE, emptyMap, Pathfinder } from '@mmo/shared';
import { Targeting } from '../src/targeting';

function setup(blockedCells: [number, number][] = []) {
  const map = emptyMap(256);
  for (const [cx, cz] of blockedCells) map.blocked[cz * 256 + cx] = 1;
  const pathfinder = new Pathfinder(map);
  const targeting = new Targeting((ax, az, bx, bz) => pathfinder.lineOfSight(ax, az, bx, bz));
  return targeting;
}

describe('Targeting', () => {
  it('没有目标时什么都不做', () => {
    const targeting = setup();
    expect(targeting.update(0, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 })).toBeNull();
  });

  it('选中远处的目标后朝它走过去', () => {
    const targeting = setup();
    targeting.set(5);
    expect(targeting.update(0, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 })).toEqual({
      x: 110.5,
      z: 100.5,
    });
  });

  it('正在朝目标走、目标没怎么动时，不重复下达命令', () => {
    const targeting = setup();
    targeting.set(5);
    targeting.update(0, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 });
    expect(targeting.update(16, { x: 100.6, z: 100.5, moving: true }, { x: 110.5, z: 100.5 })).toBeNull();
    expect(targeting.update(1000, { x: 104, z: 100.5, moving: true }, { x: 110.9, z: 100.5 })).toBeNull();
  });

  it('目标走开后重新朝它的新位置走，但不会比固定间隔更频繁', () => {
    const targeting = setup();
    targeting.set(5);
    targeting.update(0, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 });
    // 目标移动了 2 个单位，但离上一次命令才 100 毫秒。
    expect(targeting.update(100, { x: 101, z: 100.5, moving: true }, { x: 110.5, z: 102.5 })).toBeNull();
    expect(targeting.update(260, { x: 102, z: 100.5, moving: true }, { x: 110.5, z: 103 })).toEqual({
      x: 110.5,
      z: 103,
    });
  });

  it('走到攻击距离内就原地停下，停下之后不再下达命令', () => {
    const targeting = setup();
    targeting.set(5);
    targeting.update(0, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 });
    const self = { x: 110.5 - CLIENT_ATTACK_RANGE + 0.1, z: 100.5, moving: true };
    expect(targeting.update(1500, self, { x: 110.5, z: 100.5 })).toEqual({ x: self.x, z: self.z });
    expect(targeting.update(1516, { ...self, moving: false }, { x: 110.5, z: 100.5 })).toBeNull();
  });

  it('停下的距离比服务端的攻击距离近，留出网络延迟的余量', () => {
    expect(CLIENT_ATTACK_RANGE).toBeLessThan(ATTACK_RANGE);
  });

  it('站定后目标只挪了一点时不跟着走，走远了才重新追', () => {
    const targeting = setup();
    targeting.set(5);
    const self = { x: 100.5, z: 100.5, moving: false };
    expect(targeting.update(0, self, { x: 100.5 + CLIENT_ATTACK_RANGE + 0.2, z: 100.5 })).toBeNull();
    expect(targeting.update(16, self, { x: 103.5, z: 100.5 })).toEqual({ x: 103.5, z: 100.5 });
  });

  it('离得够近但中间隔着墙时，继续绕过去而不是停下', () => {
    // 墙在格子 (101, 100)，自己在它左边，目标在它右边，直线距离 1.4。
    const targeting = setup([[101, 100]]);
    targeting.set(5);
    const order = targeting.update(0, { x: 100.8, z: 100.5, moving: false }, { x: 102.2, z: 100.5 });
    expect(order).toEqual({ x: 102.2, z: 100.5 });
    // 走的过程中也不会因为“距离够近”而停下。
    expect(targeting.update(16, { x: 100.8, z: 100.6, moving: true }, { x: 102.2, z: 100.5 })).toBeNull();
  });

  it('上一次命令没有让角色动起来时，过了间隔会再试', () => {
    const targeting = setup();
    targeting.set(5);
    targeting.update(0, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 });
    expect(targeting.update(100, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 })).toBeNull();
    expect(targeting.update(300, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 })).toEqual({
      x: 110.5,
      z: 100.5,
    });
  });

  it('换目标后立刻朝新目标走，不受间隔限制；取消目标后停止', () => {
    const targeting = setup();
    targeting.set(5);
    targeting.update(0, { x: 100.5, z: 100.5, moving: false }, { x: 110.5, z: 100.5 });
    targeting.set(6);
    expect(targeting.update(16, { x: 100.6, z: 100.5, moving: true }, { x: 100.5, z: 112.5 })).toEqual({
      x: 100.5,
      z: 112.5,
    });
    targeting.clear();
    expect(targeting.targetId).toBe(0);
    expect(targeting.update(2000, { x: 100.6, z: 100.5, moving: true }, { x: 100.5, z: 112.5 })).toBeNull();
  });
});
