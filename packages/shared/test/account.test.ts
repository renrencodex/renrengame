import { describe, expect, it } from 'vitest';
import { isValidPassword, isValidUsername, normalizeUsername } from '../src/index';

describe('account', () => {
  it('normalizeUsername 统一全角字符并去掉首尾空白', () => {
    expect(normalizeUsername('  ＡＢｃ１２３ ')).toBe('ABc123');
    expect(normalizeUsername('小明')).toBe('小明');
  });

  it('账号名允许中文、字母、数字和下划线', () => {
    for (const name of ['小明', 'ab', 'player_01', '侠客行123', 'a'.repeat(16), '好'.repeat(16)]) {
      expect(isValidUsername(name), name).toBe(true);
    }
  });

  it('账号名拒绝过短、过长和带特殊字符的写法', () => {
    for (const name of ['', 'a', 'a'.repeat(17), '好'.repeat(17), 'a b', 'a-b', 'a@b', '<b>hi</b>', 'a\nb', '😀😀']) {
      expect(isValidUsername(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('密码只限制长度', () => {
    expect(isValidPassword('12345')).toBe(false);
    expect(isValidPassword('123456')).toBe(true);
    expect(isValidPassword('p'.repeat(72))).toBe(true);
    expect(isValidPassword('p'.repeat(73))).toBe(false);
  });
});
