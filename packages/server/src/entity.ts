import type { Mover, Point, ServerMsg } from '@mmo/shared';

/** 世界向某个玩家发消息的出口。世界本身不关心底层是 WebSocket 还是别的。 */
export interface Connection {
  send(msg: ServerMsg): void;
}

interface EntityBase extends Mover {
  readonly id: number;
  readonly name: string;
  readonly maxHp: number;
  hp: number;
  moving: boolean;
  dead: boolean;
  /** 正在攻击的实体，0 表示没有目标。 */
  targetId: number;
  nextAttackAt: number;
  /** 复活（玩家）或重生（怪物）的时间，只在 dead 时有意义。 */
  respawnAt: number;
}

export interface Player extends EntityBase {
  readonly kind: 'player';
  readonly conn: Connection;
  /** 已通过校验、还没寻路的目标。新的 moveTo 会覆盖旧的。 */
  pendingTarget: Point | null;
  queued: boolean;
  lastPathAt: number;
  /** 最近一次打人或挨打的时间，用来判断是否脱离战斗。 */
  lastCombatAt: number;
  nextRegenAt: number;
}

/**
 * 怪物的行为状态：
 * - idle：站在出生位置，等玩家靠近；
 * - chase：追击并攻击 targetId 指向的玩家；
 * - return：放弃追击走回出生位置，途中不受伤害。
 */
export type MonsterAiState = 'idle' | 'chase' | 'return';

export interface Monster extends EntityBase {
  readonly kind: 'monster';
  readonly homeX: number;
  readonly homeZ: number;
  ai: MonsterAiState;
  /** 是否在 AOI 里。死亡一段时间后尸体消失，到重生之前都不在。 */
  inWorld: boolean;
  nextThinkAt: number;
  nextPathAt: number;
  /** 当前追击路径的终点，目标离它太远时要重新寻路。 */
  chaseX: number;
  chaseZ: number;
  /** 尸体消失的时间。 */
  hideAt: number;
}

export type Entity = Player | Monster;
