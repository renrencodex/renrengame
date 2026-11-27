import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CLOSE_AUTH_FAILED,
  CLOSE_REPLACED,
  CLOSE_SERVER_FULL,
  decodeClientMsg,
  encode,
  generateMap,
  isWalkable,
  MONSTER_COUNT,
  TICK_MS,
  WS_PATH,
} from '@mmo/shared';
import type { ServerMsg } from '@mmo/shared';
import { Auth } from './auth';
import type { Session } from './auth';
import { CharacterStore, spawnFromSave } from './characters';
import type { CharacterState, SavedCharacter } from './characters';
import { loadConfig } from './config';
import { createPool, migrate } from './db';
import { errorText } from './errors';
import { createHttpHandler } from './http';
import { connectRedis } from './redis';
import { loadStaticFiles } from './static';
import { World } from './world';
import type { Connection, PlayerState } from './world';

/** 客户端消息的大小上限（字节）。正常消息只有几十字节。 */
const MAX_PAYLOAD_BYTES = 1024;
/** 每个连接每秒允许的消息数，以及允许的突发量。 */
const MESSAGES_PER_SECOND = 30;
const MESSAGE_BURST = 40;
/** 发送缓冲超过这个值时先丢快照和命中消息，超过上限时断开连接。 */
const SNAPSHOT_DROP_BYTES = 1 << 20;
const DISCONNECT_BYTES = 8 << 20;
/** 落后太多时一次最多补几个 tick，再多就直接跳过。 */
const MAX_CATCHUP_TICKS = 5;
const STATS_WINDOW_MS = 5000;
const HEARTBEAT_MS = 30000;
/** 每隔这么久把在线玩家的位置和血量写进数据库。 */
const AUTOSAVE_MS = 30000;
/** 有玩家下线后，等这么久再写库，让短时间内的多次下线合成一批。 */
const LEAVE_FLUSH_DELAY_MS = 1000;
/** 关服时等待最后一次写库的最长时间。 */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5000;

/** 一个 WebSocket 连接。进入世界之前 player 为空。 */
interface Client {
  readonly ws: WebSocket;
  readonly conn: Connection;
  joining: boolean;
  player: OnlinePlayer | null;
}

/** 已经在世界里的玩家，把连接、账号和世界里的实体关联起来。 */
interface OnlinePlayer {
  readonly client: Client;
  readonly playerId: number;
  readonly accountId: number;
  readonly characterId: number;
  /** 最近一次交给 CharacterStore 的状态，没变化时不用重复写。 */
  lastMarked: CharacterState | null;
}

/** 玩家当前要存档的状态。死亡状态存成 0 血，下次上线时在出生点满血复活。 */
function toSave(state: PlayerState): CharacterState {
  return { x: state.x, z: state.z, hp: state.dead ? 0 : state.hp };
}

async function main(): Promise<void> {
  const config = loadConfig();
  // 配置了客户端目录时，页面也由这个进程提供。目录不对的话在连数据库之前就报错。
  const staticFiles = config.staticDir ? loadStaticFiles(config.staticDir) : undefined;

  const pool = createPool(config.databaseUrl);
  const migrated = await migrate(pool).catch((err: unknown) => {
    throw new Error(`PostgreSQL 初始化失败：${errorText(err)}`, { cause: err });
  });
  if (migrated.length > 0) console.log(`[db] 执行了迁移：${migrated.join(', ')}`);
  const redis = await connectRedis(config.redisUrl);

  const map = generateMap(config.mapSeed);
  const world = new World(map);
  const monsters = world.spawnMonsters(MONSTER_COUNT);
  const auth = new Auth(pool, redis);
  const characters = new CharacterStore(pool);
  /** 在线玩家，按账号索引。同一个账号同一时间只能有一个连接在世界里。 */
  const online = new Map<number, OnlinePlayer>();
  let shuttingDown = false;

  // 同一个消息对象常常发给很多玩家（比如同一格的快照），只序列化一次。
  const encoded = new WeakMap<ServerMsg, string>();

  function createConnection(ws: WebSocket): Connection {
    return {
      send(msg) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const buffered = ws.bufferedAmount;
        if (buffered > DISCONNECT_BYTES) {
          ws.terminate();
          return;
        }
        // 快照可以丢，下一个快照会补上；命中消息只用来播放动作和飘字，血量以快照为准，也可以丢。
        // enter 和 leave 不能丢。
        if ((msg.t === 'snap' || msg.t === 'hit') && buffered > SNAPSHOT_DROP_BYTES) return;
        let data = encoded.get(msg);
        if (data === undefined) {
          data = encode(msg);
          encoded.set(msg, data);
        }
        ws.send(data);
      },
    };
  }

  // ---- 角色位置和血量的保存 ----

  let leaveFlushTimer: NodeJS.Timeout | undefined;

  function flushCharacters(): Promise<void> {
    return characters.flush().catch((err: unknown) => {
      console.error(`[db] 保存角色失败，${characters.pendingCount} 个角色留到下次再写：${errorText(err)}`);
    });
  }

  /** 把玩家移出世界，并记下位置和血量等待写库。 */
  function removeFromWorld(player: OnlinePlayer): void {
    const state = world.getPlayer(player.playerId);
    world.leave(player.playerId);
    if (state) characters.markDirty(player.characterId, toSave(state));
    online.delete(player.accountId);
    player.client.player = null;
    if (!shuttingDown && leaveFlushTimer === undefined) {
      leaveFlushTimer = setTimeout(() => {
        leaveFlushTimer = undefined;
        void flushCharacters();
      }, LEAVE_FLUSH_DELAY_MS);
    }
  }

  const autosaveTimer = setInterval(() => {
    for (const player of online.values()) {
      const state = world.getPlayer(player.playerId);
      if (!state) continue;
      const save = toSave(state);
      const last = player.lastMarked;
      if (last && last.x === save.x && last.z === save.z && last.hp === save.hp) continue;
      player.lastMarked = save;
      characters.markDirty(player.characterId, save);
    }
    void flushCharacters();
  }, AUTOSAVE_MS);

  // ---- 进入世界 ----

  async function enter(client: Client, token: string): Promise<void> {
    let session: Session | null;
    let saved: SavedCharacter | null | undefined;
    try {
      session = await auth.resolveSession(token);
      if (!session) {
        client.ws.close(CLOSE_AUTH_FAILED, 'invalid session');
        return;
      }
      saved = await characters.load(session.characterId);
    } catch (err) {
      console.error(`[join] 读取会话或角色失败：${errorText(err)}`);
      client.ws.close(1011, 'storage unavailable');
      return;
    }
    if (saved === undefined) {
      // 会话还在但角色已经不存在（比如账号被删除）。
      client.ws.close(CLOSE_AUTH_FAILED, 'character not found');
      return;
    }

    // 从这里开始没有 await：检查在线状态和进入世界是一个整体，
    // 同一个账号的两个连接不会在中间交错。
    if (shuttingDown || client.ws.readyState !== WebSocket.OPEN) return;

    const existing = online.get(session.accountId);
    if (existing) {
      // 顶号：新连接接着旧连接当前的位置和血量继续。
      const state = world.getPlayer(existing.playerId);
      if (state) saved = toSave(state);
      const oldWs = existing.client.ws;
      removeFromWorld(existing);
      oldWs.close(CLOSE_REPLACED, 'logged in elsewhere');
    }
    if (world.playerCount >= config.maxPlayers) {
      client.ws.close(CLOSE_SERVER_FULL, 'server full');
      return;
    }
    const { spawn, hp } = spawnFromSave(saved, (x, z) => isWalkable(map, x, z));
    const playerId = world.join(session.name, client.conn, performance.now(), spawn, hp);
    const state = world.getPlayer(playerId);
    const player: OnlinePlayer = {
      client,
      playerId,
      accountId: session.accountId,
      characterId: session.characterId,
      // 存档和进入世界时的状态不一样（比如新角色、死亡后重新上线）时，下次自动保存会写一次。
      lastMarked: saved && state && saved.x === state.x && saved.z === state.z && saved.hp === state.hp ? toSave(state) : null,
    };
    client.player = player;
    online.set(session.accountId, player);
  }

  // ---- 统计 ----

  interface TickWindow {
    ticks: number;
    totalMs: number;
    maxMs: number;
  }

  let currentWindow: TickWindow = { ticks: 0, totalMs: 0, maxMs: 0 };
  let lastWindow: TickWindow = { ticks: 0, totalMs: 0, maxMs: 0 };
  let maxTickMsEver = 0;
  let skippedTicks = 0;

  function statsSnapshot() {
    const w = lastWindow.ticks > 0 ? lastWindow : currentWindow;
    return {
      players: world.playerCount,
      monsters: world.monsterCount,
      tickMs: {
        avg: w.ticks > 0 ? round3(w.totalMs / w.ticks) : 0,
        max: round3(w.maxMs),
        maxSinceStart: round3(maxTickMsEver),
      },
      skippedTicks,
      unsavedCharacters: characters.pendingCount,
      ...world.stats,
      monsterPathfinds: world.monsterPathfinds,
    };
  }

  // ---- HTTP 与 WebSocket ----

  const httpServer = createServer(createHttpHandler({ auth, stats: statsSnapshot, staticFiles }));
  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH, maxPayload: MAX_PAYLOAD_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws) => {
    const client: Client = { ws, conn: createConnection(ws), joining: false, player: null };
    let tokens = MESSAGE_BURST;
    let lastMessageAt = performance.now();
    alive.set(ws, true);

    ws.on('pong', () => alive.set(ws, true));

    ws.on('message', (data, isBinary) => {
      const now = performance.now();
      tokens = Math.min(MESSAGE_BURST, tokens + ((now - lastMessageAt) / 1000) * MESSAGES_PER_SECOND);
      lastMessageAt = now;
      if (tokens < 1) {
        ws.close(1008, 'rate limit');
        return;
      }
      tokens--;

      if (isBinary) return;
      const msg = decodeClientMsg(data.toString());
      if (!msg) return;

      switch (msg.t) {
        case 'join':
          // 每个连接只处理一次 join，不管成功还是失败。
          if (client.joining) return;
          client.joining = true;
          void enter(client, msg.token);
          break;
        case 'moveTo':
          if (client.player) world.moveTo(client.player.playerId, msg.x, msg.z);
          break;
        case 'target':
          if (client.player) world.setTarget(client.player.playerId, msg.id);
          break;
        case 'ping':
          client.conn.send({ t: 'pong', c: msg.c, s: now });
          break;
      }
    });

    ws.on('close', () => {
      if (client.player) removeFromWorld(client.player);
    });

    ws.on('error', () => ws.terminate());
  });

  // 定期 ping，清理已经断开但没有正常关闭的连接。
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  // ---- 固定步长的主循环 ----

  const startedAt = performance.now();
  let tickIndex = 0;
  let loopTimer: NodeJS.Timeout | undefined;

  function loop(): void {
    let ran = 0;
    // tick 的时间用计划时间而不是实际时间，这样快照的时间戳是均匀的。
    while (startedAt + (tickIndex + 1) * TICK_MS <= performance.now() && ran < MAX_CATCHUP_TICKS) {
      tickIndex++;
      const t0 = performance.now();
      world.tick(startedAt + tickIndex * TICK_MS);
      const elapsed = performance.now() - t0;
      currentWindow.ticks++;
      currentWindow.totalMs += elapsed;
      if (elapsed > currentWindow.maxMs) currentWindow.maxMs = elapsed;
      if (elapsed > maxTickMsEver) maxTickMsEver = elapsed;
      ran++;
    }
    if (ran === MAX_CATCHUP_TICKS) {
      const behind = Math.floor((performance.now() - startedAt) / TICK_MS) - tickIndex;
      if (behind > 0) {
        skippedTicks += behind;
        tickIndex += behind;
      }
    }
    const next = startedAt + (tickIndex + 1) * TICK_MS;
    loopTimer = setTimeout(loop, Math.max(0, next - performance.now()));
  }

  const statsTimer = setInterval(() => {
    lastWindow = currentWindow;
    currentWindow = { ticks: 0, totalMs: 0, maxMs: 0 };
    if (world.playerCount > 0) {
      const s = statsSnapshot();
      console.log(
        `[stats] players=${s.players} tick avg=${s.tickMs.avg}ms max=${s.tickMs.max}ms ` +
          `pathfinds=${s.pathfinds} deferred=${s.deferredPathfinds} rejected=${s.rejectedMoves} skipped=${s.skippedTicks} ` +
          `monsters=${s.monsters} monsterPathfinds=${s.monsterPathfinds} hits=${s.hits}`,
      );
    }
  }, STATS_WINDOW_MS);

  // ---- 关服 ----

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // 兜底：数据库卡住时也要能退出。
    setTimeout(() => process.exit(1), SHUTDOWN_FLUSH_TIMEOUT_MS + 2000).unref();
    clearTimeout(loopTimer);
    clearTimeout(leaveFlushTimer);
    clearInterval(statsTimer);
    clearInterval(heartbeat);
    clearInterval(autosaveTimer);

    // 先把所有人的位置和血量记下来，再断开连接、写库。
    for (const player of [...online.values()]) removeFromWorld(player);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    wss.close();
    httpServer.close();

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        characters.flush(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('超时')), SHUTDOWN_FLUSH_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.error(`[db] 关服时保存角色失败，${characters.pendingCount} 个角色的位置和血量没有写进库：${errorText(err)}`);
    }
    clearTimeout(timeout);
    await Promise.allSettled([pool.end(), redis.close()]);
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // 监听失败（比如端口被占用）时，ws 会把 HTTP 服务器的 error 再转发一次，两边都要接住。
  const onListenError = (err: Error): void => {
    console.error(`[server] 无法监听端口 ${config.port}：${errorText(err)}`);
    process.exit(1);
  };
  httpServer.on('error', onListenError);
  wss.on('error', onListenError);
  httpServer.listen({ port: config.port, host: config.host }, () => {
    const host = config.host?.includes(':') ? `[${config.host}]` : (config.host ?? 'localhost');
    console.log(
      `[server] listening on http://${host}:${config.port} (WebSocket path ${WS_PATH}), ` +
        `map seed ${config.mapSeed}, ${monsters} monsters` +
        (staticFiles ? `, serving client from ${config.staticDir}` : ''),
    );
    loop();
  });
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

main().catch((err: unknown) => {
  console.error(`[server] 启动失败：${errorText(err)}`);
  process.exit(1);
});
