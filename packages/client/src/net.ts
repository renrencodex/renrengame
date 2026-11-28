import { CLOSE_MAP_MISMATCH, decodeServerMsg, encode, MAP_LAYOUT_VERSION, WS_PATH } from '@mmo/shared';
import type { ClientMsg, ServerMsg } from '@mmo/shared';

interface ClockSample {
  rtt: number;
  offset: number;
}

const FAST_PINGS = 5;
const FAST_PING_MS = 200;
const PING_MS = 1000;
const MAX_SAMPLES = 10;

/**
 * 和游戏服务器的 WebSocket 连接。
 *
 * 除了收发消息，还通过 ping/pong 估算延迟和服务器时钟：
 * 插值其他玩家时需要知道“现在服务器时间是多少”。
 */
export class Net {
  /** 最近一次测到的往返延迟（毫秒）。 */
  rtt = 0;
  onMessage: (msg: ServerMsg) => void = () => {};
  /** code 是 WebSocket 关闭码，用来区分会话过期、地图更新等断开原因。 */
  onClose: (code: number) => void = () => {};

  private ws: WebSocket | null = null;
  private offset = 0;
  private samples: ClockSample[] = [];
  private pingTimer: ReturnType<typeof setTimeout> | undefined;
  private pingsSent = 0;

  connect(token: string): void {
    // 始终连同源地址：开发时由 Vite 代理到游戏服务器，上线时由反向代理转发。
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}${WS_PATH}`);
    this.ws = ws;

    ws.onopen = () => {
      this.send({ t: 'join', token, mapVersion: MAP_LAYOUT_VERSION });
      this.ping();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const msg = decodeServerMsg(ev.data);
      if (!msg) return;
      if (msg.t === 'pong') {
        this.onPong(msg.c, msg.s);
        return;
      }
      if (msg.t === 'welcome') {
        if (msg.mapVersion !== MAP_LAYOUT_VERSION) {
          ws.close(CLOSE_MAP_MISMATCH, '地图版本不一致');
          return;
        }
        // 第一个 pong 回来之前，先用 welcome 里的时间粗略对时。
        if (this.samples.length === 0) this.offset = msg.serverTime - performance.now();
      }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      clearTimeout(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      this.onClose(ev.code);
    };
  }

  close(): void {
    this.ws?.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  /** 估算的当前服务器时间（毫秒，和快照里的 time 是同一个时钟）。 */
  serverNow(): number {
    return performance.now() + this.offset;
  }

  private ping(): void {
    this.send({ t: 'ping', c: performance.now() });
    this.pingsSent++;
    this.pingTimer = setTimeout(() => this.ping(), this.pingsSent < FAST_PINGS ? FAST_PING_MS : PING_MS);
  }

  private onPong(clientSentAt: number, serverTime: number): void {
    const now = performance.now();
    const rtt = now - clientSentAt;
    if (!(rtt >= 0)) return;
    this.rtt = rtt;
    // 假设去程和回程一样长，服务器收到 ping 的时刻对应本地的 (发送时刻 + rtt / 2)。
    this.samples.push({ rtt, offset: serverTime + rtt / 2 - now });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    // 延迟最小的那次测量受网络抖动影响最小，用它的结果。
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
  }
}
