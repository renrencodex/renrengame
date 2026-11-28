import { ITEM_IDS } from '@mmo/shared';
import type { Inventory, ItemId } from '@mmo/shared';
import { renderSound, SOUND_IDS } from './synth';
import type { SoundId } from './synth';

const MUTED_KEY = 'mmo25d.muted';
const MASTER_VOLUME = 0.6;
/** 离自己这么远的声音就听不到了。和画面拉到最远时看得到的范围差不多。 */
export const HEARING_DISTANCE = 30;
/** 最多同时响这么多个声音，再多的不播。 */
const MAX_VOICES = 14;
/** 同一种声音两次之间至少隔这么久。一群人围着打的时候，同时到的几下只响一下。 */
const MIN_REPEAT_MS = 45;

/** 每种声音播放时的音量，以及每次播放时音高随机浮动的幅度（让连续的几下听起来不完全一样）。 */
const MIX: Record<SoundId, { gain: number; jitter: number }> = {
  punch: { gain: 0.7, jitter: 0.08 },
  slash: { gain: 0.6, jitter: 0.06 },
  claw: { gain: 0.55, jitter: 0.1 },
  hurt: { gain: 0.8, jitter: 0.05 },
  monsterDeath: { gain: 0.6, jitter: 0.1 },
  playerDeath: { gain: 0.6, jitter: 0 },
  respawn: { gain: 0.5, jitter: 0 },
  // 金币的声音很短、很尖，同样的幅度听起来比一声长音轻得多，所以比别的捡东西的声音开得大。
  coin: { gain: 0.7, jitter: 0.03 },
  pickup: { gain: 0.45, jitter: 0.03 },
  drink: { gain: 0.5, jitter: 0 },
  equip: { gain: 0.45, jitter: 0.03 },
  unequip: { gain: 0.4, jitter: 0.03 },
  trade: { gain: 0.45, jitter: 0.04 },
  step: { gain: 0.16, jitter: 0.12 },
  click: { gain: 0.25, jitter: 0 },
};

/** 离自己 distance 远的声音还剩多大音量：脚边是 1，越远越小，到 HEARING_DISTANCE 正好是 0。 */
export function distanceVolume(distance: number): number {
  if (!(distance < HEARING_DISTANCE)) return 0;
  const near = 1 - Math.max(0, distance) / HEARING_DISTANCE;
  return near * near;
}

/**
 * 背包从 before 变成 after（weapon 是手里的武器）时该响什么声音，没什么可响的返回 null。
 * 服务器只发整个背包，不说它为什么变了，所以和飘字一样靠前后比较：
 * 金币和物品一增一减是买卖，药水少了是喝掉了，只是多了东西就是捡到的。
 * 装备和卸下时总数不变，这里不管，它们的声音跟着 weapon 消息走。
 */
export function inventorySound(
  before: Inventory,
  weaponBefore: ItemId | null,
  after: Inventory,
  weaponAfter: ItemId | null,
): SoundId | null {
  const gold = (after.gold ?? 0) - (before.gold ?? 0);
  let gained = false;
  let lost = false;
  for (const id of ITEM_IDS) {
    if (id === 'gold') continue;
    // 手里的那一件也算进去，这样把武器拿起来、收回去不算多了或者少了一件。
    const delta = (after[id] ?? 0) + (weaponAfter === id ? 1 : 0) - (before[id] ?? 0) - (weaponBefore === id ? 1 : 0);
    if (delta > 0) gained = true;
    else if (delta < 0) lost = true;
  }
  if ((gold < 0 && gained) || (gold > 0 && lost)) return 'trade';
  if (lost && gold === 0 && (after.potion ?? 0) < (before.potion ?? 0)) return 'drink';
  if (gold > 0) return 'coin';
  if (gained) return 'pickup';
  return null;
}

/** 限制同时响的声音数量，以及同一种声音重复的频率。 */
export class SoundThrottle {
  private readonly last = new Map<SoundId, { at: number; volume: number }>();
  private active = 0;

  /**
   * 现在能不能再响一个 id。能的话记一笔，等它响完要调用 finish。
   * 刚响过同一种声音时，只有比刚才那一下更响的才放行：
   * 远处别人的一拳不能把紧跟着的自己的一拳挡掉，反过来则没关系。
   */
  tryStart(id: SoundId, now: number, volume = 1): boolean {
    if (this.active >= MAX_VOICES) return false;
    const last = this.last.get(id);
    if (last && now - last.at < MIN_REPEAT_MS) {
      if (volume <= last.volume) return false;
      // 时间不更新：这段时间里放行过的最响的那一下说了算，间隔还是从第一下算起。
      last.volume = volume;
    } else {
      this.last.set(id, { at: now, volume });
    }
    this.active++;
    return true;
  }

  finish(): void {
    if (this.active > 0) this.active--;
  }
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    // 读不了 localStorage 时当作没有静音。
    return false;
  }
}

function saveMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(MUTED_KEY, '1');
    else localStorage.removeItem(MUTED_KEY);
  } catch {
    // 隐私模式下可能不能写，这时只是刷新页面后又有声音了。
  }
}

/**
 * 播放声效。
 *
 * 浏览器只允许在用户点过、按过键之后出声，所以音频设备是在第一次点击或按键时才打开的；
 * 在那之前，以及静音、页面切到后台的时候，play 什么也不做。
 * 所有声音都只是给玩家的反馈，播不出来（浏览器不支持、被系统打断）不影响游戏。
 */
export class SoundPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buffers = new Map<SoundId, AudioBuffer>();
  private readonly playing = new Set<AudioBufferSourceNode>();
  private readonly throttle = new SoundThrottle();
  private isMuted = loadMuted();
  private failed = false;
  /** 已经要求设备停下（静音、切到后台），之后还没有要求它恢复。 */
  private resting = false;

  constructor() {
    // 一直听着，不是只听第一次：手机上来电话、切走再回来之后，音频会被系统停掉，要再点一下才能恢复。
    // 各个浏览器认哪些事件算“用户操作”不一样（有的认按下，有的要到抬起），所以都听。
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const) {
      window.addEventListener(type, this.wake, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.silence();
      else this.wake();
    });
  }

  get muted(): boolean {
    return this.isMuted;
  }

  /** 开关声音。这个选择记在浏览器里，下次打开还是这样。 */
  setMuted(muted: boolean): void {
    this.isMuted = muted;
    saveMuted(muted);
    if (muted) this.silence();
    else this.wake();
  }

  /**
   * 播放一个声效。volume 是 0 到 1 的音量；pan 是左右的位置，-1 最左，1 最右。
   */
  play(id: SoundId, volume = 1, pan = 0): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(id);
    // 设备没在运行时不能把声音排进去：它们会攒着，等恢复的时候一起响。
    if (this.isMuted || !ctx || !this.master || !buffer || ctx.state !== 'running') return;
    if (!(volume > 0.01) || !this.throttle.tryStart(id, performance.now(), volume)) return;

    const mix = MIX[id];
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * mix.jitter;
    const gain = ctx.createGain();
    gain.gain.value = mix.gain * Math.min(1, volume);
    source.connect(gain);
    let last: AudioNode = gain;
    // 位置算不出来（不是有效的数）时放在中间；把这样的值交给音频接口会抛异常。
    if (pan !== 0 && Number.isFinite(pan) && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      last = panner;
    }
    last.connect(this.master);
    this.playing.add(source);
    source.onended = () => {
      this.playing.delete(source);
      this.throttle.finish();
      last.disconnect();
    };
    source.start();
  }

  /** 打开音频设备（第一次），或者把被停掉的设备恢复过来。只有在用户操作的时候调用才有用。 */
  private readonly wake = (): void => {
    if (this.isMuted || this.failed || document.hidden) return;
    if (!this.ctx) {
      try {
        this.open();
      } catch (err) {
        // 浏览器不支持或者不让用：以后不再尝试，游戏照常。
        this.failed = true;
        console.warn('无法播放声音。', err);
        return;
      }
    }
    // resting：刚让设备歇下，它的状态可能还没来得及变，这时也要恢复，不然等它真的停了就没人叫醒了。
    if (this.ctx && (this.ctx.state !== 'running' || this.resting)) {
      this.resting = false;
      void this.ctx.resume().catch(() => {});
    }
  };

  private open(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    // 很多声音同时响的时候压一下，不让它们加起来爆音。
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    limiter.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = MASTER_VOLUME;
    master.connect(limiter);
    this.ctx = ctx;
    this.master = master;
    this.renderFrom(ctx, 0);
  }

  /**
   * 把声效的波形一个一个算出来，每算完一个让出一次，不让页面卡住。
   * 设备是在登录页上第一次点击或按键时打开的，等进了世界早就算完了；还没算好的声音先不响。
   */
  private renderFrom(ctx: AudioContext, index: number): void {
    if (index >= SOUND_IDS.length) return;
    const id = SOUND_IDS[index];
    const samples = renderSound(id, ctx.sampleRate);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    this.buffers.set(id, buffer);
    setTimeout(() => this.renderFrom(ctx, index + 1), 0);
  }

  /** 停掉正在响的声音并让设备歇着。不停掉的话，它们会在恢复的时候接着响完。 */
  private silence(): void {
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        // 已经停了。
      }
    }
    if (this.ctx && this.ctx.state === 'running') {
      this.resting = true;
      void this.ctx.suspend().catch(() => {});
    }
  }
}
