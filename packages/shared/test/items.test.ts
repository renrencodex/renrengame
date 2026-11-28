import { describe, expect, it } from 'vitest';
import {
  attackDamage,
  isItemId,
  ITEMS,
  PLAYER_ATTACK_DAMAGE,
  sameInventory,
  sanitizeInventory,
  sanitizeWeapon,
} from '../src/index';

describe('物品', () => {
  it('isItemId 只认物品表里有的名字', () => {
    expect(isItemId('gold')).toBe(true);
    expect(isItemId('potion')).toBe(true);
    expect(isItemId('sword')).toBe(true);
    expect(isItemId('wand')).toBe(false);
    // 对象原型上的名字不算。
    expect(isItemId('constructor')).toBe(false);
    expect(isItemId('__proto__')).toBe(false);
    expect(isItemId(1)).toBe(false);
    expect(isItemId(null)).toBe(false);
  });

  it('sanitizeInventory 只留下认识的物品，数量取整并限制在上限以内', () => {
    expect(sanitizeInventory({ gold: 12, potion: 2, sword: 1 })).toEqual({ gold: 12, potion: 2, sword: 1 });
    expect(sanitizeInventory({ gold: 3.9, wand: 1 })).toEqual({ gold: 3 });
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
    expect(sameInventory({ sword: 1 }, {})).toBe(false);
  });
});

describe('武器', () => {
  it('sanitizeWeapon 只认物品表里的武器，其他的都当作空手', () => {
    expect(sanitizeWeapon('sword')).toBe('sword');
    // 是物品但不是武器。
    expect(sanitizeWeapon('potion')).toBeNull();
    expect(sanitizeWeapon('gold')).toBeNull();
    for (const value of [undefined, null, '', 'wand', 'constructor', 1, { sword: 1 }]) {
      expect(sanitizeWeapon(value)).toBeNull();
    }
  });

  it('attackDamage：空手是基础伤害，拿着武器再加上武器的攻击力', () => {
    expect(attackDamage(null)).toBe(PLAYER_ATTACK_DAMAGE);
    expect(attackDamage('sword')).toBe(PLAYER_ATTACK_DAMAGE + ITEMS.sword.weapon!.damage);
    expect(attackDamage('sword')).toBeGreaterThan(attackDamage(null));
    // 不是武器的物品不加伤害。
    expect(attackDamage('potion')).toBe(PLAYER_ATTACK_DAMAGE);
  });
});
