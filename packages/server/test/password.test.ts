import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password';

describe('password', () => {
  it('正确的密码通过校验，错误的不通过', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('correct horsf', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('同一个密码每次的哈希不同，且不包含明文', async () => {
    const [a, b] = await Promise.all([hashPassword('secret-123'), hashPassword('secret-123')]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(a).not.toContain('secret-123');
  });

  it('同时算很多个哈希时都能完成', async () => {
    const hashes = await Promise.all(Array.from({ length: 8 }, (_, i) => hashPassword(`pw-${i}`)));
    const checks = await Promise.all(hashes.map((h, i) => verifyPassword(`pw-${i}`, h)));
    expect(checks.every(Boolean)).toBe(true);
  });

  it('格式不对或参数异常的哈希串一律校验失败', async () => {
    const [, , , , salt, key] = (await hashPassword('x-password')).split('$');
    for (const stored of [
      '',
      'plain-text',
      `bcrypt$32768$8$3$${salt}$${key}`,
      `scrypt$32768$8$3$${salt}`,
      `scrypt$1000$8$3$${salt}$${key}`, // N 不是 2 的幂
      `scrypt$${2 ** 30}$8$3$${salt}$${key}`, // N 大到会吃掉大量内存
      `scrypt$32768$0$3$${salt}$${key}`,
      `scrypt$32768$8$3$${salt}$`,
    ]) {
      expect(await verifyPassword('x-password', stored), stored).toBe(false);
    }
  });
});
