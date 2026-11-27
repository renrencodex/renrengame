import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_PATH, MAX_TOKEN_LENGTH } from '@mmo/shared';
import type { ApiError } from '@mmo/shared';
import type { Auth, AuthResult } from './auth';
import { errorText } from './errors';
import { serveStatic } from './static';
import type { StaticFiles } from './static';

/** 请求体的大小上限（字节）。账号名加密码远小于这个值。 */
const MAX_BODY_BYTES = 2048;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

export interface HttpDeps {
  auth: Auth;
  stats: () => unknown;
  /** 构建好的客户端页面。不提供时（比如开发时页面由 Vite 提供）只有接口可用。 */
  staticFiles?: StaticFiles;
}

/** 游戏服务器的 HTTP 接口：/stats 和 /api 下的注册、登录、退出；配置了的话还提供客户端页面。 */
export function createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(deps, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        // 请求体可能还没读完，回应之后关掉连接，不让剩下的数据被当成下一个请求。
        res.setHeader('connection', 'close');
        sendJson(res, err.status, err.body);
        return;
      }
      // 走到这里通常是数据库或 Redis 出了问题。细节只写日志，不返回给客户端。
      console.error(`[http] ${req.method} ${req.url} 失败：${errorText(err)}`);
      sendJson(res, 503, { error: 'unavailable', message: '服务器暂时不可用，请稍后再试。' } satisfies ApiError);
    });
  };
}

async function handle(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?', 1)[0];

  if (req.method === 'GET' && path === '/stats') {
    sendJson(res, 200, deps.stats());
    return;
  }
  if (req.method === 'POST' && path === `${API_PATH}/register`) {
    const body = await readJsonBody(req);
    sendAuthResult(res, await deps.auth.register(body.username, body.password));
    return;
  }
  if (req.method === 'POST' && path === `${API_PATH}/login`) {
    const body = await readJsonBody(req);
    sendAuthResult(res, await deps.auth.login(body.username, body.password));
    return;
  }
  if (req.method === 'POST' && path === `${API_PATH}/logout`) {
    const token = bearerToken(req);
    if (token) await deps.auth.logout(token);
    res.writeHead(204);
    res.end();
    return;
  }
  if (deps.staticFiles && serveStatic(deps.staticFiles, req, res)) return;
  res.writeHead(404);
  res.end();
}

function sendAuthResult(res: ServerResponse, result: AuthResult): void {
  if (result.ok) sendJson(res, 200, { token: result.token, name: result.name });
  else sendJson(res, result.status, { error: result.error, message: result.message });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string | null {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  return match && match[1].length <= MAX_TOKEN_LENGTH ? match[1] : null;
}

/** 读取 JSON 对象形式的请求体。太大或者不是 JSON 对象时抛出 HttpError。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const badRequest = new HttpError(400, { error: 'bad_request', message: '请求格式不正确。' });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw badRequest;
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest;
  return value as Record<string, unknown>;
}
