/**
 * 机器人压测：连上 N 个机器人在地图上随机走动，统计每个机器人收到的同步量。
 *
 * 用法：pnpm bots [--count 200] [--duration 30] [--url ws://localhost:8080/ws] [--password ...]
 * duration 为 0 时一直运行，直到按 Ctrl+C。
 *
 * 机器人用的账号是“机器人1”“机器人2”……，第一次运行时自动注册，之后直接登录。
 * 这些账号的密码是公开的默认值，只适合本地压测；对着公开的服务器跑时请用 --password 换一个。
 */
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import {
  API_PATH,
  CLIENT_MOVE_DISTANCE,
  decodeServerMsg,
  encode,
  generateMap,
  isValidMoveTarget,
  SERVER_PORT,
  WS_PATH,
} from '@mmo/shared';
import type { ApiError, AuthRequest, AuthSuccess, ClientMsg, GameMap, Point } from '@mmo/shared';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '200' },
    duration: { type: 'string', default: '30' },
    url: { type: 'string', default: `ws://localhost:${SERVER_PORT}${WS_PATH}` },
    password: { type: 'string', default: 'local-bots-only' },
  },
  allowPositionals: true,
});

const COUNT = Math.max(1, Number(values.count) || 200);
const DURATION_S = Math.max(0, Number(values.duration) || 0);
const URL_WS = values.url;
const PASSWORD = values.password;
const REPORT_EVERY_MS = 5000;
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

class Bot {
  selfId = -1;
  x = 0;
  z = 0;
  ready = false;
  closed = false;
  readonly visible = new Set<number>();
  snaps = 0;
  bytes = 0;
  /** 快照里出现、但没有先收到 enter 的实体数。应该一直是 0。 */
  unknownInSnap = 0;
  nextMoveAt = 0;
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
        break;
      case 'enter':
        for (const e of msg.entities) {
          this.visible.add(e.id);
          if (e.id === this.selfId) {
            this.x = e.x;
            this.z = e.z;
            this.ready = true;
          }
        }
        break;
      case 'leave':
        for (const id of msg.ids) this.visible.delete(id);
        break;
      case 'snap':
        this.snaps++;
        for (const [id, x, z] of msg.entities) {
          if (!this.visible.has(id)) this.unknownInSnap++;
          if (id === this.selfId) {
            this.x = x;
            this.z = z;
          }
        }
        break;
      case 'pong':
        break;
    }
  }

  /** 朝一个随机的远处目的地走，每次走一段，到了再换目的地。 */
  maybeMove(now: number): void {
    if (!this.ready || !map || now < this.nextMoveAt) return;
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
  for (const bot of bots) bot.maybeMove(now);
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
  for (const b of bots) {
    snaps += b.snaps;
    bytes += b.bytes;
    unknown += b.unknownInSnap;
  }
  for (const b of online) {
    visibleSum += b.visible.size;
    visibleMax = Math.max(visibleMax, b.visible.size);
  }
  const seconds = Math.max(0.001, (now - lastReportAt) / 1000);
  console.log(
    `[bots] ${label} 在线 ${online.length}/${COUNT} | 视野内实体 平均 ${(visibleSum / n).toFixed(1)} 最多 ${visibleMax} | ` +
      `每个机器人 ${((snaps - lastSnaps) / seconds / n).toFixed(1)} 快照/秒 ${((bytes - lastBytes) / seconds / n / 1024).toFixed(2)} KB/秒 | ` +
      `快照里的未知实体 ${unknown}`,
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
