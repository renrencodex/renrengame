import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt 参数取自 OWASP 的推荐组合之一（N=2^15, r=8, p=3）。
// 参数和盐一起存在哈希串里，以后调高参数不影响旧密码的校验。
const COST = 1 << 15;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 3;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** 校验时接受的最大 N，防止库里的异常数据让一次校验吃掉大量内存。 */
const MAX_COST = 1 << 20;

/**
 * 同时进行的哈希数。scrypt 在 libuv 线程池（默认 4 个线程）里跑，
 * 留一个线程给文件、DNS 等其他操作，免得大量登录请求把它们堵住。
 */
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    // 有人在等就把名额直接交给它，否则归还。
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyBytes: number): Promise<Buffer> {
  return withSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, keyBytes, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => {
          if (err) reject(err);
          else resolve(key);
        });
      }),
  );
}

/** 返回形如 `scrypt$N$r$p$盐$哈希` 的字符串。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELIZATION, KEY_BYTES);
  return ['scrypt', COST, BLOCK_SIZE, PARALLELIZATION, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const paramsOk =
    Number.isInteger(n) && n >= 2 && n <= MAX_COST && (n & (n - 1)) === 0 &&
    Number.isInteger(r) && r >= 1 && r <= 32 &&
    Number.isInteger(p) && p >= 1 && p <= 16 &&
    salt.length > 0 && expected.length >= 16 && expected.length <= 64;
  if (!paramsOk) return false;
  const key = await derive(password, salt, n, r, p, expected.length);
  return timingSafeEqual(key, expected);
}
