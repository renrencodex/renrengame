/**
 * 机器人压测：连上 N 个机器人在地图上随机走动，附近有怪物时上去打，地上有东西就去捡，血少了喝药水，
 * 统计每个机器人收到的同步量，以及命中、击杀、死亡、拾取和喝药水的次数。
 *
 * 用法：pnpm bots [--count 200] [--duration 30] [--url ws://localhost:8080/ws] [--password ...] [--peaceful]
 * duration 为 0 时一直运行，直到按 Ctrl+C。加 --peaceful 时机器人只走路、不主动打怪（怪物仍然会打它们）。
 *
 * 机器人用的账号是“机器人1”“机器人2”……，第一次运行时自动注册，之后直接登录。
 * 这些账号的密码是公开的默认值，只适合本地压测；对着公开的服务器跑时请用 --password 换一个。
 */
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import {
  API_PATH,
  CLIENT_ATTACK_RANGE,
  CLIENT_MOVE_DISTANCE,
  decodeServerMsg,
  encode,
  generateMap,
  isValidMoveTarget,
  PLAYER_MAX_HP,
  POTION_COOLDOWN_MS,
  SERVER_PORT,
  STATE_DEAD,
  STATE_MOVING,
  WS_PATH,
} from '@mmo/shared';
import type {
  ApiError,
  AuthRequest,
  AuthSuccess,
  CharacterKind,
  ClientMsg,
  EntityState,
  GameMap,
  Inventory,
  Point,
} from '@mmo/shared';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '200' },
    duration: { type: 'string', default: '30' },
    url: { type: 'string', default: `ws://localhost:${SERVER_PORT}${WS_PATH}` },
    password: { type: 'string', default: 'local-bots-only' },
    peaceful: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const COUNT = Math.max(1, Number(values.count) || 200);
const DURATION_S = Math.max(0, Number(values.duration) || 0);
const URL_WS = values.url;
const PASSWORD = values.password;
const FIGHT = !values.peaceful;
const REPORT_EVERY_MS = 5000;
/** 这么近的怪物才会去打。 */
const ENGAGE_RADIUS = 18;
/** 追击时重新发移动命令的最短间隔，以及目标离上一次命令的终点多远才重新发（和客户端一致）。 */
const CHASE_EVERY_MS = 250;
const CHASE_REORDER_DISTANCE = 1;
/** 同一只怪物追了这么久还没打死就放弃（比如它在墙后面够不着），歇一会儿再找别的。 */
const GIVE_UP_MS = 20000;
const REST_MS = 5000;
/** 这么近的掉落物才会去捡。 */
const LOOT_RADIUS = 14;
/** 朝一堆掉落物走了这么久还没捡到（比如药水带满了）就不再理它。 */
const LOOT_GIVE_UP_MS = 6000;
const LOOT_EVERY_MS = 500;
/** 血量低于这个比例时喝药水。 */
const DRINK_BELOW = 0.5;
/** 同时进行的登录请求数。服务端算密码哈希比较慢，开太多只会排队。 */
const LOGIN_CONCURRENCY = 8;

/** 和 WebSocket 地址同一个主机上的 HTTP 接口地址。 */
function httpUrl(path: string): URL {
  const url = new URL(URL_WS);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = path;
  return url;
}

async function postAuth(action: 'register' | 'login', body: AuthRequest): Promise<{ status: number; data: Partial<AuthSuccess & ApiError> }> {
  const res = await fetch(httpUrl(`${API_PATH}/${action}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<AuthSuccess & ApiError>;
  return { status: res.status, data };
}

/** 拿到第 index 个机器人的会话令牌：先注册，账号已经存在（之前压测留下的）就改为登录。 */
async function obtainToken(index: number): Promise<string> {
  const body: AuthRequest = { username: `机器人${index}`, password: PASSWORD };
  let res = await postAuth('register', body);
  if (res.status === 409) res = await postAuth('login', body);
  if (typeof res.data.token !== 'string') {
    throw new Error(`${body.username} 登录失败（${res.status}）：${res.data.message ?? '没有返回令牌'}`);
  }
  return res.data.token;
}

async function obtainTokens(count: number): Promise<string[]> {
  const tokens = new Array<string>(count);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const i = next++;
      tokens[i] = await obtainToken(i + 1);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOGIN_CONCURRENCY, count) }, worker));
  return tokens;
}

let map: GameMap | null = null;

/** 机器人视野里的一个玩家或怪物。 */
interface Seen {
  kind: CharacterKind;
  x: number;
  z: number;
  state: EntityState;
}

class Bot {
  selfId = -1;
  x = 0;
  z = 0;
  ready = false;
  closed = false;
  /** 视野内的玩家和怪物，包括自己。 */
  readonly visible = new Map<number, Seen>();
  /** 视野内地上的物品。 */
  readonly drops = new Map<number, Point>();
  snaps = 0;
  bytes = 0;
  /** 快照里出现、但没有先收到 enter 的实体数。应该一直是 0。 */
  unknownInSnap = 0;
  hitsDealt = 0;
  hitsTaken = 0;
  kills = 0;
  deaths = 0;
  /** 捡到的物品堆数、金币数，和喝掉的药水数。 */
  pickups = 0;
  goldGained = 0;
  potionsUsed = 0;
  nextMoveAt = 0;
  private hp = PLAYER_MAX_HP;
  private inventory: Inventory | null = null;
  private nextPotionAt = 0;
  private lootId = 0;
  private lootSince = 0;
  private nextLootAt = 0;
  /** 试过但捡不起来的掉落物，不再去捡。 */
  private readonly ignoredDrops = new Set<number>();
  private moving = false;
  private dead = false;
  private targetId = 0;
  private engagedAt = 0;
  private nextChaseAt = 0;
  private chaseTo: Point | null = null;
  private restUntil = 0;
  /** 每个实体最近一次是被谁打中的，用来判断怪物是不是自己打死的。 */
  private readonly lastAttacker = new Map<number, number>();
  private destination: Point | null = null;
  private readonly ws: WebSocket;

  constructor(index: number, token: string) {
    this.ws = new WebSocket(URL_WS);
    this.ws.on('open', () => this.send({ t: 'join', token }));
    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('close', () => {
      this.closed = true;
      this.ready = false;
    });
    this.ws.on('error', (err) => {
      if (!this.closed) console.error(`[bot ${index}] ${err.message}`);
      this.closed = true;
    });
  }

  close(): void {
    this.ws.close();
  }

  private send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  private onMessage(raw: string): void {
    this.bytes += Buffer.byteLength(raw);
    const msg = decodeServerMsg(raw);
    if (!msg) return;
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.selfId;
        map ??= generateMap(msg.seed);
        // 刚进入世界时，服务器那边药水先走一轮冷却。
        this.nextPotionAt = Date.now() + POTION_COOLDOWN_MS;
        break;
      case 'enter':
        for (const e of msg.entities) {
          if (e.kind === 'drop') {
            this.drops.set(e.id, { x: e.x, z: e.z });
            continue;
          }
          this.visible.set(e.id, { kind: e.kind, x: e.x, z: e.z, state: e.state });
          if (e.id === this.selfId) this.onSelfState(e.x, e.z, e.state, e.hp);
        }
        break;
      case 'leave':
        for (const id of msg.ids) {
          this.visible.delete(id);
          this.drops.delete(id);
          this.ignoredDrops.delete(id);
          this.lastAttacker.delete(id);
        }
        break;
      case 'snap':
        this.snaps++;
        for (const [id, x, z, state, hp] of msg.entities) {
          const seen = this.visible.get(id);
          if (!seen) {
            this.unknownInSnap++;
            continue;
          }
          if (state === STATE_DEAD && seen.state !== STATE_DEAD && seen.kind === 'monster') {
            if (this.lastAttacker.get(id) === this.selfId) this.kills++;
          }
          seen.x = x;
          seen.z = z;
          seen.state = state;
          if (id === this.selfId) this.onSelfState(x, z, state, hp);
        }
        break;
      case 'hit':
        if (msg.from === this.selfId) this.hitsDealt++;
        if (msg.to === this.selfId) this.hitsTaken++;
        this.lastAttacker.set(msg.to, msg.from);
        break;
      case 'inv':
        this.onInventory(msg.items);
        break;
      case 'heal':
      case 'pong':
        break;
    }
  }

  /** 和上一次的背包比：多出来的是捡到的，药水少了是喝掉的。 */
  private onInventory(items: Inventory): void {
    const before = this.inventory;
    this.inventory = items;
    if (!before) return;
    const gold = (items.gold ?? 0) - (before.gold ?? 0);
    const potions = (items.potion ?? 0) - (before.potion ?? 0);
    if (gold > 0) {
      this.pickups++;
      this.goldGained += gold;
    }
    if (potions > 0) this.pickups++;
    if (potions < 0) {
      this.potionsUsed -= potions;
      this.nextPotionAt = Date.now() + POTION_COOLDOWN_MS;
    }
  }

  private onSelfState(x: number, z: number, state: EntityState, hp: number): void {
    this.x = x;
    this.z = z;
    this.hp = hp;
    this.moving = state === STATE_MOVING;
    this.ready = true;
    const dead = state === STATE_DEAD;
    if (dead && !this.dead) {
      this.deaths++;
      this.targetId = 0;
      this.lootId = 0;
      this.destination = null;
    }
    this.dead = dead;
  }

  /** 每 100 毫秒调用一次：死了就等复活，血少了喝药水，手头没有怪物时先捡东西，附近有怪物就打，否则随机走动。 */
  act(now: number): void {
    if (!this.ready || !map || this.dead) return;
    this.drink(now);
    if (this.targetId === 0 && this.loot(now, map)) return;
    if (FIGHT && this.fight(now, map)) return;
    this.wander(now, map);
  }

  private drink(now: number): void {
    if (now < this.nextPotionAt || this.hp > PLAYER_MAX_HP * DRINK_BELOW) return;
    if ((this.inventory?.potion ?? 0) < 1) return;
    // 先按一秒算，等服务器确认喝掉了再按真正的冷却时间算。
    this.nextPotionAt = now + 1000;
    this.send({ t: 'use', item: 'potion' });
  }

  /**
   * 捡东西：走到最近的一堆掉落物那里，走近了服务器会自动让角色捡起来。
   * 返回 false 表示附近没有要捡的东西。
   */
  private loot(now: number, map: GameMap): boolean {
    let drop = this.lootId !== 0 ? this.drops.get(this.lootId) : undefined;
    if (drop && now - this.lootSince > LOOT_GIVE_UP_MS) {
      this.ignoredDrops.add(this.lootId);
      drop = undefined;
    }
    if (!drop) {
      this.lootId = 0;
      let bestDistance = LOOT_RADIUS;
      for (const [id, d] of this.drops) {
        if (this.ignoredDrops.has(id)) continue;
        const distance = Math.hypot(d.x - this.x, d.z - this.z);
        if (distance < bestDistance) {
          bestDistance = distance;
          this.lootId = id;
          drop = d;
        }
      }
      if (!drop) return false;
      this.lootSince = now;
      this.nextLootAt = 0;
    }
    if (now < this.nextLootAt) return true;
    this.nextLootAt = now + LOOT_EVERY_MS;
    if (isValidMoveTarget(map, this.x, this.z, drop.x, drop.z, CLIENT_MOVE_DISTANCE)) {
      this.send({ t: 'moveTo', x: drop.x, z: drop.z });
    } else {
      this.ignoredDrops.add(this.lootId);
      this.lootId = 0;
    }
    return true;
  }

  /**
   * 打怪。和真正的客户端一样：选中目标后自己走过去，走到攻击距离内停下，伤害由服务端判定。
   * 返回 false 表示现在没有可打的怪物。
   */
  private fight(now: number, map: GameMap): boolean {
    let target = this.targetId !== 0 ? this.visible.get(this.targetId) : undefined;
    if (this.targetId !== 0 && (!target || target.state === STATE_DEAD || now - this.engagedAt > GIVE_UP_MS)) {
      // 目标死了、离开了视野，或者追了太久。
      if (target?.state !== STATE_DEAD) this.send({ t: 'target', id: 0 });
      if (target && target.state !== STATE_DEAD) this.restUntil = now + REST_MS;
      this.targetId = 0;
      target = undefined;
    }
    if (!target) {
      if (now < this.restUntil) return false;
      let bestDistance = ENGAGE_RADIUS;
      for (const [id, e] of this.visible) {
        if (e.kind !== 'monster' || e.state === STATE_DEAD) continue;
        const d = Math.hypot(e.x - this.x, e.z - this.z);
        if (d < bestDistance) {
          bestDistance = d;
          this.targetId = id;
          target = e;
        }
      }
      if (!target) return false;
      this.engagedAt = now;
      this.nextChaseAt = 0;
      this.chaseTo = null;
      this.send({ t: 'target', id: this.targetId });
    }

    if (now < this.nextChaseAt) return true;
    if (Math.hypot(target.x - this.x, target.z - this.z) <= CLIENT_ATTACK_RANGE) {
      // 够近了：还在走就停下，服务端只在站定时结算攻击。
      this.chaseTo = null;
      if (this.moving) {
        this.nextChaseAt = now + CHASE_EVERY_MS;
        this.send({ t: 'moveTo', x: this.x, z: this.z });
      }
      return true;
    }
    // 正朝目标走、目标也没怎么动时，不用重复发。
    const to = this.chaseTo;
    if (this.moving && to && Math.hypot(target.x - to.x, target.z - to.z) <= CHASE_REORDER_DISTANCE) return true;
    this.nextChaseAt = now + CHASE_EVERY_MS;
    if (isValidMoveTarget(map, this.x, this.z, target.x, target.z, CLIENT_MOVE_DISTANCE)) {
      this.chaseTo = { x: target.x, z: target.z };
      this.send({ t: 'moveTo', x: target.x, z: target.z });
    }
    return true;
  }

  /** 朝一个随机的远处目的地走，每次走一段，到了再换目的地。 */
  private wander(now: number, map: GameMap): void {
    if (now < this.nextMoveAt) return;
    this.nextMoveAt = now + 500 + Math.random() * 2500;

    if (!this.destination || Math.hypot(this.destination.x - this.x, this.destination.z - this.z) < 6) {
      this.destination = { x: Math.random() * map.size, z: Math.random() * map.size };
    }
    const dx = this.destination.x - this.x;
    const dz = this.destination.z - this.z;
    const dist = Math.hypot(dx, dz);
    const step = Math.min(dist, 20 + Math.random() * 30);
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = this.x + (dx / dist) * step + (Math.random() - 0.5) * 8;
      const z = this.z + (dz / dist) * step + (Math.random() - 0.5) * 8;
      if (isValidMoveTarget(map, this.x, this.z, x, z, CLIENT_MOVE_DISTANCE)) {
        this.send({ t: 'moveTo', x, z });
        return;
      }
    }
  }
}

// 先让所有机器人登录完，再开始计时，这样统计的只是游戏内的同步。
console.log(`[bots] 正在为 ${COUNT} 个机器人注册或登录…`);
const loginStartedAt = Date.now();
let tokens: string[];
try {
  tokens = await obtainTokens(COUNT);
} catch (err) {
  console.error(`[bots] ${(err as Error).message}`);
  process.exit(1);
}
console.log(`[bots] 登录完成，用时 ${((Date.now() - loginStartedAt) / 1000).toFixed(1)} 秒`);

const bots: Bot[] = [];
const startedAt = Date.now();
let lastReportAt = startedAt;
let lastSnaps = 0;
let lastBytes = 0;

console.log(`[bots] 连接 ${COUNT} 个机器人到 ${URL_WS}` + (DURATION_S > 0 ? `，运行 ${DURATION_S} 秒` : ''));

// 分批连接，避免一瞬间建立几百个连接。
const spawnTimer = setInterval(() => {
  for (let i = 0; i < 20 && bots.length < COUNT; i++) bots.push(new Bot(bots.length + 1, tokens[bots.length]));
  if (bots.length >= COUNT) clearInterval(spawnTimer);
}, 100);

const moveTimer = setInterval(() => {
  const now = Date.now();
  for (const bot of bots) bot.act(now);
}, 100);

function report(label: string): void {
  const now = Date.now();
  const online = bots.filter((b) => b.ready);
  const n = Math.max(1, online.length);
  let visibleSum = 0;
  let visibleMax = 0;
  let snaps = 0;
  let bytes = 0;
  let unknown = 0;
  let hitsDealt = 0;
  let hitsTaken = 0;
  let kills = 0;
  let deaths = 0;
  let pickups = 0;
  let gold = 0;
  let potionsUsed = 0;
  let dropsSum = 0;
  for (const b of bots) {
    snaps += b.snaps;
    bytes += b.bytes;
    unknown += b.unknownInSnap;
    hitsDealt += b.hitsDealt;
    hitsTaken += b.hitsTaken;
    kills += b.kills;
    deaths += b.deaths;
    pickups += b.pickups;
    gold += b.goldGained;
    potionsUsed += b.potionsUsed;
  }
  for (const b of online) {
    dropsSum += b.drops.size;
    visibleSum += b.visible.size;
    visibleMax = Math.max(visibleMax, b.visible.size);
  }
  const seconds = Math.max(0.001, (now - lastReportAt) / 1000);
  console.log(
    `[bots] ${label} 在线 ${online.length}/${COUNT} | 视野内实体 平均 ${(visibleSum / n).toFixed(1)} 最多 ${visibleMax} ` +
      `掉落物 平均 ${(dropsSum / n).toFixed(1)} | ` +
      `每个机器人 ${((snaps - lastSnaps) / seconds / n).toFixed(1)} 快照/秒 ${((bytes - lastBytes) / seconds / n / 1024).toFixed(2)} KB/秒 | ` +
      `快照里的未知实体 ${unknown} | 累计 命中 ${hitsDealt} 被命中 ${hitsTaken} 击杀 ${kills} 死亡 ${deaths} ` +
      `拾取 ${pickups} 堆（金币 ${gold}）喝药水 ${potionsUsed}`,
  );
  lastReportAt = now;
  lastSnaps = snaps;
  lastBytes = bytes;
}

const reportTimer = setInterval(() => {
  report(`${Math.round((Date.now() - startedAt) / 1000)}s`);
}, REPORT_EVERY_MS);

async function finish(): Promise<void> {
  clearInterval(spawnTimer);
  clearInterval(moveTimer);
  clearInterval(reportTimer);
  report('结束');
  try {
    const res = await fetch(httpUrl('/stats'), { signal: AbortSignal.timeout(2000) });
    if (res.ok) console.log(`[bots] 服务端统计 ${JSON.stringify(await res.json())}`);
  } catch {
    // 统计接口只是辅助信息，取不到不影响结果。
  }
  for (const bot of bots) bot.close();
  setTimeout(() => process.exit(0), 300);
}

if (DURATION_S > 0) setTimeout(() => void finish(), DURATION_S * 1000);
process.on('SIGINT', () => void finish());
