import { describe, expect, it } from 'vitest';
import { distanceVolume, HEARING_DISTANCE, inventorySound, SoundThrottle } from '../src/sound';

describe('distanceVolume', () => {
  it('脚边最响，越远越小，到听不见的距离正好是 0', () => {
    expect(distanceVolume(0)).toBe(1);
    let last = 1;
    for (let d = 1; d < HEARING_DISTANCE; d++) {
      const v = distanceVolume(d);
      expect(v).toBeLessThan(last);
      expect(v).toBeGreaterThan(0);
      last = v;
    }
    expect(distanceVolume(HEARING_DISTANCE)).toBe(0);
    expect(distanceVolume(HEARING_DISTANCE + 50)).toBe(0);
    // 快到边上时已经很小了，声音不是突然消失的。
    expect(distanceVolume(HEARING_DISTANCE - 1)).toBeLessThan(0.01);
  });

  it('距离不是有效的数时不出声', () => {
    expect(distanceVolume(Number.NaN)).toBe(0);
    expect(distanceVolume(Infinity)).toBe(0);
    expect(distanceVolume(-1)).toBe(1);
  });
});

describe('inventorySound', () => {
  it('捡到金币是金币声，捡到别的东西是拾取声；金币和别的一起捡到时响金币声', () => {
    expect(inventorySound({ gold: 3 }, null, { gold: 8 }, null)).toBe('coin');
    expect(inventorySound({}, null, { gold: 5 }, null)).toBe('coin');
    expect(inventorySound({ gold: 3 }, null, { gold: 3, potion: 1 }, null)).toBe('pickup');
    expect(inventorySound({ gold: 3 }, 'sword', { gold: 3, sword: 1 }, 'sword')).toBe('pickup');
    expect(inventorySound({ gold: 3 }, null, { gold: 9, potion: 1 }, null)).toBe('coin');
  });

  it('喝掉药水是喝药的声音', () => {
    expect(inventorySound({ gold: 3, potion: 2 }, null, { gold: 3, potion: 1 }, null)).toBe('drink');
    expect(inventorySound({ potion: 1 }, 'sword', {}, 'sword')).toBe('drink');
  });

  it('买和卖都是硬币的声音', () => {
    expect(inventorySound({ gold: 40 }, null, { gold: 25, potion: 1 }, null)).toBe('trade');
    expect(inventorySound({ gold: 100 }, null, { sword: 1 }, null)).toBe('trade');
    expect(inventorySound({ gold: 3, potion: 2 }, null, { gold: 8, potion: 1 }, null)).toBe('trade');
    expect(inventorySound({ sword: 2 }, 'sword', { gold: 50 }, 'sword')).toBe('trade');
  });

  it('装备、卸下和没有变化时不响（装备的声音跟着 weapon 消息走）', () => {
    expect(inventorySound({ gold: 3, sword: 1 }, null, { gold: 3 }, 'sword')).toBeNull();
    expect(inventorySound({ gold: 3 }, 'sword', { gold: 3, sword: 1 }, null)).toBeNull();
    expect(inventorySound({ gold: 3, potion: 1 }, null, { gold: 3, potion: 1 }, null)).toBeNull();
    expect(inventorySound({}, null, {}, null)).toBeNull();
  });
});

describe('SoundThrottle', () => {
  it('同一种声音挨得太近时只响第一下，隔开之后又能响；不同的声音互不影响', () => {
    const throttle = new SoundThrottle();
    expect(throttle.tryStart('punch', 1000)).toBe(true);
    expect(throttle.tryStart('punch', 1010)).toBe(false);
    expect(throttle.tryStart('claw', 1010)).toBe(true);
    expect(throttle.tryStart('punch', 1060)).toBe(true);
  });

  it('刚响过的声音，更响的一下仍然放行：远处别人的一拳挡不住自己的一拳', () => {
    const throttle = new SoundThrottle();
    expect(throttle.tryStart('punch', 1000, 0.1)).toBe(true);
    expect(throttle.tryStart('punch', 1005, 0.1)).toBe(false);
    expect(throttle.tryStart('punch', 1010, 1)).toBe(true);
    // 自己的已经响了，同样响或者更轻的不再放行。
    expect(throttle.tryStart('punch', 1015, 1)).toBe(false);
    expect(throttle.tryStart('punch', 1020, 0.5)).toBe(false);
    // 间隔从第一下算起，过了就恢复正常。
    expect(throttle.tryStart('punch', 1046, 0.1)).toBe(true);
  });

  it('同时响的声音有上限，响完的让出位置', () => {
    const throttle = new SoundThrottle();
    let started = 0;
    for (let i = 0; i < 40; i++) if (throttle.tryStart('step', i * 100)) started++;
    expect(started).toBeGreaterThan(4);
    expect(started).toBeLessThan(40);
    expect(throttle.tryStart('coin', 10000)).toBe(false);
    throttle.finish();
    expect(throttle.tryStart('coin', 10000)).toBe(true);
    expect(throttle.tryStart('click', 10000)).toBe(false);
    // 多调几次 finish 也不会让上限失效。
    for (let i = 0; i < 100; i++) throttle.finish();
    started = 0;
    for (let i = 0; i < 40; i++) if (throttle.tryStart('step', 20000 + i * 100)) started++;
    expect(started).toBeLessThan(40);
  });
});
