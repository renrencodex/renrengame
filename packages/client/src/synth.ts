import { mulberry32 } from '@mmo/shared';

/**
 * 游戏里的所有声效。它们都是在这里用几层简单的波形和噪声算出来的，没有音频文件：
 * 不用下载，没有授权问题，想调哪个声音改下面的参数就行。
 * 这个文件只做计算、不碰浏览器的音频接口，所以能直接单测；播放在 sound.ts。
 */
export const SOUND_IDS = [
  'punch',
  'slash',
  'claw',
  'hurt',
  'monsterDeath',
  'playerDeath',
  'respawn',
  'coin',
  'pickup',
  'drink',
  'equip',
  'unequip',
  'trade',
  'step',
  'click',
] as const;

export type SoundId = (typeof SOUND_IDS)[number];

/** 一层声音的音量怎么随时间变化。时间的单位都是秒。 */
interface Shape {
  /** 从整个声音开始算，这一层什么时候响。 */
  at?: number;
  duration: number;
  /** 从无声升到最响用的时间。 */
  attack?: number;
  /** 升到最响之后，每过这么久音量降到原来的 37%。 */
  decay: number;
  /** 这一层最响时的音量，相对于同一个声音里的其他层。 */
  gain: number;
}

/** 有音高的一层。频率从 from 滑到 to（赫兹）。 */
interface Tone extends Shape {
  type: 'sine' | 'triangle' | 'saw';
  from: number;
  to?: number;
  /** 把这个频率以上的部分削掉，锯齿波不削的话很刺耳。 */
  lowpass?: number;
  /** 音高的抖动：每秒几次、幅度多大（占频率的比例）。用来做出嘶吼那种粗糙的感觉。 */
  vibrato?: [rate: number, depth: number];
}

/** 噪声的一层：白噪声过一个滤波器，滤波器的频率从 from 滑到 to。 */
interface Noise extends Shape {
  type: 'noise';
  pass: 'low' | 'band' | 'high';
  from: number;
  to?: number;
  /** 滤波器有多尖，越大留下的频率范围越窄。 */
  q?: number;
}

type Layer = Tone | Noise;

/** 每层结尾留这么长的淡出，免得波形被直接截断，听起来“啪”的一声。 */
const RELEASE = 0.008;
const DEFAULT_ATTACK = 0.002;
/** 每个声音最响的地方都调到这个幅度，实际播放的音量在 sound.ts 里另外定。 */
const PEAK = 0.9;

/** 几枚硬币先后碰在一起。 */
function jingle(notes: number[], gap: number): Layer[] {
  return notes.flatMap((hz, i): Layer[] => [
    { type: 'sine', from: hz, at: i * gap, duration: 0.2, decay: 0.035, gain: 0.5 },
    { type: 'noise', pass: 'high', from: 5000, at: i * gap, duration: 0.012, decay: 0.004, gain: 0.15 },
  ]);
}

/**
 * 一枚硬币磕了一下。听起来是金属而不是“叮”的一声，靠的是三样：
 * 泛音不是基音的整数倍（用的是圆片振动的比例）；主要的两个音旁边各有一个只差一点点的音，
 * 叠在一起会微微颤动；最前面有一下很短的撞击声。越高的泛音消失得越快。
 * ring 是基音的余音有多长（Shape 里的 decay）。
 */
function clink(at: number, hz: number, ring: number, gain: number): Layer[] {
  const partial = (ratio: number, level: number, length: number): Layer => ({
    type: 'sine',
    from: hz * ratio,
    at,
    duration: ring * length * 4.5,
    attack: 0.001,
    decay: ring * length,
    gain: gain * level,
  });
  return [
    { type: 'noise', pass: 'high', from: 6000, at, duration: 0.008, attack: 0.0005, decay: 0.002, gain: gain * 0.4 },
    partial(1, 0.5, 1),
    partial(1.007, 0.25, 1),
    partial(1.73, 0.4, 0.7),
    partial(1.73 * 1.009, 0.2, 0.7),
    partial(2.33, 0.3, 0.5),
    partial(3.91, 0.15, 0.3),
  ];
}

/** 一串音符，一个接一个地响起，前一个还没消失后一个就进来。 */
function arpeggio(type: Tone['type'], notes: number[], gap: number, shape: Omit<Shape, 'at'>): Layer[] {
  return notes.map((hz, i): Layer => ({ ...shape, type, from: hz, at: i * gap }));
}

const RECIPES: Record<SoundId, Layer[]> = {
  // 拳头打中：一下闷响，加上一点皮肉的“啪”。
  punch: [
    { type: 'sine', from: 170, to: 60, duration: 0.14, decay: 0.035, gain: 1 },
    { type: 'noise', pass: 'band', from: 900, to: 500, duration: 0.07, decay: 0.014, gain: 0.7 },
    { type: 'noise', pass: 'high', from: 2500, duration: 0.02, decay: 0.005, gain: 0.25 },
  ],
  // 挥剑：先是划过空气的风声，然后砍中，带一点金属的余音。
  slash: [
    { type: 'noise', pass: 'band', from: 900, to: 4500, q: 1.6, duration: 0.2, attack: 0.09, decay: 0.05, gain: 0.8 },
    { type: 'noise', pass: 'high', from: 3500, at: 0.13, duration: 0.07, decay: 0.016, gain: 0.6 },
    { type: 'sine', from: 150, to: 70, at: 0.13, duration: 0.09, decay: 0.025, gain: 0.5 },
    { type: 'sine', from: 2350, at: 0.13, duration: 0.2, decay: 0.045, gain: 0.12 },
    { type: 'sine', from: 3730, at: 0.13, duration: 0.18, decay: 0.035, gain: 0.08 },
  ],
  // 行尸打别人：低沉的一声嘶吼，加上抓挠的声音。
  claw: [
    { type: 'saw', from: 130, to: 75, lowpass: 700, vibrato: [30, 0.08], duration: 0.2, attack: 0.015, decay: 0.07, gain: 0.6 },
    { type: 'noise', pass: 'band', from: 700, to: 300, q: 1, duration: 0.12, decay: 0.03, gain: 0.7 },
  ],
  // 自己挨打：比打别人更闷、更重，带一声往下掉的“呃”。
  hurt: [
    { type: 'sine', from: 140, to: 50, duration: 0.16, decay: 0.045, gain: 1 },
    { type: 'noise', pass: 'low', from: 1400, to: 400, duration: 0.09, decay: 0.02, gain: 0.7 },
    { type: 'triangle', from: 330, to: 190, at: 0.02, duration: 0.2, attack: 0.01, decay: 0.06, gain: 0.35 },
  ],
  // 行尸倒下：越来越低的呻吟，最后是身体倒地的一声。
  monsterDeath: [
    { type: 'saw', from: 150, to: 48, lowpass: 800, vibrato: [22, 0.06], duration: 0.6, attack: 0.03, decay: 0.22, gain: 0.7 },
    { type: 'saw', from: 226, to: 70, lowpass: 1000, duration: 0.5, attack: 0.03, decay: 0.18, gain: 0.3 },
    { type: 'noise', pass: 'low', from: 500, to: 150, at: 0.42, duration: 0.25, decay: 0.07, gain: 0.8 },
    { type: 'sine', from: 90, to: 45, at: 0.42, duration: 0.2, decay: 0.06, gain: 0.7 },
  ],
  // 玩家倒下：四个一路往下走的音。
  playerDeath: [
    ...arpeggio('triangle', [392, 311, 233, 196], 0.16, { duration: 0.4, attack: 0.01, decay: 0.16, gain: 0.6 }),
    ...arpeggio('sine', [196, 156, 117, 98], 0.16, { duration: 0.4, attack: 0.01, decay: 0.16, gain: 0.3 }),
    { type: 'sine', from: 110, to: 45, duration: 0.2, decay: 0.06, gain: 0.6 },
  ],
  // 复活：四个一路往上走的音，上面有一层很轻的气声。
  respawn: [
    ...arpeggio('sine', [523, 659, 784, 1047], 0.08, { duration: 0.5, attack: 0.008, decay: 0.16, gain: 0.5 }),
    ...arpeggio('sine', [1047, 1319, 1568, 2093], 0.08, { duration: 0.4, attack: 0.008, decay: 0.1, gain: 0.12 }),
    { type: 'noise', pass: 'high', from: 5000, duration: 0.5, attack: 0.2, decay: 0.15, gain: 0.05 },
  ],
  // 捡到金币：硬币落进钱袋，磕了两下。第一下短，第二下高一些、余音长一些。
  coin: [...clink(0, 2640, 0.05, 0.7), ...clink(0.075, 3520, 0.11, 1)],
  // 捡到别的东西：往上滑的一声“啵”。
  pickup: [
    { type: 'sine', from: 420, to: 880, duration: 0.11, attack: 0.005, decay: 0.06, gain: 0.8 },
    { type: 'sine', from: 840, to: 1760, duration: 0.11, attack: 0.005, decay: 0.04, gain: 0.2 },
    { type: 'noise', pass: 'band', from: 2000, q: 1, duration: 0.03, decay: 0.008, gain: 0.15 },
  ],
  // 喝药水：咕咚三口，然后是回血的两三个柔和的音。
  drink: [
    ...[0, 1, 2].flatMap((i): Layer[] => [
      { type: 'sine', from: 260 + i * 40, to: 480 + i * 60, at: i * 0.12, duration: 0.085, attack: 0.012, decay: 0.06, gain: 0.7 },
      { type: 'noise', pass: 'low', from: 900, at: i * 0.12, duration: 0.06, decay: 0.02, gain: 0.12 },
    ]),
    { type: 'sine', from: 659, at: 0.38, duration: 0.4, attack: 0.01, decay: 0.13, gain: 0.4 },
    { type: 'sine', from: 988, at: 0.44, duration: 0.36, attack: 0.01, decay: 0.12, gain: 0.35 },
    { type: 'sine', from: 1319, at: 0.5, duration: 0.3, attack: 0.01, decay: 0.1, gain: 0.2 },
  ],
  // 把剑拿到手里：剑身擦过的声音，然后是金属的一声“铮”。
  equip: [
    { type: 'noise', pass: 'band', from: 2500, to: 7000, q: 2.5, duration: 0.16, attack: 0.05, decay: 0.06, gain: 0.6 },
    { type: 'noise', pass: 'high', from: 4000, at: 0.12, duration: 0.015, decay: 0.004, gain: 0.4 },
    { type: 'sine', from: 1870, at: 0.12, duration: 0.32, decay: 0.09, gain: 0.3 },
    { type: 'sine', from: 3120, at: 0.12, duration: 0.32, decay: 0.07, gain: 0.22 },
    { type: 'sine', from: 4370, at: 0.12, duration: 0.3, decay: 0.05, gain: 0.15 },
    { type: 'sine', from: 5980, at: 0.12, duration: 0.25, decay: 0.04, gain: 0.1 },
  ],
  // 把剑收起来：擦过的声音由高到低，最后轻轻一磕。
  unequip: [
    { type: 'noise', pass: 'band', from: 6000, to: 1800, q: 2, duration: 0.18, attack: 0.03, decay: 0.07, gain: 0.6 },
    { type: 'sine', from: 220, to: 130, at: 0.17, duration: 0.09, decay: 0.025, gain: 0.6 },
    { type: 'noise', pass: 'low', from: 1200, at: 0.17, duration: 0.04, decay: 0.01, gain: 0.3 },
  ],
  // 和商人买卖：一把硬币的声音。
  trade: jingle([2093, 2637, 2349, 3136, 2794], 0.047),
  // 自己的脚步：很轻的一下。
  step: [
    { type: 'noise', pass: 'low', from: 700, to: 250, duration: 0.08, attack: 0.003, decay: 0.02, gain: 0.8 },
    { type: 'sine', from: 110, to: 60, duration: 0.06, decay: 0.02, gain: 0.5 },
  ],
  // 打开、关上面板。
  click: [
    { type: 'sine', from: 1500, to: 1100, duration: 0.04, decay: 0.01, gain: 0.7 },
    { type: 'noise', pass: 'band', from: 3000, q: 1, duration: 0.012, decay: 0.004, gain: 0.2 },
  ],
};

/**
 * 算出一个声效的波形：单声道，幅度在 ±PEAK 之内，开头和结尾都是 0。
 * 同一个声效每次算出来完全一样（噪声用的是固定种子的伪随机数）。
 */
export function renderSound(id: SoundId, sampleRate: number): Float32Array<ArrayBuffer> {
  const layers = RECIPES[id];
  // 每一层占哪些采样要和 addLayer 里算得一模一样：分开取整的话，起点和长度各进一位，最后一层会多出一个采样。
  let end = 0;
  for (const layer of layers) end = Math.max(end, layerStart(layer, sampleRate) + layerLength(layer, sampleRate));
  // 多留一个采样，保证最后一个一定是 0。
  const out = new Float32Array(end + 1);
  const random = mulberry32(0x5eed + SOUND_IDS.indexOf(id));
  for (const layer of layers) addLayer(out, sampleRate, layer, random);

  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) {
    const scale = PEAK / peak;
    for (let i = 0; i < out.length; i++) out[i] *= scale;
  }
  return out;
}

function layerStart(layer: Layer, rate: number): number {
  return Math.round((layer.at ?? 0) * rate);
}

function layerLength(layer: Layer, rate: number): number {
  return Math.max(1, Math.round(layer.duration * rate));
}

function addLayer(out: Float32Array, rate: number, layer: Layer, random: () => number): void {
  const n = layerLength(layer, rate);
  const raw = new Float32Array(n);
  if (layer.type === 'noise') {
    for (let i = 0; i < n; i++) raw[i] = random() * 2 - 1;
    filter(raw, rate, layer.pass, layer.from, layer.to ?? layer.from, layer.q ?? 0.7);
  } else {
    oscillate(raw, rate, layer);
    if (layer.lowpass) filter(raw, rate, 'low', layer.lowpass, layer.lowpass, 0.7);
  }

  // 滤波之后各层的响度差得很远，先都调到同样的幅度，gain 才有可比性。
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(raw[i]));
  if (peak === 0) return;

  const start = layerStart(layer, rate);
  const attack = layer.attack ?? DEFAULT_ATTACK;
  const scale = layer.gain / peak;
  // 每个采样乘一次，比每次都算指数快得多；这些循环加起来要跑几十万次。
  const fallStep = Math.exp(-1 / (rate * layer.decay));
  let fall = 1;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / rate;
    const rise = Math.min(1, t / attack);
    if (t > attack) fall *= fallStep;
    const release = Math.min(1, (layer.duration - t) / RELEASE);
    out[start + i] += raw[i] * scale * rise * fall * release;
  }
}

function oscillate(raw: Float32Array, rate: number, tone: Tone): void {
  const n = raw.length;
  // 频率按比例滑动（每个采样乘上同样的倍数），听起来是匀速地变高或变低。
  const glide = ((tone.to ?? tone.from) / tone.from) ** (1 / n);
  const [vibratoRate, vibratoDepth] = tone.vibrato ?? [0, 0];
  let phase = 0;
  let base = tone.from;
  for (let i = 0; i < n; i++) {
    let hz = base;
    base *= glide;
    if (vibratoDepth > 0) hz *= 1 + vibratoDepth * Math.sin((2 * Math.PI * vibratoRate * i) / rate);
    const turn = phase - Math.floor(phase);
    raw[i] =
      tone.type === 'sine'
        ? Math.sin(2 * Math.PI * turn)
        : tone.type === 'triangle'
          ? 1 - 4 * Math.abs(turn - 0.5)
          : 2 * turn - 1;
    phase += hz / rate;
  }
}

/**
 * 原地做二阶滤波（状态变量滤波器的零延迟写法，截止频率一直在变也不会发散）。
 * 截止频率从 from 按比例滑到 to。
 */
function filter(data: Float32Array, rate: number, pass: Noise['pass'], from: number, to: number, q: number): void {
  const n = data.length;
  const ratio = to / from;
  const k = 1 / q;
  let ic1 = 0;
  let ic2 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  for (let i = 0; i < n; i++) {
    // 系数每 16 个采样更新一次就够了，频率变化没有那么快。
    if ((i & 15) === 0) {
      const hz = Math.min(from * ratio ** (i / n), rate * 0.45);
      const g = Math.tan((Math.PI * hz) / rate);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    }
    const x = data[i];
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    data[i] = pass === 'low' ? v2 : pass === 'band' ? v1 : x - k * v1 - v2;
  }
}
