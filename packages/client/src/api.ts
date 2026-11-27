import { API_PATH } from '@mmo/shared';
import type { ApiError, AuthRequest, AuthSuccess } from '@mmo/shared';

export type AuthOutcome = ({ ok: true } & AuthSuccess) | { ok: false; message: string };

const SESSION_KEY = 'mmo25d.session';

// 接口和页面同源：开发时由 Vite 代理到游戏服务器，上线时由反向代理转发。

export function register(username: string, password: string): Promise<AuthOutcome> {
  return postAuth('register', { username, password });
}

export function login(username: string, password: string): Promise<AuthOutcome> {
  return postAuth('login', { username, password });
}

/** 让服务端的会话失效。失败也没关系，本地的令牌已经清掉了。 */
export function logout(token: string): void {
  fetch(`${API_PATH}/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
}

async function postAuth(action: 'register' | 'login', body: AuthRequest): Promise<AuthOutcome> {
  let res: Response;
  try {
    res = await fetch(`${API_PATH}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: '连不上游戏服务器，请确认它已经启动。' };
  }
  let data: Partial<AuthSuccess & ApiError> | null = null;
  try {
    data = (await res.json()) as Partial<AuthSuccess & ApiError>;
  } catch {
    // 不是 JSON（比如代理返回的错误页），按失败处理。
  }
  if (res.ok && typeof data?.token === 'string' && typeof data.name === 'string') {
    return { ok: true, token: data.token, name: data.name };
  }
  return { ok: false, message: typeof data?.message === 'string' ? data.message : `服务器返回了错误（${res.status}）。` };
}

// ---- 本地保存的登录状态 ----

export function loadSession(): AuthSuccess | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Partial<AuthSuccess> | null;
    if (value && typeof value.token === 'string' && typeof value.name === 'string') {
      return { token: value.token, name: value.name };
    }
  } catch {
    // 读不了 localStorage 或者内容损坏，都当作没登录。
  }
  return null;
}

export function saveSession(session: AuthSuccess): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // 隐私模式下可能不能写 localStorage，这时只是刷新页面后要重新登录。
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // 同上。
  }
}
