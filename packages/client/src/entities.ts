import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/** 角色模型和动画。所有角色共用同一份几何体和动画数据。 */
export interface CharacterAssets {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** 把模型缩放到统一身高所用的系数。 */
  scale: number;
}

const CHARACTER_HEIGHT = 1.8;
const LABEL_HEIGHT = 2.25;
const FADE_SECONDS = 0.15;
const TURN_SHARPNESS = 14;
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

/** 一个角色在场景里的样子：模型、动画和头顶的名字。自己和其他玩家都用它。 */
export class EntityView {
  readonly root = new THREE.Group();
  private readonly label: CSS2DObject;
  private readonly ownedMaterials: THREE.Material[] = [];
  private mixer: THREE.AnimationMixer | null = null;
  private idle: THREE.AnimationAction | null = null;
  private run: THREE.AnimationAction | null = null;
  private moving = false;
  private yaw = 0;
  private targetYaw = 0;

  constructor(id: number, name: string, isSelf: boolean, assets: CharacterAssets | null) {
    // 按 id 分配一个固定的颜色，方便区分不同的玩家。
    const color = new THREE.Color().setHSL((id * 0.618034) % 1, 0.65, 0.55);

    if (assets) {
      const model = cloneSkinned(assets.scene);
      model.scale.setScalar(assets.scale);
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

      this.mixer = new THREE.AnimationMixer(model);
      const idleClip = THREE.AnimationClip.findByName(assets.animations, 'Idle');
      const runClip =
        THREE.AnimationClip.findByName(assets.animations, 'Running') ??
        THREE.AnimationClip.findByName(assets.animations, 'Walking');
      if (idleClip) this.idle = this.mixer.clipAction(idleClip);
      if (runClip) this.run = this.mixer.clipAction(runClip);
      this.idle?.play();
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
      this.root.add(body, nose);
    }

    const element = document.createElement('div');
    element.className = isSelf ? 'name-label self' : 'name-label';
    element.textContent = name;
    this.label = new CSS2DObject(element);
    this.label.position.set(0, LABEL_HEIGHT, 0);
    this.root.add(this.label);
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
    this.setMoving(moving);
  }

  update(dt: number): void {
    // 沿最短的方向转向目标朝向。
    const diff = Math.atan2(Math.sin(this.targetYaw - this.yaw), Math.cos(this.targetYaw - this.yaw));
    this.yaw += diff * (1 - Math.exp(-TURN_SHARPNESS * dt));
    this.root.rotation.y = this.yaw;
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

  private setMoving(moving: boolean): void {
    if (moving === this.moving) return;
    this.moving = moving;
    const from = moving ? this.idle : this.run;
    const to = moving ? this.run : this.idle;
    from?.fadeOut(FADE_SECONDS);
    to?.reset().fadeIn(FADE_SECONDS).play();
  }
}
