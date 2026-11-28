import type { Inventory, ItemId, Mover, Point, ServerMsg } from '@mmo/shared';

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
  /** 背包。数量为 0 的物品不留在里面。 */
  inventory: Inventory;
  /** 手里拿的武器，空手是 null。它不算在背包里。 */
  weapon: ItemId | null;
  /** 下一次能喝药水的时间。 */
  nextPotionAt: number;
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

/** 掉在地上的物品。它和玩家、怪物共用 id 和视野机制，但不会动，也不出现在快照里。 */
export interface Drop {
  readonly kind: 'drop';
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly item: ItemId;
  readonly count: number;
  /** 这个时间之前捡不起来，让客户端来得及把它显示出来。 */
  readonly pickableAt: number;
  /** 到这个时间还没人捡就消失。 */
  readonly expireAt: number;
}

/** 会走会打的实体。 */
export type Character = Player | Monster;

export type Entity = Character | Drop;
