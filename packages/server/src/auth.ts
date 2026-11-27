import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import {
  isValidPassword,
  isValidUsername,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '@mmo/shared';
import type { ApiError, ApiErrorCode, AuthSuccess } from '@mmo/shared';
import { hashPassword, verifyPassword } from './password';
import { KEY_PREFIX } from './redis';
import type { Redis } from './redis';

/** 会话有效期。每次用令牌进入游戏都会重新计时。 */
const SESSION_TTL_S = 7 * 24 * 3600;
/** 同一个账号在这段时间内最多尝试登录这么多次，成功登录后清零。 */
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_ATTEMPT_WINDOW_S = 15 * 60;

/** 存在 Redis 里的会话内容。 */
export interface Session {
  accountId: number;
  characterId: number;
  name: string;
}

export type AuthResult = ({ ok: true } & AuthSuccess) | ({ ok: false; status: number } & ApiError);

function fail(status: number, error: ApiErrorCode, message: string): AuthResult {
  return { ok: false, status, error, message };
}

/** Redis 里只存令牌的哈希：即使 Redis 的数据泄露，也拿不到能直接用的令牌。 */
function sessionKey(token: string): string {
  return `${KEY_PREFIX}session:${createHash('sha256').update(token).digest('hex')}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown }).code === '23505';
}

/**
 * 账号注册、登录和会话。
 * 账号存在 PostgreSQL，会话令牌和登录尝试次数存在 Redis。
 */
export class Auth {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: Pool,
    private readonly redis: Redis,
  ) {}

  async register(usernameInput: unknown, password: unknown): Promise<AuthResult> {
    if (typeof usernameInput !== 'string' || typeof password !== 'string') {
      return fail(400, 'bad_request', '请求格式不正确。');
    }
    const username = normalizeUsername(usernameInput);
    if (!isValidUsername(username)) {
      return fail(
        400,
        'invalid_username',
        `账号名需要 ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} 个字符，只能用文字、数字和下划线。`,
      );
    }
    if (!isValidPassword(password)) {
      return fail(400, 'invalid_password', `密码需要 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位。`);
    }

    const taken = fail(409, 'username_taken', '这个账号名已经被注册了。');
    // 先查一次，名字被占用时不用白算一次密码哈希。并发注册同名账号由唯一索引兜底。
    const existing = await this.db.query('SELECT 1 FROM accounts WHERE lower(username) = lower($1)', [username]);
    if (existing.rows.length > 0) return taken;

    const passwordHash = await hashPassword(password);
    let row: { account_id: number; character_id: number };
    try {
      // 账号和角色在同一条语句里创建，要么都成功要么都不存在。
      const res = await this.db.query<{ account_id: number; character_id: number }>(
        `WITH a AS (
           INSERT INTO accounts (username, password_hash, last_login_at)
           VALUES ($1, $2, now())
           RETURNING id
         )
         INSERT INTO characters (account_id, name)
         SELECT id, $1 FROM a
         RETURNING account_id, id AS character_id`,
        [username, passwordHash],
      );
      row = res.rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) return taken;
      throw err;
    }

    const token = await this.createSession({ accountId: row.account_id, characterId: row.character_id, name: username });
    return { ok: true, token, name: username };
  }

  async login(usernameInput: unknown, password: unknown): Promise<AuthResult> {
    if (typeof usernameInput !== 'string' || typeof password !== 'string') {
      return fail(400, 'bad_request', '请求格式不正确。');
    }
    // 账号不存在和密码错误返回同样的结果，不透露账号是否存在。
    const badCredentials = fail(401, 'bad_credentials', '账号或密码不正确。');
    const username = normalizeUsername(usernameInput);
    if (!isValidUsername(username) || !isValidPassword(password)) return badCredentials;

    // 先计数再校验：并发的大量尝试也只有前几次能真正走到密码校验。
    const attemptsKey = `${KEY_PREFIX}login-attempts:${username.toLowerCase()}`;
    const [attempts] = await this.redis
      .multi()
      .incr(attemptsKey)
      .expire(attemptsKey, LOGIN_ATTEMPT_WINDOW_S, 'NX')
      .exec();
    if (Number(attempts) > MAX_LOGIN_ATTEMPTS) {
      return fail(429, 'too_many_attempts', '尝试登录的次数太多，请 15 分钟后再试。');
    }

    const res = await this.db.query<{ account_id: number; password_hash: string; character_id: number; name: string }>(
      `SELECT a.id AS account_id, a.password_hash, c.id AS character_id, c.name
       FROM accounts a
       JOIN characters c ON c.account_id = a.id
       WHERE lower(a.username) = lower($1)`,
      [username],
    );
    const row = res.rows.at(0);
    // 账号不存在时也算一次哈希，让两种失败的耗时接近。
    const matches = await verifyPassword(password, row?.password_hash ?? (await this.getDummyHash()));
    if (!row || !matches) return badCredentials;

    await this.redis.del(attemptsKey);
    await this.db.query('UPDATE accounts SET last_login_at = now() WHERE id = $1', [row.account_id]);
    const token = await this.createSession({ accountId: row.account_id, characterId: row.character_id, name: row.name });
    return { ok: true, token, name: row.name };
  }

  /** 用令牌取会话，并把有效期重新计时。令牌无效或过期时返回 null。 */
  async resolveSession(token: string): Promise<Session | null> {
    const raw = await this.redis.getEx(sessionKey(token), { type: 'EX', value: SESSION_TTL_S });
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as Partial<Session>;
      if (
        Number.isInteger(value.accountId) &&
        Number.isInteger(value.characterId) &&
        typeof value.name === 'string'
      ) {
        return value as Session;
      }
    } catch {
      // 内容损坏的会话当作无效处理。
    }
    return null;
  }

  async logout(token: string): Promise<void> {
    await this.redis.del(sessionKey(token));
  }

  private async createSession(session: Session): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.redis.set(sessionKey(token), JSON.stringify(session), {
      expiration: { type: 'EX', value: SESSION_TTL_S },
    });
    return token;
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    return this.dummyHash;
  }
}
