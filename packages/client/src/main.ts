import './style.css';
import {
  CLOSE_AUTH_FAILED,
  CLOSE_MAP_MISMATCH,
  CLOSE_REPLACED,
  CLOSE_SERVER_FULL,
  isValidPassword,
  isValidUsername,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '@mmo/shared';
import type { AuthSuccess } from '@mmo/shared';
import { clearSession, loadSession, login, logout, register, saveSession } from './api';
import { loadItemAssets } from './drops';
import { loadCharacterAssets } from './entities';
import { Game } from './game';
import { Hud } from './hud';
import { Net } from './net';
import { SoundPlayer } from './sound';

/**
 * 遮罩层的三种状态：
 * - login：没有登录，显示账号名和密码输入框；
 * - resume：浏览器里存着上次的登录，可以直接进入世界；
 * - ended：已经进过世界、之后断开了，只能刷新页面重新进入。
 */
type View = 'login' | 'resume' | 'ended';

const app = document.getElementById('app') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const form = document.getElementById('auth-form') as HTMLFormElement;
const fields = document.getElementById('login-fields') as HTMLElement;
const usernameInput = document.getElementById('username-input') as HTMLInputElement;
const passwordInput = document.getElementById('password-input') as HTMLInputElement;
const welcomeBack = document.getElementById('welcome-back') as HTMLElement;
const primaryButton = document.getElementById('primary-button') as HTMLButtonElement;
const secondaryButton = document.getElementById('secondary-button') as HTMLButtonElement;
const message = document.getElementById('overlay-message') as HTMLElement;
const hud = new Hud(document.getElementById('hud') as HTMLElement, document.getElementById('banner') as HTMLElement);
// 声音从登录页就准备着：浏览器要等用户点过、按过键才让出声，登录的那一下正好算数。
const sound = new SoundPlayer();
hud.setSoundOn(!sound.muted);
hud.onToggleSound = () => {
  sound.setMuted(!sound.muted);
  hud.setSoundOn(!sound.muted);
};
hud.onPanelSound = () => sound.play('click');

let view: View = 'login';
let busy = false;
let session: AuthSuccess | null = loadSession();
let assetsPromise: ReturnType<typeof loadAssets> | null = null;

/** 人物和物品的模型一起加载。哪个加载失败，哪个就用简单的形状代替，不影响进入游戏。 */
async function loadAssets() {
  const [characters, items] = await Promise.all([loadCharacterAssets(), loadItemAssets()]);
  return { characters, items };
}

show(session ? 'resume' : 'login');

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (busy) return;
  if (view === 'ended') location.reload();
  else if (view === 'resume') void enterWorld();
  else void authenticate('login');
});

secondaryButton.addEventListener('click', () => {
  if (busy) return;
  if (view === 'login') {
    void authenticate('register');
  } else if (view === 'resume') {
    if (session) logout(session.token);
    forgetSession();
    show('login');
  }
});

function show(next: View, text?: string): void {
  view = next;
  overlay.hidden = false;
  fields.hidden = next !== 'login';
  welcomeBack.hidden = next !== 'resume';
  welcomeBack.textContent = session ? `欢迎回来，${session.name}` : '';
  primaryButton.textContent = next === 'login' ? '登录' : next === 'resume' ? '进入世界' : '重新进入';
  secondaryButton.hidden = next === 'ended';
  secondaryButton.textContent = next === 'login' ? '注册新账号' : '换个账号';
  message.textContent = text ?? '';
  setBusy(false);
}

function setBusy(value: boolean): void {
  busy = value;
  for (const el of [usernameInput, passwordInput, primaryButton, secondaryButton]) el.disabled = value;
}

function forgetSession(): void {
  session = null;
  clearSession();
}

async function authenticate(action: 'login' | 'register'): Promise<void> {
  const username = normalizeUsername(usernameInput.value);
  const password = passwordInput.value;
  // 这里的检查只是为了尽早提示，真正的校验在服务端。
  if (!isValidUsername(username)) {
    message.textContent = `账号名需要 ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} 个字符，只能用文字、数字和下划线。`;
    usernameInput.focus();
    return;
  }
  if (!isValidPassword(password)) {
    message.textContent = `密码需要 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位。`;
    passwordInput.focus();
    return;
  }

  setBusy(true);
  message.textContent = action === 'login' ? '正在登录…' : '正在注册…';
  const outcome = await (action === 'login' ? login(username, password) : register(username, password));
  if (!outcome.ok) {
    setBusy(false);
    message.textContent = outcome.message;
    return;
  }
  passwordInput.value = '';
  session = { token: outcome.token, name: outcome.name };
  saveSession(session);
  await enterWorld();
}

async function enterWorld(): Promise<void> {
  if (!session) return;
  const token = session.token;
  setBusy(true);
  message.textContent = '正在加载模型…';
  assetsPromise ??= loadAssets();
  const assets = await assetsPromise;

  message.textContent = '正在连接服务器…';
  const net = new Net();
  let game: Game | null = null;
  let webglFailed = false;

  net.onMessage = (msg) => {
    if (msg.t !== 'welcome') {
      game?.handleMessage(msg);
      return;
    }
    try {
      game = new Game(app, net, hud, sound, assets.characters, assets.items, msg.selfId, msg.seed);
      overlay.hidden = true;
    } catch (err) {
      console.error(err);
      webglFailed = true;
      net.close();
      show('ended', '无法初始化 WebGL，请换一个支持 WebGL 2 的浏览器，或者打开硬件加速。');
    }
  };

  net.onClose = (code) => {
    if (webglFailed) return;
    game?.stop();
    if (code === CLOSE_AUTH_FAILED) {
      forgetSession();
      if (game) show('ended', '登录已失效，请重新进入后再登录。');
      else show('login', '登录已过期，请重新登录。');
    } else if (code === CLOSE_REPLACED) {
      show('ended', '这个账号在别处进入了游戏，这里的连接已断开。');
    } else if (code === CLOSE_MAP_MISMATCH) {
      show('ended', '地图已更新，请刷新页面后进入游戏。');
    } else if (game) {
      show('ended', '和服务器的连接断开了。');
    } else if (code === CLOSE_SERVER_FULL) {
      show('resume', '服务器人数已满，请稍后再试。');
    } else {
      show('resume', '连不上游戏服务器，请确认它已经启动。');
    }
  };

  net.connect(token);
}
