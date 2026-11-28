import { describe, expect, it } from 'vitest';
import { isItemId, ITEMS, sameInventory, sanitizeInventory } from '../src/index';

describe('物品', () => {
  it('isItemId 只认物品表里有的名字', () => {
    expect(isItemId('gold')).toBe(true);
    expect(isItemId('potion')).toBe(true);
    expect(isItemId('sword')).toBe(false);
    // 对象原型上的名字不算。
    expect(isItemId('constructor')).toBe(false);
    expect(isItemId('__proto__')).toBe(false);
    expect(isItemId(1)).toBe(false);
    expect(isItemId(null)).toBe(false);
  });

  it('sanitizeInventory 只留下认识的物品，数量取整并限制在上限以内', () => {
    expect(sanitizeInventory({ gold: 12, potion: 2 })).toEqual({ gold: 12, potion: 2 });
    expect(sanitizeInventory({ gold: 3.9, sword: 1 })).toEqual({ gold: 3 });
    expect(sanitizeInventory({ potion: ITEMS.potion.maxCount + 5 })).toEqual({ potion: ITEMS.potion.maxCount });
    expect(sanitizeInventory({ gold: 0, potion: -1 })).toEqual({});
    expect(sanitizeInventory({ gold: '5', potion: NaN })).toEqual({});
    expect(sanitizeInventory({ gold: Infinity })).toEqual({});
  });

  it('sanitizeInventory 遇到不是对象的值时返回空背包', () => {
    for (const value of [undefined, null, 5, 'gold', true]) {
      expect(sanitizeInventory(value)).toEqual({});
    }
    expect(sanitizeInventory([1, 2])).toEqual({});
  });

  it('sanitizeInventory 返回的是新对象', () => {
    const source = { gold: 1 };
    const result = sanitizeInventory(source);
    result.gold = 99;
    expect(source.gold).toBe(1);
  });

  it('sameInventory 把没有和 0 个当成一样', () => {
    expect(sameInventory({}, {})).toBe(true);
    expect(sameInventory({ gold: 5 }, { gold: 5 })).toBe(true);
    expect(sameInventory({ gold: 5 }, { gold: 5, potion: 0 })).toBe(true);
    expect(sameInventory({ gold: 5 }, { gold: 6 })).toBe(false);
    expect(sameInventory({ gold: 5 }, { gold: 5, potion: 1 })).toBe(false);
  });
});
