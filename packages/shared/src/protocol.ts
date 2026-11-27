import { MAX_NAME_LENGTH, MAX_TOKEN_LENGTH } from './constants';

export type EntityKind = 'player' | 'monster';

/** 实体在快照里的状态。 */
export const STATE_IDLE = 0;
export const STATE_MOVING = 1;
export const STATE_DEAD = 2;
export type EntityState = typeof STATE_IDLE | typeof STATE_MOVING | typeof STATE_DEAD;

/** 实体进入视野时下发的完整信息。 */
export interface EntityInfo {
  id: number;
  kind: EntityKind;
  name: string;
  x: number;
  z: number;
  state: EntityState;
  hp: number;
  maxHp: number;
}

/** 快照里的一个实体，用元组以减小体积。 */
export type SnapEntity = [id: number, x: number, z: number, state: EntityState, hp: number];

export type ClientMsg =
  /** token 是登录接口返回的会话令牌，服务端用它确定是哪个角色。 */
  | { t: 'join'; token: string }
  | { t: 'moveTo'; x: number; z: number }
  /** 选中一个怪物作为攻击目标。id 为 0 表示取消目标。 */
  | { t: 'target'; id: number }
  | { t: 'ping'; c: number };

export type ServerMsg =
  | { t: 'welcome'; selfId: number; seed: number; serverTime: number }
  | { t: 'enter'; entities: EntityInfo[] }
  | { t: 'leave'; ids: number[] }
  | { t: 'snap'; time: number; entities: SnapEntity[] }
  /** 一次命中。只用来播放动作和显示伤害数字，血量以快照为准。 */
  | { t: 'hit'; from: number; to: number; damage: number }
  | { t: 'pong'; c: number; s: number };

// 编解码都收在这里，以后换成二进制协议只需要改这个文件。

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

/** 解析并校验客户端消息。格式不对时返回 null。 */
export function decodeClientMsg(raw: string): ClientMsg | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case 'join':
      return typeof m.token === 'string' && m.token.length > 0 && m.token.length <= MAX_TOKEN_LENGTH
        ? { t: 'join', token: m.token }
        : null;
    case 'moveTo':
      return isFiniteNumber(m.x) && isFiniteNumber(m.z) ? { t: 'moveTo', x: m.x, z: m.z } : null;
    case 'target':
      return Number.isSafeInteger(m.id) && (m.id as number) >= 0 ? { t: 'target', id: m.id as number } : null;
    case 'ping':
      return isFiniteNumber(m.c) ? { t: 'ping', c: m.c } : null;
    default:
      return null;
  }
}

/** 解析服务端消息。服务端是可信的，这里只防 JSON 损坏。 */
export function decodeServerMsg(raw: string): ServerMsg | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || typeof (value as { t?: unknown }).t !== 'string') return null;
    return value as ServerMsg;
  } catch {
    return null;
  }
}

/** 去掉控制字符和首尾空白，并限制长度。结果为空时用 fallback。 */
export function sanitizeName(name: string, fallback: string): string {
  const cleaned = Array.from(name.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .slice(0, MAX_NAME_LENGTH)
    .join('');
  return cleaned.length > 0 ? cleaned : fallback;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
