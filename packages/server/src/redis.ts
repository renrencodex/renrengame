import { createClient } from 'redis';
import { errorText } from './errors';

/** 所有键都带这个前缀，方便和同一个 Redis 里的其他数据区分。 */
export const KEY_PREFIX = 'mmo:';

function create(url: string) {
  let everReady = false;
  let down = false;
  const client = createClient({
    url,
    // 断线期间的命令直接报错，而不是排队等重连：登录请求应该马上失败，不能一直挂着。
    disableOfflineQueue: true,
    socket: {
      // 启动时连不上就直接报错退出；运行中断线则一直重试。
      reconnectStrategy: (retries, cause) => (everReady ? Math.min(100 * (retries + 1), 2000) : cause),
    },
  });
  client.on('ready', () => {
    if (down) console.log('[redis] 已重新连上');
    everReady = true;
    down = false;
  });
  // 每次重连失败都会触发 error，只在刚断开时记一条日志。
  client.on('error', (err: unknown) => {
    if (down || !everReady) return;
    down = true;
    console.error(`[redis] 连接断开，正在重连：${errorText(err)}`);
  });
  return client;
}

export type Redis = ReturnType<typeof create>;

export async function connectRedis(url: string): Promise<Redis> {
  const client = create(url);
  try {
    await client.connect();
  } catch (err) {
    // 重连策略放弃时，node-redis 会把真正的原因包在 originalError 里。
    const reason = (err as { originalError?: unknown }).originalError ?? err;
    throw new Error(`连不上 Redis：${errorText(reason)}`, { cause: err });
  }
  return client;
}
