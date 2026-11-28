import {
  AOI_CELL_SIZE,
  ATTACK_RANGE,
  attackDamage,
  buyProblem,
  DROP_LIFETIME_MS,
  DROP_PICKUP_DELAY_MS,
  DROP_SCATTER_RADIUS,
  GOLD_DROP_MAX,
  GOLD_DROP_MIN,
  isValidMoveTarget,
  isWalkable,
  ITEMS,
  MAP_LAYOUT_VERSION,
  MAX_PATHFINDS_PER_TICK,
  MONSTER_MAX_HP,
  MONSTER_NAME,
  MOVE_MIN_INTERVAL_MS,
  MOVE_SPEED,
  mulberry32,
  nearMerchant,
  Pathfinder,
  PICKUP_RADIUS,
  PLAYER_ATTACK_INTERVAL_MS,
  PLAYER_MAX_HP,
  PLAYER_RESPAWN_MS,
  POTION_COOLDOWN_MS,
  POTION_DROP_CHANCE,
  POTION_HEAL,
  REGEN_DELAY_MS,
  REGEN_PER_SECOND,
  SAFE_ZONE_RADIUS,
  sanitizeInventory,
  sanitizeName,
  sanitizeWeapon,
  sellProblem,
  setPath,
  SNAPSHOT_EVERY_TICKS,
  SPAWN_RADIUS,
  STATE_DEAD,
  STATE_IDLE,
  STATE_MOVING,
  stepMover,
  SWORD_DROP_CHANCE,
  TICK_RATE,
} from '@mmo/shared';
import type {
  CharacterInfo,
  EntityInfo,
  EntityState,
  GameMap,
  Inventory,
  ItemId,
  Point,
  ServerMsg,
  SnapEntity,
} from '@mmo/shared';
import { AoiGrid } from './aoi';
import type { CellChange } from './aoi';
import { DropGrid } from './drops';
import type { Character, Connection, Drop, Entity, Monster, MonsterAiState, Player } from './entity';
import { MonsterAi } from './monsterAi';
import type { AiHost } from './monsterAi';

export type { Connection } from './entity';

export interface WorldStats {
  /** 累计完成的玩家寻路次数。 */
  pathfinds: number;
  /** 因为每 tick 上限或个人间隔而推迟到后面 tick 的次数。 */
  deferredPathfinds: number;
  /** 没通过校验的 moveTo 数量。 */
  rejectedMoves: number;
  /** 累计的命中次数（玩家打怪物和怪物打玩家）。 */
  hits: number;
  /** 累计掉到地上的物品堆数。 */
  dropped: number;
  /** 累计被捡起的物品堆数。 */
  pickedUp: number;
  /** 累计从商人那里买的、卖给商人的物品个数。 */
  bought: number;
  sold: number;
}

export interface PlayerState {
  name: string;
  x: number;
  z: number;
  moving: boolean;
  hp: number;
  dead: boolean;
  /** 背包内容的一份拷贝。 */
  items: Inventory;
  /** 手里拿的武器，空手是 null。 */
  weapon: ItemId | null;
}

export interface MonsterState {
  x: number;
  z: number;
  moving: boolean;
  hp: number;
  dead: boolean;
  ai: MonsterAiState;
  /** 是否还在场上。尸体消失之后到重生之前为 false。 */
  inWorld: boolean;
}

const DT = 1 / TICK_RATE;
const REGEN_INTERVAL_MS = 1000 / REGEN_PER_SECOND;
/** 生成怪物时，离安全区边缘至少这么远，怪物之间至少隔这么远。 */
const MONSTER_SAFE_ZONE_MARGIN = 6;
const MONSTER_SPACING = 8;
/** 拾取索引的小格边长，不能小于拾取半径。 */
const DROP_CELL_SIZE = Math.max(2, PICKUP_RADIUS);
/** 掉落物离尸体至少这么远，免得和尸体叠在一起看不清。 */
const DROP_SCATTER_MIN = 0.5;

/**
 * 权威的游戏世界：所有位置、血量、物品和金币都由这里计算，
 * 客户端只能提交“想去哪”“想打谁”“想用什么”“想拿哪件武器”“想买卖什么”。
 */
export class World {
  readonly map: GameMap;
  readonly stats: WorldStats = {
    pathfinds: 0,
    deferredPathfinds: 0,
    rejectedMoves: 0,
    hits: 0,
    dropped: 0,
    pickedUp: 0,
    bought: 0,
    sold: 0,
  };
  private readonly pathfinder: Pathfinder;
  /** 怪物用的寻路器：安全区里的格子在它眼里也是障碍。 */
  private readonly monsterPathfinder: Pathfinder;
  private readonly aoi: AoiGrid;
  /** 所有实体，包括玩家、怪物和地上的物品。AOI 里的 id 都能在这里找到。 */
  private readonly entities = new Map<number, Entity>();
  private readonly players = new Map<number, Player>();
  private readonly monsters: Monster[] = [];
  private readonly monstersById = new Map<number, Monster>();
  /** 地上的物品，按掉落的先后排列。存在时间是固定的，所以排在最前面的总是最先过期。 */
  private readonly drops = new Map<number, Drop>();
  private readonly dropGrid: DropGrid;
  private readonly ai: MonsterAi;
  private readonly lootRandom: () => number;
  private readonly nearby: Player[] = [];
  private readonly nearbyDrops: Drop[] = [];
  private pathQueue: Player[] = [];
  private nextId = 1;
  private tickCount = 0;

  /** lootRandom 决定掉什么、掉在哪，返回 [0, 1) 的随机数。测试里可以换成固定的序列。 */
  constructor(map: GameMap, lootRandom: () => number = Math.random) {
    this.map = map;
    this.lootRandom = lootRandom;
    this.pathfinder = new Pathfinder(map);
    this.monsterPathfinder = new Pathfinder(withSafeZoneBlocked(map));
    this.aoi = new AoiGrid(map.size, AOI_CELL_SIZE);
    this.dropGrid = new DropGrid(map.size, DROP_CELL_SIZE);
    const host: AiHost = {
      pathfinder: this.monsterPathfinder,
      playersNear: (m) => this.playersNear(m),
      findPlayer: (id) => this.players.get(id),
      inSafeZone: (x, z) => this.inSafeZone(x, z),
      dealDamage: (attacker, target, amount, now) => this.dealDamage(attacker, target, amount, now),
      moved: (m) => this.afterMove(m),
      hide: (m) => {
        this.removeFromView(m, false);
        m.inWorld = false;
      },
      show: (m) => {
        m.inWorld = true;
        this.addToView(m);
      },
    };
    this.ai = new MonsterAi(host);
  }

  get playerCount(): number {
    return this.players.size;
  }

  /** 活着的怪物数。 */
  get monsterCount(): number {
    let alive = 0;
    for (const m of this.monsters) if (!m.dead) alive++;
    return alive;
  }

  /** 累计的怪物寻路次数。 */
  get monsterPathfinds(): number {
    return this.ai.pathfinds;
  }

  /** 现在地上的物品堆数。 */
  get dropCount(): number {
    return this.drops.size;
  }

  getPlayer(id: number): PlayerState | undefined {
    const p = this.players.get(id);
    return p
      ? {
          name: p.name,
          x: p.x,
          z: p.z,
          moving: p.moving,
          hp: p.hp,
          dead: p.dead,
          items: { ...p.inventory },
          weapon: p.weapon,
        }
      : undefined;
  }

  getMonster(id: number): MonsterState | undefined {
    const m = this.monstersById.get(id);
    return m ? { x: m.x, z: m.z, moving: m.moving, hp: m.hp, dead: m.dead, ai: m.ai, inWorld: m.inWorld } : undefined;
  }

  /**
   * (x, z) 是否在出生点周围的安全区里。
   * 按格子算（格子中心在安全区半径内），这样“玩家是否安全”和“怪物能不能走进去”用的是完全相同的边界。
   */
  inSafeZone(x: number, z: number): boolean {
    return isSafeCell(this.map.size, Math.floor(x), Math.floor(z));
  }

  /**
   * 玩家进入世界。spawn、hp、items、weapon 是存档里的位置、血量、背包和手里的武器；
   * 不传时在出生点附近随机一个位置、满血、空背包、空手。
   */
  join(
    name: string,
    conn: Connection,
    now: number,
    spawn?: Point,
    hp?: number,
    items?: Inventory,
    weapon?: ItemId | null,
  ): number {
    const id = this.nextId++;
    const pos = spawn ?? this.randomSpawn();
    const player: Player = {
      kind: 'player',
      id,
      name: sanitizeName(name, `玩家${id}`),
      conn,
      x: pos.x,
      z: pos.z,
      path: null,
      pathIndex: 0,
      maxHp: PLAYER_MAX_HP,
      hp: hp === undefined ? PLAYER_MAX_HP : Math.min(PLAYER_MAX_HP, Math.max(1, Math.round(hp))),
      moving: false,
      dead: false,
      targetId: 0,
      nextAttackAt: 0,
      respawnAt: 0,
      pendingTarget: null,
      queued: false,
      lastPathAt: -Infinity,
      // 刚上线也要等一段时间才开始回血，不能靠重新登录跳过等待。
      lastCombatAt: now,
      nextRegenAt: 0,
      inventory: sanitizeInventory(items),
      weapon: sanitizeWeapon(weapon),
      // 药水也一样，刚上线先走一轮冷却，不能靠重新登录连着喝。
      nextPotionAt: now + POTION_COOLDOWN_MS,
    };
    this.players.set(id, player);
    this.entities.set(id, player);
    conn.send({ t: 'welcome', selfId: id, seed: this.map.seed, mapVersion: MAP_LAYOUT_VERSION, serverTime: now });
    this.sendInventory(player);
    this.addToView(player);
    return id;
  }

  leave(id: number): void {
    const player = this.players.get(id);
    if (!player) return;
    this.removeFromView(player, false);
    this.players.delete(id);
    this.entities.delete(id);
  }

  /**
   * 玩家请求移动到 (x, z)。校验通过后排队等待寻路，返回是否接受。
   * 寻路放到 tick 里做，并且每个 tick 有次数上限，避免很多人同时点击时卡住整个世界。
   */
  moveTo(id: number, x: number, z: number): boolean {
    const p = this.players.get(id);
    if (!p || p.dead) return false;
    if (!isValidMoveTarget(this.map, p.x, p.z, x, z)) {
      this.stats.rejectedMoves++;
      return false;
    }
    p.pendingTarget = { x, z };
    if (!p.queued) {
      p.queued = true;
      this.pathQueue.push(p);
    }
    return true;
  }

  /**
   * 玩家选择攻击目标，targetId 为 0 表示取消。目标必须是场上活着的怪物。
   * 这里只记下目标；能不能打到（距离、视线、是否站定）在 tick 里判定。
   */
  setTarget(id: number, targetId: number): boolean {
    const p = this.players.get(id);
    if (!p || p.dead) return false;
    if (targetId === 0) {
      p.targetId = 0;
      return true;
    }
    const m = this.monstersById.get(targetId);
    if (!m || m.dead || !m.inWorld) return false;
    p.targetId = targetId;
    return true;
  }

  /**
   * 玩家使用背包里的一个物品，返回是否用掉了。
   * 现在只有治疗药水：活着、背包里有、冷却结束、没满血时才能喝。
   */
  useItem(id: number, item: ItemId, now: number): boolean {
    const p = this.players.get(id);
    if (!p || p.dead || !ITEMS[item].usable) return false;
    if ((p.inventory[item] ?? 0) < 1) return false;
    if (now < p.nextPotionAt || p.hp >= p.maxHp) return false;
    const amount = Math.min(POTION_HEAL, p.maxHp - p.hp);
    p.hp += amount;
    p.nextPotionAt = now + POTION_COOLDOWN_MS;
    addItem(p.inventory, item, -1);
    this.sendInventory(p);
    this.broadcastNear(p.id, { t: 'heal', id: p.id, amount });
    return true;
  }

  /**
   * 玩家把背包里的一件武器拿在手里，返回是否换成了。
   * 手里原来有别的武器时，换下来的那件放回背包；背包里那种武器已经放满时换不了。
   */
  equip(id: number, item: ItemId): boolean {
    const p = this.players.get(id);
    if (!p || p.dead || !ITEMS[item].weapon) return false;
    if ((p.inventory[item] ?? 0) < 1) return false;
    const old = p.weapon;
    if (old === item) return false;
    if (old && (p.inventory[old] ?? 0) >= ITEMS[old].maxCount) return false;
    addItem(p.inventory, item, -1);
    if (old) addItem(p.inventory, old, 1);
    this.setWeapon(p, item);
    return true;
  }

  /** 玩家把手里的武器收回背包，返回是否收起来了。背包里这种武器已经放满时收不回去。 */
  unequip(id: number): boolean {
    const p = this.players.get(id);
    if (!p || p.dead || !p.weapon) return false;
    if ((p.inventory[p.weapon] ?? 0) >= ITEMS[p.weapon].maxCount) return false;
    addItem(p.inventory, p.weapon, 1);
    this.setWeapon(p, null);
    return true;
  }

  /**
   * 玩家向商人买 count 个 item，返回是否买成了。
   * 要活着、站在商人旁边、金币够、背包放得下；要么全买成，要么一个都不买。
   */
  buy(id: number, item: ItemId, count: number): boolean {
    const p = this.players.get(id);
    if (!p || !this.canTrade(p) || buyProblem(p.inventory, item, count) !== null) return false;
    addItem(p.inventory, 'gold', -(ITEMS[item].buyPrice as number) * count);
    addItem(p.inventory, item, count);
    this.stats.bought += count;
    this.sendInventory(p);
    return true;
  }

  /** 玩家把背包里的 count 个 item 卖给商人，返回是否卖成了。拿在手里的武器不在背包里，要先收起来才能卖。 */
  sell(id: number, item: ItemId, count: number): boolean {
    const p = this.players.get(id);
    if (!p || !this.canTrade(p) || sellProblem(p.inventory, item, count) !== null) return false;
    addItem(p.inventory, item, -count);
    addItem(p.inventory, 'gold', (ITEMS[item].sellPrice as number) * count);
    this.stats.sold += count;
    this.sendInventory(p);
    return true;
  }

  /**
   * 活着、离商人够近才能买卖。用的是服务器算出来的位置，客户端说自己在哪不算数。
   * 现在商人周围都是安全区，没有人会倒在那里；判断死活是为了以后挪动商人或者改了安全区也不出错。
   */
  private canTrade(p: Player): boolean {
    return !p.dead && nearMerchant(this.map.size, p.x, p.z);
  }

  /**
   * 在 (x, z) 的地上放一堆物品，返回它的 id。
   * 过一小会儿才能捡，没人捡的话到时间自己消失。
   */
  spawnDrop(item: ItemId, count: number, x: number, z: number, now: number): number {
    const drop: Drop = {
      kind: 'drop',
      id: this.nextId++,
      x: round2(x),
      z: round2(z),
      item,
      count,
      pickableAt: now + DROP_PICKUP_DELAY_MS,
      expireAt: now + DROP_LIFETIME_MS,
    };
    this.drops.set(drop.id, drop);
    this.dropGrid.add(drop);
    this.entities.set(drop.id, drop);
    this.stats.dropped++;
    this.addToView(drop);
    return drop.id;
  }

  /** 在 (x, z) 放一只怪物，这里也是它的出生位置。返回它的 id。 */
  spawnMonster(x: number, z: number): number {
    const id = this.nextId++;
    const monster: Monster = {
      kind: 'monster',
      id,
      name: MONSTER_NAME,
      x,
      z,
      path: null,
      pathIndex: 0,
      maxHp: MONSTER_MAX_HP,
      hp: MONSTER_MAX_HP,
      moving: false,
      dead: false,
      targetId: 0,
      nextAttackAt: 0,
      respawnAt: 0,
      homeX: x,
      homeZ: z,
      ai: 'idle',
      inWorld: true,
      nextThinkAt: -1,
      nextPathAt: 0,
      chaseX: x,
      chaseZ: z,
      hideAt: 0,
    };
    this.monsters.push(monster);
    this.monstersById.set(id, monster);
    this.entities.set(id, monster);
    this.addToView(monster);
    return id;
  }

  /**
   * 在安全区外随机撒 count 只怪物，返回实际生成的数量。
   * 位置由种子决定，同一张地图每次启动怪物都在同样的地方。
   */
  spawnMonsters(count: number, seed: number = this.map.seed): number {
    const rand = mulberry32(seed ^ 0x9e3779b9);
    const size = this.map.size;
    const center = size / 2;
    const placed: Point[] = [];
    for (let attempt = 0; attempt < count * 40 && placed.length < count; attempt++) {
      const x = Math.floor(2 + rand() * (size - 4)) + 0.5;
      const z = Math.floor(2 + rand() * (size - 4)) + 0.5;
      if (!isWalkable(this.map, x, z)) continue;
      if (Math.hypot(x - center, z - center) < SAFE_ZONE_RADIUS + MONSTER_SAFE_ZONE_MARGIN) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < MONSTER_SPACING)) continue;
      placed.push({ x, z });
      this.spawnMonster(x, z);
    }
    return placed.length;
  }

  /** 推进一个固定步长（1 / TICK_RATE 秒）。now 是这个 tick 对应的服务器时间。 */
  tick(now: number): void {
    this.tickCount++;
    this.processPathQueue(now);
    this.ai.update(this.monsters, now);

    for (const p of this.players.values()) {
      if (p.dead) {
        if (now >= p.respawnAt) this.respawn(p, now);
        continue;
      }
      if (p.path) {
        p.moving = stepMover(p, MOVE_SPEED * DT);
        this.afterMove(p);
      }
      if (this.drops.size > 0) this.pickUpNearby(p, now);
      if (p.targetId !== 0) this.playerAttack(p, now);
      if (p.hp < p.maxHp && now - p.lastCombatAt >= REGEN_DELAY_MS && now >= p.nextRegenAt) {
        p.hp++;
        p.nextRegenAt = now + REGEN_INTERVAL_MS;
      }
    }

    this.expireDrops(now);
    if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0) this.sendSnapshots(now);
  }

  private processPathQueue(now: number): void {
    const queue = this.pathQueue;
    if (queue.length === 0) return;
    this.pathQueue = [];
    let budget = MAX_PATHFINDS_PER_TICK;
    for (const p of queue) {
      // 已经离线的玩家直接丢掉。
      if (this.players.get(p.id) !== p) continue;
      const target = p.pendingTarget;
      if (!target) {
        p.queued = false;
        continue;
      }
      if (budget === 0 || now - p.lastPathAt < MOVE_MIN_INTERVAL_MS) {
        this.stats.deferredPathfinds++;
        this.pathQueue.push(p);
        continue;
      }
      budget--;
      p.queued = false;
      p.pendingTarget = null;
      p.lastPathAt = now;
      this.stats.pathfinds++;
      const path = this.pathfinder.findPath(p.x, p.z, target.x, target.z);
      // 找不到路时保持原来的移动。客户端预测用的是同一套规则。
      if (path) {
        setPath(p, path);
        p.moving = p.path !== null;
      }
    }
  }

  // ---- 战斗 ----

  /**
   * 玩家对目标的一次攻击判定。客户端负责把角色走到目标旁边，
   * 这里只在“目标活着、玩家站定、距离够近、中间没有墙、冷却结束”时结算伤害。
   */
  private playerAttack(p: Player, now: number): void {
    const m = this.monstersById.get(p.targetId);
    if (!m || m.dead || !m.inWorld) {
      p.targetId = 0;
      return;
    }
    if (p.path || now < p.nextAttackAt) return;
    // 脱战回家的怪物不受伤害。
    if (m.ai === 'return') return;
    if (Math.hypot(m.x - p.x, m.z - p.z) > ATTACK_RANGE) return;
    if (!this.pathfinder.lineOfSight(p.x, p.z, m.x, m.z)) return;
    p.nextAttackAt = now + PLAYER_ATTACK_INTERVAL_MS;
    this.dealDamage(p, m, attackDamage(p.weapon), now);
  }

  private dealDamage(attacker: Character, target: Character, amount: number, now: number): void {
    if (target.dead) return;
    target.hp = Math.max(0, target.hp - amount);
    this.stats.hits++;
    if (attacker.kind === 'player') attacker.lastCombatAt = now;
    if (target.kind === 'player') target.lastCombatAt = now;

    this.broadcastNear(target.id, { t: 'hit', from: attacker.id, to: target.id, damage: amount });

    if (target.kind === 'monster' && attacker.kind === 'player') this.ai.onDamaged(target, attacker);
    if (target.hp === 0) this.kill(target, now);
  }

  private kill(e: Character, now: number): void {
    e.dead = true;
    e.path = null;
    e.moving = false;
    e.targetId = 0;
    if (e.kind === 'player') {
      e.pendingTarget = null;
      e.respawnAt = now + PLAYER_RESPAWN_MS;
    } else {
      this.ai.onDeath(e, now);
      this.dropLoot(e, now);
    }
  }

  /**
   * 玩家在出生点满血复活。
   * 用“离开再进入”实现：周围的人和玩家自己都按普通的 leave、enter 处理，不需要专门的传送消息。
   */
  private respawn(p: Player, now: number): void {
    this.removeFromView(p, true);
    const pos = this.randomSpawn();
    p.x = pos.x;
    p.z = pos.z;
    p.hp = p.maxHp;
    p.dead = false;
    p.lastCombatAt = now;
    this.addToView(p);
  }

  // ---- 掉落和拾取 ----

  /** 怪物死后掉东西：金币必掉，药水和剑看运气。掉落谁都能捡，先到先得。 */
  private dropLoot(m: Monster, now: number): void {
    const gold = GOLD_DROP_MIN + Math.floor(this.lootRandom() * (GOLD_DROP_MAX - GOLD_DROP_MIN + 1));
    // 几样东西落在尸体周围不同的方向上，不会叠在一起。
    const angle = this.lootRandom() * Math.PI * 2;
    this.scatterDrop('gold', gold, m, angle, now);
    if (this.lootRandom() < POTION_DROP_CHANCE) this.scatterDrop('potion', 1, m, angle + Math.PI, now);
    if (this.lootRandom() < SWORD_DROP_CHANCE) this.scatterDrop('sword', 1, m, angle + Math.PI / 2, now);
  }

  /** 把物品放在尸体旁边 angle 方向上。那里是墙或者被墙隔开时，就放在尸体的位置。 */
  private scatterDrop(item: ItemId, count: number, m: Monster, angle: number, now: number): void {
    const r = DROP_SCATTER_MIN + this.lootRandom() * (DROP_SCATTER_RADIUS - DROP_SCATTER_MIN);
    let x = m.x + Math.cos(angle) * r;
    let z = m.z + Math.sin(angle) * r;
    if (!isWalkable(this.map, x, z) || !this.pathfinder.lineOfSight(m.x, m.z, x, z)) {
      x = m.x;
      z = m.z;
    }
    this.spawnDrop(item, count, x, z, now);
  }

  /**
   * 活着的玩家自动捡起脚边的物品。
   * 这种物品带满了就留在地上；隔着墙也捡不到。
   */
  private pickUpNearby(p: Player, now: number): void {
    const near = this.dropGrid.near(p.x, p.z, this.nearbyDrops);
    let changed = false;
    for (const drop of near) {
      if (now < drop.pickableAt) continue;
      if (Math.hypot(drop.x - p.x, drop.z - p.z) > PICKUP_RADIUS) continue;
      if ((p.inventory[drop.item] ?? 0) + drop.count > ITEMS[drop.item].maxCount) continue;
      if (!this.pathfinder.lineOfSight(p.x, p.z, drop.x, drop.z)) continue;
      this.removeDrop(drop);
      addItem(p.inventory, drop.item, drop.count);
      this.stats.pickedUp++;
      changed = true;
    }
    if (changed) this.sendInventory(p);
  }

  private expireDrops(now: number): void {
    for (const drop of this.drops.values()) {
      if (drop.expireAt > now) break;
      this.removeDrop(drop);
    }
  }

  /** 物品从地上消失（被捡走或过期），看得到它的玩家收到 leave。 */
  private removeDrop(drop: Drop): void {
    this.removeFromView(drop, false);
    this.drops.delete(drop.id);
    this.dropGrid.remove(drop);
    this.entities.delete(drop.id);
  }

  private sendInventory(p: Player): void {
    p.conn.send({ t: 'inv', items: { ...p.inventory }, weapon: p.weapon });
  }

  /** 换掉玩家手里的武器。背包已经由调用方改好；这里通知玩家自己和看得到他的人。 */
  private setWeapon(p: Player, weapon: ItemId | null): void {
    p.weapon = weapon;
    this.sendInventory(p);
    this.broadcastNear(p.id, { t: 'weapon', id: p.id, item: weapon });
  }

  // ---- 视野 ----

  /** 把消息发给能看到实体 id 的所有玩家（它自己是玩家的话也包括在内）。 */
  private broadcastNear(id: number, msg: ServerMsg): void {
    const cell = this.aoi.cellOf(id);
    if (cell === undefined) return;
    for (const c of this.aoi.neighbors(cell)) {
      for (const otherId of this.aoi.idsIn(c)) this.players.get(otherId)?.conn.send(msg);
    }
  }

  private playersNear(m: Monster): readonly Player[] {
    const out = this.nearby;
    out.length = 0;
    const cell = this.aoi.cellOf(m.id);
    if (cell === undefined) return out;
    for (const c of this.aoi.neighbors(cell)) {
      for (const id of this.aoi.idsIn(c)) {
        const p = this.players.get(id);
        if (p && !p.dead) out.push(p);
      }
    }
    return out;
  }

  /** 把实体放进 AOI：周围的玩家收到它的 enter；它自己是玩家的话，收到视野内所有实体（包括自己）。 */
  private addToView(e: Entity): void {
    const cell = this.aoi.add(e.id, e.x, e.z);
    const selfEnter: ServerMsg = { t: 'enter', entities: [info(e)] };
    const visible: EntityInfo[] = [];
    for (const c of this.aoi.neighbors(cell)) {
      for (const otherId of this.aoi.idsIn(c)) {
        const other = this.entities.get(otherId) as Entity;
        if (e.kind === 'player') visible.push(info(other));
        if (other !== e && other.kind === 'player') other.conn.send(selfEnter);
      }
    }
    if (e.kind === 'player') e.conn.send({ t: 'enter', entities: visible });
  }

  /**
   * 把实体移出 AOI：周围的玩家收到它的 leave。
   * notifySelf 为 true 时（复活前），它自己也收到 leave，忘掉原来视野里的所有实体。
   */
  private removeFromView(e: Entity, notifySelf: boolean): void {
    const cell = this.aoi.remove(e.id);
    if (cell === undefined) return;
    const msg: ServerMsg = { t: 'leave', ids: [e.id] };
    const seen: number[] = [];
    for (const c of this.aoi.neighbors(cell)) {
      for (const otherId of this.aoi.idsIn(c)) {
        seen.push(otherId);
        this.players.get(otherId)?.conn.send(msg);
      }
    }
    if (notifySelf && e.kind === 'player' && seen.length > 0) e.conn.send({ t: 'leave', ids: seen });
  }

  /** 实体移动之后更新 AOI，跨格时通知视野的变化。 */
  private afterMove(e: Character): void {
    const change = this.aoi.move(e.id, e.x, e.z);
    if (change) this.onCellChange(e, change);
  }

  /** 实体跨格后，和新进入、离开视野的实体互相通知。 */
  private onCellChange(e: Character, change: CellChange): void {
    if (change.entered.length > 0) {
      const selfEnter: ServerMsg = { t: 'enter', entities: [info(e)] };
      const entered: EntityInfo[] = [];
      for (const c of change.entered) {
        for (const otherId of this.aoi.idsIn(c)) {
          const other = this.entities.get(otherId);
          if (!other || other === e) continue;
          if (e.kind === 'player') entered.push(info(other));
          if (other.kind === 'player') other.conn.send(selfEnter);
        }
      }
      if (e.kind === 'player' && entered.length > 0) e.conn.send({ t: 'enter', entities: entered });
    }
    if (change.left.length > 0) {
      const selfLeave: ServerMsg = { t: 'leave', ids: [e.id] };
      const left: number[] = [];
      for (const c of change.left) {
        for (const otherId of this.aoi.idsIn(c)) {
          const other = this.entities.get(otherId);
          if (!other || other === e) continue;
          left.push(otherId);
          if (other.kind === 'player') other.conn.send(selfLeave);
        }
      }
      if (e.kind === 'player' && left.length > 0) e.conn.send({ t: 'leave', ids: left });
    }
  }

  /**
   * 给每个玩家下发视野内所有玩家和怪物（包括自己）的位置、状态和血量。
   * 地上的物品不会动，进出视野时已经通知过，不放进快照。
   * 同一个格子里的玩家视野相同，所以每个格子只组装一次消息，发送端也只序列化一次。
   */
  private sendSnapshots(now: number): void {
    const cellEntities = new Map<number, SnapEntity[]>();
    const cellMessages = new Map<number, ServerMsg>();

    const entitiesIn = (cell: number): SnapEntity[] => {
      let list = cellEntities.get(cell);
      if (!list) {
        list = [];
        for (const id of this.aoi.idsIn(cell)) {
          const e = this.entities.get(id) as Entity;
          if (e.kind === 'drop') continue;
          list.push([e.id, round2(e.x), round2(e.z), stateOf(e), e.hp]);
        }
        cellEntities.set(cell, list);
      }
      return list;
    };

    for (const p of this.players.values()) {
      const cell = this.aoi.cellOf(p.id) as number;
      let msg = cellMessages.get(cell);
      if (!msg) {
        const entities: SnapEntity[] = [];
        for (const c of this.aoi.neighbors(cell)) {
          for (const e of entitiesIn(c)) entities.push(e);
        }
        msg = { t: 'snap', time: now, entities };
        cellMessages.set(cell, msg);
      }
      p.conn.send(msg);
    }
  }

  private randomSpawn(): Point {
    const center = this.map.size / 2;
    for (let i = 0; i < 50; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = SPAWN_RADIUS * Math.sqrt(Math.random());
      const x = center + Math.cos(angle) * r;
      const z = center + Math.sin(angle) * r;
      if (isWalkable(this.map, x, z)) return { x, z };
    }
    return { x: center + 0.5, z: center + 0.5 };
  }
}

function isSafeCell(size: number, cx: number, cz: number): boolean {
  const center = size / 2;
  return Math.hypot(cx + 0.5 - center, cz + 0.5 - center) < SAFE_ZONE_RADIUS;
}

/**
 * 怪物眼里的地图：安全区里的格子也当作障碍。
 * 这样怪物的任何路线（追击、脱战回家）都不会穿过安全区，不需要在 AI 里到处单独判断。
 */
function withSafeZoneBlocked(map: GameMap): GameMap {
  const size = map.size;
  const blocked = map.blocked.slice();
  const center = Math.floor(size / 2);
  const reach = Math.ceil(SAFE_ZONE_RADIUS) + 1;
  for (let cz = Math.max(0, center - reach); cz <= Math.min(size - 1, center + reach); cz++) {
    for (let cx = Math.max(0, center - reach); cx <= Math.min(size - 1, center + reach); cx++) {
      if (isSafeCell(size, cx, cz)) blocked[cz * size + cx] = 1;
    }
  }
  return { ...map, blocked };
}

function stateOf(e: Character): EntityState {
  return e.dead ? STATE_DEAD : e.moving ? STATE_MOVING : STATE_IDLE;
}

/** 背包里某种物品的数量加上 delta；减到 0 就从背包里去掉。 */
function addItem(inventory: Inventory, item: ItemId, delta: number): void {
  const count = (inventory[item] ?? 0) + delta;
  if (count > 0) inventory[item] = count;
  else delete inventory[item];
}

function info(e: Entity): EntityInfo {
  if (e.kind === 'drop') return { id: e.id, kind: 'drop', x: e.x, z: e.z, item: e.item, count: e.count };
  const out: CharacterInfo = {
    id: e.id,
    kind: e.kind,
    name: e.name,
    x: round2(e.x),
    z: round2(e.z),
    state: stateOf(e),
    hp: e.hp,
    maxHp: e.maxHp,
  };
  if (e.kind === 'player' && e.weapon) out.weapon = e.weapon;
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
