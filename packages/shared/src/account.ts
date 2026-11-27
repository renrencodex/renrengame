import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from './constants';

/** 注册和登录接口的请求体。 */
export interface AuthRequest {
  username: string;
  password: string;
}

/** 注册或登录成功。token 用来在 WebSocket 上进入游戏。 */
export interface AuthSuccess {
  token: string;
  name: string;
}

export type ApiErrorCode =
  | 'bad_request'
  | 'invalid_username'
  | 'invalid_password'
  | 'username_taken'
  | 'bad_credentials'
  | 'too_many_attempts'
  | 'unavailable';

/** 接口失败时的响应体。message 是可以直接显示给玩家的中文。 */
export interface ApiError {
  error: ApiErrorCode;
  message: string;
}

const USERNAME_PATTERN = /^[\p{L}\p{N}_]+$/u;

/** 统一全角/半角等写法并去掉首尾空白。校验和入库前都要先调用。 */
export function normalizeUsername(raw: string): string {
  return raw.normalize('NFKC').trim();
}

/** 账号名只允许文字、数字和下划线。传入的应该是 normalizeUsername 之后的结果。 */
export function isValidUsername(name: string): boolean {
  const length = Array.from(name).length;
  return length >= USERNAME_MIN_LENGTH && length <= USERNAME_MAX_LENGTH && USERNAME_PATTERN.test(name);
}

export function isValidPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}
