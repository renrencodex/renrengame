import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { CharacterKind, ItemId } from '@mmo/shared';
import { createHeldWeapon } from './drops';
import type { ItemAssets } from './drops';

/** 一个人物模型：骨骼、网格和它自带的动作。同一个模型的所有角色共用几何体和动作数据。 */
export interface CharacterModel {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** 站立时的身高。 */
  height: number;
}

/** 游戏用到的全部人物模型。 */
export interface CharacterAssets {
  male: CharacterModel;
  female: CharacterModel;
}

/** 创建一个角色的显示对象需要的信息。 */
export interface EntityViewInfo {
  id: number;
  /** npc 是不会动、不能打的角色（商人）。它不是服务器下发的实体，只在客户端有。 */
  kind: CharacterKind | 'npc';
  name: string;
  hp: number;
  maxHp: number;
}

/** 没有模型、用胶囊体代替时的身高。 */
const FALLBACK_HEIGHT = 1.8;
const LABEL_GAP = 0.45;
const FADE_SECONDS = 0.15;
const TURN_SHARPNESS = 14;
/** 被打中时全身闪一下红色，持续这么久。 */
const FLASH_SECONDS = 0.18;
const FLASH_COLOR = new THREE.Color(0xff3020);

/** 模型里的动作名字（来自 Quaternius 的 Universal Animation Library）。 */
const CLIP_IDLE = 'Idle_Loop';
const CLIP_RUN = 'Jog_Fwd_Loop';
const CLIP_PUNCHES = ['Punch_Jab', 'Punch_Cross'];
const CLIP_SWING = 'Sword_Attack';
/** 握着剑的戒备姿势。挥剑的动作从它开始、到它结束。 */
const CLIP_GUARD = 'Sword_Idle';
const CLIP_DEATH = 'Death01';
/** 模型里右手上挂武器的节点，见 tools/models/build.mjs。 */
const WEAPON_NODE = 'Weapon_R';
/**
 * 挥剑动作原本一次要一秒半，比两次攻击的间隔（0.8 秒）长得多。
 * 这里加快播放，并且跳过开头一小段抬手的过程：剑在收到命中消息后大约 0.2 秒砍到，
 * 下一次攻击到来时人已经差不多回到戒备姿势，可以接着挥下一剑。
 */
const SWING_RATE = 1.45;
const SWING_START = 0.12;
/** 拿着武器打完一下之后，保持戒备姿势这么久，没有再打就放松下来。 */
const GUARD_SECONDS = 2.5;
/** 跑步动作的播放速度：玩家跑得快，怪物慢一些，脚步和移动速度大致对得上。 */
const PLAYER_RUN_RATE = 1.2;
const MONSTER_RUN_RATE = 0.85;

/** 模型里可以换色的材质的名字，见 tools/models/build.mjs。 */
type TintSlot = 'Skin' | 'Shirt' | 'Pants' | 'Boots' | 'Hair';

/** 一个角色的外观：用哪个模型、各部分什么颜色。 */
interface Look {
  model: 'male' | 'female';
  size: number;
  colors: Partial<Record<TintSlot, number>>;
  /** 没有模型时胶囊体的颜色。 */
  fallbackColor: number;
  /** 不显示头发。 */
  bald?: boolean;
  /** 皮肤不用贴图，整个是 colors.Skin 这一个颜色。 */
  plainSkin?: boolean;
  /** 眼睛发光的颜色。 */
  eyeGlow?: number;
  runRate: number;
}

/** 肤色是乘在浅色皮肤贴图上的，所以第一个是原色。 */
const SKIN_TONES = [0xffffff, 0xeccfb8, 0xc0906c, 0x8f6247];
const HAIR_COLORS = [0x3a2a1c, 0x1c1815, 0x6b4a2a, 0xb08a4e, 0x7a3b1e];

/** 怪物是行尸：灰绿色的皮肤、光头、发红的眼睛，比玩家高一点，远远就能和玩家区分开。 */
const MONSTER_LOOK: Look = {
  model: 'male',
  size: 1.05,
  colors: { Skin: 0x7f9f78, Shirt: 0x5a2420, Pants: 0x2c2a22, Boots: 0x15120f, Hair: 0x2a2a22 },
  fallbackColor: 0x8c2a24,
  bald: true,
  plainSkin: true,
  eyeGlow: 0xff2010,
  runRate: MONSTER_RUN_RATE,
};

/** 商人：紫色的长衣、花白的头发，比玩家高一点。玩家的上衣颜色是随机的，但不会有花白的头发。 */
const MERCHANT_LOOK: Look = {
  model: 'male',
  size: 1.08,
  colors: { Skin: 0xeccfb8, Shirt: 0x7a4fb0, Pants: 0x4a3a78, Boots: 0x2a1c12, Hair: 0xd8d4cc },
  fallbackColor: 0x7a4fb0,
  runRate: 1,
};

/** 玩家的外观由名字决定：同一个人每次上线、在每个人眼里都是同一个样子。 */
function playerLook(name: string): Look {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  hash >>>= 0;
  const shirt = new THREE.Color().setHSL(((hash >>> 8) % 360) / 360, 0.6, 0.5).getHex();
  return {
    model: hash & 1 ? 'female' : 'male',
    size: 1,
    colors: {
      Skin: SKIN_TONES[(hash >>> 1) % SKIN_TONES.length],
      Hair: HAIR_COLORS[(hash >>> 3) % HAIR_COLORS.length],
      Shirt: shirt,
    },
    fallbackColor: shirt,
    runRate: PLAYER_RUN_RATE,
  };
}

/**
 * 带骨骼的网格默认用第一次画出来时的姿势判断是否在屏幕内，倒地以后会被误判成看不见。
 * 这里给一个足够大的范围，站着、出拳、躺下都在里面。
 */
const CULLING_SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2);

async function loadModel(loader: GLTFLoader, file: string): Promise<CharacterModel> {
  const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${file}`);
  gltf.scene.updateMatrixWorld(true);
  const height = new THREE.Box3().setFromObject(gltf.scene).max.y;
  if (!(height > 0)) throw new Error(`${file} 没有高度`);
  gltf.scene.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) mesh.boundingSphere = CULLING_SPHERE;
  });
  return { scene: gltf.scene, animations: gltf.animations, height };
}

/** 加载人物模型。失败时返回 null，角色改用胶囊体显示。 */
export async function loadCharacterAssets(): Promise<CharacterAssets | null> {
  try {
    const loader = new GLTFLoader();
    const [male, female] = await Promise.all([
      loadModel(loader, 'human_male.glb'),
      loadModel(loader, 'human_female.glb'),
    ]);
    return { male, female };
  } catch (err) {
    console.warn('人物模型加载失败，改用胶囊体显示。', err);
    return null;
  }
}

let capsuleGeometry: THREE.CapsuleGeometry | undefined;
let noseGeometry: THREE.BoxGeometry | undefined;

/**
 * 一个角色在场景里的样子：模型、动画、头顶的名字和血条。
 * 自己、其他玩家和怪物都用它，区别只在外观（见 Look）。
 */
export class EntityView {
  readonly root = new THREE.Group();
  /** 角色的身高，点选和飘字用它确定位置。 */
  readonly height: number;
  private readonly label: CSS2DObject;
  private readonly hpFill: HTMLElement;
  private readonly maxHp: number;
  /** 这个角色自己的材质，以及各自平时的自发光颜色（受击闪烁之后要恢复）。 */
  private readonly ownedMaterials: { material: THREE.MeshStandardMaterial; emissive: THREE.Color }[] = [];
  /** 没有模型时用的胶囊体，倒地时整体放平。 */
  private fallback: THREE.Group | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private idle: THREE.AnimationAction | null = null;
  private run: THREE.AnimationAction | null = null;
  /** 出拳的几个动作轮流用。 */
  private punches: THREE.AnimationAction[] = [];
  /** 挥剑只有一个动作，这里放的是它的两份，轮流播放，这样连续挥剑时前一下能渐变到后一下。 */
  private swings: THREE.AnimationAction[] = [];
  private guard: THREE.AnimationAction | null = null;
  /** 还要保持戒备姿势多久。只在拿着武器时有意义。 */
  private guardLeft = 0;
  private punchCount = 0;
  /** 正在播放（或者最近一次播放）的攻击动作，出拳或者挥剑。 */
  private punch: THREE.AnimationAction | null = null;
  /** 右手上挂武器的节点。没有模型、用胶囊体代替时没有。 */
  private weaponSocket: THREE.Object3D | null = null;
  private weapon: ItemId | null = null;
  private weaponObject: THREE.Object3D | null = null;
  private death: THREE.AnimationAction | null = null;
  private current: THREE.AnimationAction | null = null;
  private moving = false;
  private dead = false;
  private punching = false;
  private flashLeft = 0;
  private yaw = 0;
  private targetYaw = 0;

  constructor(
    info: EntityViewInfo,
    isSelf: boolean,
    assets: CharacterAssets | null,
    private readonly itemAssets: ItemAssets,
  ) {
    const isMonster = info.kind === 'monster';
    const isNpc = info.kind === 'npc';
    const look = isMonster ? MONSTER_LOOK : isNpc ? MERCHANT_LOOK : playerLook(info.name);
    const source = assets?.[look.model];
    this.height = (source?.height ?? FALLBACK_HEIGHT) * look.size;
    this.maxHp = info.maxHp;

    if (source) {
      const model = cloneSkinned(source.scene);
      model.scale.setScalar(look.size);
      // 每个角色用自己的一份材质，这样换色和受击闪烁互不影响；贴图仍然是共用的。
      const copies = new Map<THREE.Material, THREE.MeshStandardMaterial>();
      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        mesh.castShadow = true;
        if (look.bald && mesh.name === 'Hair') mesh.visible = false;
        let copy = copies.get(mesh.material);
        if (!copy) {
          copy = (mesh.material as THREE.MeshStandardMaterial).clone();
          const color = look.colors[copy.name as TintSlot];
          if (color !== undefined) copy.color.setHex(color);
          if (look.plainSkin && copy.name === 'Skin') copy.map = null;
          if (look.eyeGlow !== undefined && copy.name === 'Eyes') copy.emissive.setHex(look.eyeGlow);
          copies.set(mesh.material, copy);
          this.ownedMaterials.push({ material: copy, emissive: copy.emissive.clone() });
        }
        mesh.material = copy;
      });
      this.root.add(model);
      this.weaponSocket = model.getObjectByName(WEAPON_NODE) ?? null;

      const mixer = new THREE.AnimationMixer(model);
      this.mixer = mixer;
      const clip = (name: string): THREE.AnimationAction | null => {
        const found = THREE.AnimationClip.findByName(source.animations, name);
        return found ? mixer.clipAction(found) : null;
      };
      this.idle = clip(CLIP_IDLE);
      this.run = clip(CLIP_RUN);
      this.run?.setEffectiveTimeScale(look.runRate);
      this.punches = CLIP_PUNCHES.map(clip).filter((action) => action !== null);
      const swing = THREE.AnimationClip.findByName(source.animations, CLIP_SWING);
      if (swing) {
        // 同一个动作在一个角色身上只能有一个播放实例，所以第二份用拷贝。
        this.swings = [mixer.clipAction(swing), mixer.clipAction(swing.clone())];
        for (const action of this.swings) action.setEffectiveTimeScale(SWING_RATE);
      }
      this.guard = clip(CLIP_GUARD);
      this.death = clip(CLIP_DEATH);
      for (const once of [...this.punches, ...this.swings, this.death]) once?.setLoop(THREE.LoopOnce, 1);
      if (this.death) this.death.clampWhenFinished = true;
      mixer.addEventListener('finished', (ev) => {
        if (ev.action !== this.punch) return;
        this.punching = false;
        this.refreshAction();
      });
    } else {
      capsuleGeometry ??= new THREE.CapsuleGeometry(0.4, FALLBACK_HEIGHT - 0.8, 4, 12);
      noseGeometry ??= new THREE.BoxGeometry(0.2, 0.2, 0.3);
      const material = new THREE.MeshStandardMaterial({ color: look.fallbackColor, roughness: 0.6 });
      this.ownedMaterials.push({ material, emissive: material.emissive.clone() });
      const body = new THREE.Mesh(capsuleGeometry, material);
      body.position.y = FALLBACK_HEIGHT / 2;
      body.castShadow = true;
      // 朝前的小方块，用来看出朝向。
      const nose = new THREE.Mesh(noseGeometry, material);
      nose.position.set(0, FALLBACK_HEIGHT * 0.75, 0.45);
      this.fallback = new THREE.Group();
      this.fallback.add(body, nose);
      this.fallback.scale.setScalar(look.size);
      this.root.add(this.fallback);
    }

    const element = document.createElement('div');
    element.className = `name-label ${isMonster ? 'monster' : isNpc ? 'npc' : isSelf ? 'self' : 'player'}`;
    const nameText = document.createElement('div');
    nameText.className = 'name-text';
    nameText.textContent = info.name;
    const bar = document.createElement('div');
    bar.className = 'hp-bar';
    this.hpFill = document.createElement('div');
    this.hpFill.className = 'hp-fill';
    bar.appendChild(this.hpFill);
    element.append(nameText, bar);
    this.label = new CSS2DObject(element);
    this.label.position.set(0, this.height + LABEL_GAP, 0);
    this.root.add(this.label);

    this.setHp(info.hp);
    this.refreshAction();
  }

  /** 直接放到某个位置，不改变朝向。 */
  place(x: number, z: number): void {
    this.root.position.set(x, 0, z);
  }

  /** 更新位置和是否在移动。朝向根据位置的变化自动计算。 */
  setPose(x: number, z: number, moving: boolean): void {
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (dx * dx + dz * dz > 1e-6) this.targetYaw = Math.atan2(dx, dz);
    this.root.position.set(x, 0, z);
    if (moving === this.moving) return;
    this.moving = moving;
    // 一迈步就中断出拳的动作。
    if (moving) this.punching = false;
    this.refreshAction();
  }

  /** 转过去面朝 (x, z)，位置不变。给站着不动的角色用。 */
  turnTo(x: number, z: number): void {
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (dx * dx + dz * dz > 1e-6) this.targetYaw = Math.atan2(dx, dz);
  }

  setHp(hp: number): void {
    const ratio = this.maxHp > 0 ? Math.min(1, Math.max(0, hp / this.maxHp)) : 0;
    this.hpFill.style.width = `${Math.round(ratio * 100)}%`;
  }

  /**
   * 倒地或者重新站起来。
   * instant 为 true 时直接显示倒地后的样子，用在“进入视野时它已经死了”的情况。
   */
  setDead(dead: boolean, instant = false): void {
    if (dead === this.dead) return;
    this.dead = dead;
    this.punching = false;
    this.label.element.classList.toggle('dead', dead);
    if (this.fallback) {
      this.fallback.rotation.x = dead ? -Math.PI / 2 : 0;
      this.fallback.position.y = dead ? 0.4 * this.fallback.scale.y : 0;
    }
    this.refreshAction();
    if (dead && instant && this.death) this.death.time = this.death.getClip().duration;
  }

  /** 换手里的武器，null 是空手。武器挂在右手上，跟着手动；之后的攻击动作从出拳换成挥剑。 */
  setWeapon(item: ItemId | null): void {
    if (item === this.weapon) return;
    this.weapon = item;
    this.weaponObject?.removeFromParent();
    this.weaponObject = null;
    if (item && this.weaponSocket) {
      this.weaponObject = createHeldWeapon(item, this.itemAssets);
      this.weaponSocket.add(this.weaponObject);
    }
    // 打到一半换武器：不把出拳的动作接着当挥剑播完，直接回到站立。
    this.punching = false;
    this.guardLeft = 0;
    this.refreshAction();
  }

  /** 朝 (x, z) 攻击一次：空手出拳，拿着武器就挥过去。 */
  attack(x: number, z: number): void {
    if (this.dead) return;
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (dx * dx + dz * dz > 1e-6) this.targetYaw = Math.atan2(dx, dz);
    const armed = this.weapon !== null && this.swings.length > 0;
    const moves = armed ? this.swings : this.punches;
    if (moves.length === 0 || this.moving) return;
    this.punching = true;
    this.punch = moves[this.punchCount++ % moves.length];
    if (this.current === this.punch) this.punch.reset().play();
    else this.refreshAction();
    if (armed) {
      this.punch.time = SWING_START;
      this.guardLeft = GUARD_SECONDS;
    }
  }

  /** 被打中时闪一下。 */
  flash(): void {
    this.flashLeft = FLASH_SECONDS;
  }

  update(dt: number): void {
    if (!this.dead) {
      // 沿最短的方向转向目标朝向。
      const diff = Math.atan2(Math.sin(this.targetYaw - this.yaw), Math.cos(this.targetYaw - this.yaw));
      this.yaw += diff * (1 - Math.exp(-TURN_SHARPNESS * dt));
      this.root.rotation.y = this.yaw;
    }
    if (this.flashLeft > 0) {
      this.flashLeft = Math.max(0, this.flashLeft - dt);
      const strength = this.flashLeft / FLASH_SECONDS;
      for (const { material, emissive } of this.ownedMaterials) material.emissive.copy(emissive).lerp(FLASH_COLOR, strength);
    }
    if (this.guardLeft > 0) {
      this.guardLeft -= dt;
      if (this.guardLeft <= 0) this.refreshAction();
    }
    this.mixer?.update(dt);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.label.element.remove();
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
    }
    for (const { material } of this.ownedMaterials) material.dispose();
  }

  /** 按当前状态选出应该播放的动作，和正在播放的不同时渐变过去。 */
  private refreshAction(): void {
    // 拿着武器刚打完的一小段时间里，站着时用戒备姿势代替普通的站立。
    const standing = this.weapon && this.guardLeft > 0 && this.guard ? this.guard : this.idle;
    const next = this.dead ? this.death : this.punching ? this.punch : this.moving ? this.run : standing;
    if (next === this.current) return;
    this.current?.fadeOut(FADE_SECONDS);
    next?.reset().fadeIn(FADE_SECONDS).play();
    this.current = next;
  }
}
