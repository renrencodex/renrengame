import { describe, expect, it } from 'vitest';
import {
  buyProblem,
  CLIENT_SHOP_RANGE,
  ITEM_IDS,
  ITEMS,
  MAP_SIZE,
  MAX_TRADE_COUNT,
  maxBuy,
  merchantPosition,
  nearMerchant,
  SAFE_ZONE_RADIUS,
  sellProblem,
  SHOP_GOODS,
  SHOP_RANGE,
  SPAWN_CLEAR_RADIUS,
} from '../src';

const POTION = ITEMS.potion.buyPrice as number;
const SWORD = ITEMS.sword.buyPrice as number;

describe('商人的位置', () => {
  it('在安全区里，他周围能买卖的范围都在出生点的空地里，不会有墙', () => {
    const m = merchantPosition(MAP_SIZE);
    const fromCenter = Math.hypot(m.x - MAP_SIZE / 2, m.z - MAP_SIZE / 2);
    expect(fromCenter).toBeLessThan(SAFE_ZONE_RADIUS);
    expect(fromCenter + SHOP_RANGE).toBeLessThan(SPAWN_CLEAR_RADIUS);
  });

  it('客户端打开商店的距离比服务器认可的距离小', () => {
    expect(CLIENT_SHOP_RANGE).toBeLessThan(SHOP_RANGE);
  });

  it('nearMerchant 按到商人的直线距离判断', () => {
    const m = merchantPosition(MAP_SIZE);
    expect(nearMerchant(MAP_SIZE, m.x, m.z)).toBe(true);
    expect(nearMerchant(MAP_SIZE, m.x + SHOP_RANGE, m.z)).toBe(true);
    expect(nearMerchant(MAP_SIZE, m.x + SHOP_RANGE + 0.01, m.z)).toBe(false);
    expect(nearMerchant(MAP_SIZE, m.x + SHOP_RANGE, m.z, CLIENT_SHOP_RANGE)).toBe(false);
    expect(nearMerchant(MAP_SIZE, m.x, m.z - CLIENT_SHOP_RANGE, CLIENT_SHOP_RANGE)).toBe(true);
  });
});

describe('价格', () => {
  it('商人卖药水和剑，不卖金币', () => {
    expect(SHOP_GOODS).toEqual(['potion', 'sword']);
  });

  it('每种东西的回收价都比卖价低，倒手刷不出金币', () => {
    for (const id of ITEM_IDS) {
      const { buyPrice, sellPrice } = ITEMS[id];
      if (buyPrice !== undefined) expect(buyPrice, id).toBeGreaterThan(0);
      if (sellPrice !== undefined) expect(sellPrice, id).toBeGreaterThan(0);
      if (buyPrice !== undefined && sellPrice !== undefined) expect(sellPrice, id).toBeLessThan(buyPrice);
    }
  });

  it('金币本身不能买也不能卖', () => {
    expect(ITEMS.gold.buyPrice).toBeUndefined();
    expect(ITEMS.gold.sellPrice).toBeUndefined();
  });
});

describe('buyProblem', () => {
  it('金币刚好够就能买', () => {
    expect(buyProblem({ gold: POTION }, 'potion', 1)).toBeNull();
    expect(buyProblem({ gold: POTION * 3 }, 'potion', 3)).toBeNull();
    expect(buyProblem({ gold: SWORD }, 'sword', 1)).toBeNull();
  });

  it('金币差一个就买不了', () => {
    expect(buyProblem({ gold: POTION - 1 }, 'potion', 1)).toBe('gold');
    expect(buyProblem({ gold: POTION * 3 - 1 }, 'potion', 3)).toBe('gold');
    expect(buyProblem({}, 'sword', 1)).toBe('gold');
  });

  it('背包里放不下时买不了，钱再多也一样', () => {
    const max = ITEMS.potion.maxCount;
    expect(buyProblem({ gold: 9999, potion: max }, 'potion', 1)).toBe('full');
    expect(buyProblem({ gold: 9999, potion: max - 2 }, 'potion', 3)).toBe('full');
    expect(buyProblem({ gold: 9999, potion: max - 2 }, 'potion', 2)).toBeNull();
    expect(buyProblem({ gold: 9999, sword: ITEMS.sword.maxCount }, 'sword', 1)).toBe('full');
  });

  it('商人不卖的东西、不像话的数量都不行', () => {
    expect(buyProblem({ gold: 9999 }, 'gold', 1)).toBe('invalid');
    for (const count of [0, -1, 1.5, NaN, Infinity, MAX_TRADE_COUNT + 1]) {
      expect(buyProblem({ gold: 999999 }, 'potion', count), String(count)).toBe('invalid');
    }
  });
});

describe('maxBuy', () => {
  it('取金币、背包空位和单次上限里最小的那个', () => {
    expect(maxBuy({}, 'potion')).toBe(0);
    expect(maxBuy({ gold: POTION * 2 + 3 }, 'potion')).toBe(2);
    expect(maxBuy({ gold: 99999, potion: ITEMS.potion.maxCount - 3 }, 'potion')).toBe(3);
    expect(maxBuy({ gold: 99999, potion: ITEMS.potion.maxCount }, 'potion')).toBe(0);
    expect(maxBuy({ gold: 99999 }, 'potion')).toBe(Math.min(ITEMS.potion.maxCount, MAX_TRADE_COUNT));
    expect(maxBuy({ gold: 99999 }, 'gold')).toBe(0);
  });

  it('maxBuy 说能买几个，buyProblem 就认几个，多一个都不行', () => {
    for (const items of [{ gold: 47 }, { gold: 1000, potion: 18 }, { gold: 230, sword: 3 }]) {
      for (const id of SHOP_GOODS) {
        const n = maxBuy(items, id);
        if (n > 0) expect(buyProblem(items, id, n)).toBeNull();
        if (n < MAX_TRADE_COUNT) expect(buyProblem(items, id, n + 1)).not.toBeNull();
      }
    }
  });
});

describe('sellProblem', () => {
  it('背包里有就能卖', () => {
    expect(sellProblem({ potion: 2 }, 'potion', 1)).toBeNull();
    expect(sellProblem({ potion: 2 }, 'potion', 2)).toBeNull();
    expect(sellProblem({ sword: 1 }, 'sword', 1)).toBeNull();
  });

  it('不够数卖不了', () => {
    expect(sellProblem({ potion: 2 }, 'potion', 3)).toBe('missing');
    expect(sellProblem({}, 'sword', 1)).toBe('missing');
  });

  it('金币不能卖，数量不像话也不行', () => {
    expect(sellProblem({ gold: 100 }, 'gold', 1)).toBe('invalid');
    for (const count of [0, -1, 0.5, NaN, MAX_TRADE_COUNT + 1]) {
      expect(sellProblem({ potion: 20 }, 'potion', count), String(count)).toBe('invalid');
    }
  });

  it('金币已经到上限时卖不了，不会白白丢掉东西', () => {
    expect(sellProblem({ gold: ITEMS.gold.maxCount, potion: 1 }, 'potion', 1)).toBe('full');
    expect(sellProblem({ gold: ITEMS.gold.maxCount - (ITEMS.potion.sellPrice as number), potion: 1 }, 'potion', 1)).toBeNull();
  });
});
