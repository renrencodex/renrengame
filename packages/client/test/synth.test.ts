import { describe, expect, it } from 'vitest';
import { renderSound, SOUND_IDS } from '../src/synth';
import type { SoundId } from '../src/synth';

const RATE = 44100;

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  return peak;
}

/** 每秒穿过零点多少次。不用做频谱分析，也能大致看出一个声音是低沉的还是清脆的。 */
function crossingsPerSecond(samples: Float32Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 !== samples[i] < 0) crossings++;
  }
  return (crossings * rate) / samples.length;
}

/** 声音里 hz 这个频率有多强（加了窗，旁边的频率漏不过来）。 */
function powerAt(samples: Float32Array, rate: number, hz: number): number {
  const w = (2 * Math.PI * hz) / rate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples.length - 1)));
    re += v * Math.cos(w * i);
    im += v * Math.sin(w * i);
  }
  return re * re + im * im;
}

/** 声音里最突出的几个频率（赫兹），从低到高。比最强的那个弱 20 分贝以上的不算。 */
function strongestFrequencies(samples: Float32Array, rate: number): number[] {
  const STEP = 20;
  const powers: number[] = [];
  for (let hz = 500; hz <= 12000; hz += STEP) powers.push(powerAt(samples, rate, hz));
  const top = Math.max(...powers);
  const peaks: number[] = [];
  for (let i = 1; i < powers.length - 1; i++) {
    if (powers[i] > top / 100 && powers[i] > powers[i - 1] && powers[i] >= powers[i + 1]) peaks.push(500 + i * STEP);
  }
  return peaks;
}

/** 声音里最响的那一刻在第几秒。 */
function loudestAt(samples: Float32Array, rate: number): number {
  let at = 0;
  for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i]) > Math.abs(samples[at])) at = i;
  return at / rate;
}

describe('renderSound', () => {
  it.each(SOUND_IDS)('%s：有声音、不超幅、开头结尾都是 0、长度合适', (id) => {
    const samples = renderSound(id, RATE);
    expect(samples.every((v) => Number.isFinite(v))).toBe(true);
    // 最响的地方正好是 0.9，留着余量，几个声音叠在一起也不容易爆音。
    expect(peakOf(samples)).toBeCloseTo(0.9, 5);
    // 开头和结尾不能有突然的跳变，不然会“啪”的一声。
    expect(Math.abs(samples[0])).toBeLessThan(0.01);
    expect(Math.abs(samples[samples.length - 2])).toBeLessThan(0.01);
    expect(samples[samples.length - 1]).toBe(0);
    const seconds = samples.length / RATE;
    expect(seconds).toBeGreaterThan(0.03);
    expect(seconds).toBeLessThan(1.2);
  });

  it('同一个声音每次算出来都一样', () => {
    for (const id of SOUND_IDS) expect(renderSound(id, RATE)).toEqual(renderSound(id, RATE));
  });

  it('不同的采样率下时长相同', () => {
    for (const id of SOUND_IDS) {
      const a = renderSound(id, 44100).length / 44100;
      const b = renderSound(id, 48000).length / 48000;
      expect(Math.abs(a - b)).toBeLessThan(0.001);
    }
  });

  it('经常响的声音都很短，不会连成一片', () => {
    const seconds = (id: SoundId) => renderSound(id, RATE).length / RATE;
    expect(seconds('step')).toBeLessThan(0.12);
    expect(seconds('click')).toBeLessThan(0.08);
    expect(seconds('punch')).toBeLessThan(0.2);
    expect(seconds('claw')).toBeLessThan(0.3);
    // 攻击间隔是 0.8 秒，挥剑的声音要在下一剑之前结束。
    expect(seconds('slash')).toBeLessThan(0.5);
  });

  it('打击和脚步是低沉的，金币和金属是清脆的', () => {
    const rate = (id: SoundId) => crossingsPerSecond(renderSound(id, RATE), RATE);
    for (const id of ['punch', 'hurt', 'claw', 'monsterDeath', 'step'] as const) expect(rate(id)).toBeLessThan(1500);
    for (const id of ['coin', 'trade', 'equip'] as const) expect(rate(id)).toBeGreaterThan(2000);
    // 最清脆的和最低沉的差得很远。
    expect(rate('trade')).toBeGreaterThan(rate('step') * 4);
  });

  it('金币是金属的声音：很尖，几个泛音之间不成整数倍', () => {
    const samples = renderSound('coin', RATE);
    // 比别的捡东西的声音尖得多。
    expect(crossingsPerSecond(samples, RATE)).toBeGreaterThan(crossingsPerSecond(renderSound('pickup', RATE), RATE) * 2);

    // 只看第二下刚响起来的那一小段。整段一起看的话，余音里每个频率都窄得像一根针，隔 20 赫兹看一眼会漏掉。
    const peaks = strongestFrequencies(samples.subarray(Math.round(0.08 * RATE), Math.round(0.14 * RATE)), RATE);
    expect(peaks.length).toBeGreaterThanOrEqual(3);
    // 泛音是基音的 2 倍、3 倍的话听起来是笛子、铃声那样的“叮”，对不上才有金属的味道。
    const base = peaks[0];
    const offBeat = peaks.filter((hz) => {
      const ratio = hz / base;
      return Math.abs(ratio - Math.round(ratio)) > 0.15;
    });
    expect(offBeat.length).toBeGreaterThanOrEqual(2);
  });

  it('金币一上来就响（有撞击的那一下），不是慢慢响起来的', () => {
    expect(loudestAt(renderSound('coin', RATE), RATE)).toBeLessThan(0.1);
    // 磕了两下：第二下开始的时候比它前面那一小段响。
    const samples = renderSound('coin', RATE);
    const loudness = (from: number, to: number) => {
      let sum = 0;
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) sum += samples[i] * samples[i];
      return sum / ((to - from) * RATE);
    };
    expect(loudness(0.075, 0.095)).toBeGreaterThan(loudness(0.05, 0.07) * 2);
  });

  it('拳头一上来就是最响的；挥剑先有风声，砍中在后面', () => {
    expect(loudestAt(renderSound('punch', RATE), RATE)).toBeLessThan(0.03);
    expect(loudestAt(renderSound('hurt', RATE), RATE)).toBeLessThan(0.03);
    const cut = loudestAt(renderSound('slash', RATE), RATE);
    expect(cut).toBeGreaterThan(0.08);
    expect(cut).toBeLessThan(0.25);
  });
});
