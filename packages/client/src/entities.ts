import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { EntityKind } from '@mmo/shared';

/** 角色模型和动画。所有角色共用同一份几何体和动画数据。 */
export interface CharacterAssets {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** 把模型缩放到统一身高所用的系数。 */
  scale: number;
}

/** 创建一个角色的显示对象需要的信息。 */
export interface EntityViewInfo {
  id: number;
  kind: EntityKind;
  name: string;
  hp: number;
  maxHp: number;
}

const CHARACTER_HEIGHT = 1.8;
/** 怪物比玩家矮一点，颜色固定为暗红色，远远就能和玩家区分开。 */
const MONSTER_SCALE = 0.85;
const MONSTER_COLOR = 0x8c2a24;
const LABEL_GAP = 0.45;
const FADE_SECONDS = 0.15;
const TURN_SHARPNESS = 14;
/** 被打中时机身闪一下红色，持续这么久。 */
const FLASH_SECONDS = 0.18;
const FLASH_COLOR = new THREE.Color(0xff3020);
/** 模型里可以换色的那个材质的名字（RobotExpressive 的机身）。 */
const TINT_MATERIAL = 'Main';

/** 加载角色模型。失败时返回 null，角色改用胶囊体显示。 */
export async function loadCharacterAssets(
  url = `${import.meta.env.BASE_URL}models/RobotExpressive.glb`,
): Promise<CharacterAssets | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const height = box.max.y - box.min.y;
    if (!(height > 0)) throw new Error('model has no height');
    return { scene: gltf.scene, animations: gltf.animations, scale: CHARACTER_HEIGHT / height };
  } catch (err) {
    console.warn('角色模型加载失败，改用胶囊体显示。', err);
    return null;
  }
}

let capsuleGeometry: THREE.CapsuleGeometry | undefined;
let noseGeometry: THREE.BoxGeometry | undefined;

/**
 * 一个角色在场景里的样子：模型、动画、头顶的名字和血条。
 * 自己、其他玩家和怪物都用它；怪物用同一个模型，只是颜色和大小不同。
 */
export class EntityView {
  readonly root = new THREE.Group();
  /** 角色的身高，点选和飘字用它确定位置。 */
  readonly height: number;
  private readonly label: CSS2DObject;
  private readonly hpFill: HTMLElement;
  private readonly maxHp: number;
  private readonly ownedMaterials: THREE.MeshStandardMaterial[] = [];
  /** 没有模型时用的胶囊体，倒地时整体放平。 */
  private fallback: THREE.Group | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private idle: THREE.AnimationAction | null = null;
  private run: THREE.AnimationAction | null = null;
  private punch: THREE.AnimationAction | null = null;
  private death: THREE.AnimationAction | null = null;
  private current: THREE.AnimationAction | null = null;
  private moving = false;
  private dead = false;
  private punching = false;
  private flashLeft = 0;
  private yaw = 0;
  private targetYaw = 0;

  constructor(info: EntityViewInfo, isSelf: boolean, assets: CharacterAssets | null) {
    const isMonster = info.kind === 'monster';
    const size = isMonster ? MONSTER_SCALE : 1;
    this.height = CHARACTER_HEIGHT * size;
    this.maxHp = info.maxHp;
    // 玩家按 id 分配一个固定的颜色，方便区分不同的人。
    const color = isMonster
      ? new THREE.Color(MONSTER_COLOR)
      : new THREE.Color().setHSL((info.id * 0.618034) % 1, 0.65, 0.55);

    if (assets) {
      const model = cloneSkinned(assets.scene);
      model.scale.setScalar(assets.scale * size);
      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        const material = mesh.material;
        if (!Array.isArray(material) && material.name === TINT_MATERIAL) {
          const tinted = (material as THREE.MeshStandardMaterial).clone();
          tinted.color.copy(color);
          mesh.material = tinted;
          this.ownedMaterials.push(tinted);
        }
      });
      this.root.add(model);

      const mixer = new THREE.AnimationMixer(model);
      this.mixer = mixer;
      const clip = (...names: string[]): THREE.AnimationAction | null => {
        for (const name of names) {
          const found = THREE.AnimationClip.findByName(assets.animations, name);
          if (found) return mixer.clipAction(found);
        }
        return null;
      };
      this.idle = clip('Idle');
      // 怪物移动得慢，用走路的动作；玩家用跑步。
      this.run = isMonster ? clip('Walking', 'Running') : clip('Running', 'Walking');
      this.punch = clip('Punch');
      this.death = clip('Death');
      for (const once of [this.punch, this.death]) once?.setLoop(THREE.LoopOnce, 1);
      if (this.death) this.death.clampWhenFinished = true;
      mixer.addEventListener('finished', (ev) => {
        if (ev.action !== this.punch) return;
        this.punching = false;
        this.refreshAction();
      });
    } else {
      capsuleGeometry ??= new THREE.CapsuleGeometry(0.4, CHARACTER_HEIGHT - 0.8, 4, 12);
      noseGeometry ??= new THREE.BoxGeometry(0.2, 0.2, 0.3);
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
      this.ownedMaterials.push(material);
      const body = new THREE.Mesh(capsuleGeometry, material);
      body.position.y = CHARACTER_HEIGHT / 2;
      body.castShadow = true;
      // 朝前的小方块，用来看出朝向。
      const nose = new THREE.Mesh(noseGeometry, material);
      nose.position.set(0, CHARACTER_HEIGHT * 0.75, 0.45);
      this.fallback = new THREE.Group();
      this.fallback.add(body, nose);
      this.fallback.scale.setScalar(size);
      this.root.add(this.fallback);
    }

    const element = document.createElement('div');
    element.className = `name-label ${isMonster ? 'monster' : isSelf ? 'self' : 'player'}`;
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

  /** 朝 (x, z) 出拳一次。 */
  attack(x: number, z: number): void {
    if (this.dead) return;
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (dx * dx + dz * dz > 1e-6) this.targetYaw = Math.atan2(dx, dz);
    if (!this.punch || this.moving) return;
    this.punching = true;
    if (this.current === this.punch) this.punch.reset().play();
    else this.refreshAction();
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
      for (const material of this.ownedMaterials) material.emissive.copy(FLASH_COLOR).multiplyScalar(strength);
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
    for (const material of this.ownedMaterials) material.dispose();
  }

  /** 按当前状态选出应该播放的动作，和正在播放的不同时渐变过去。 */
  private refreshAction(): void {
    const next = this.dead ? this.death : this.punching ? this.punch : this.moving ? this.run : this.idle;
    if (next === this.current) return;
    this.current?.fadeOut(FADE_SECONDS);
    next?.reset().fadeIn(FADE_SECONDS).play();
    this.current = next;
  }
}
