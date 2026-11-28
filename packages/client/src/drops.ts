import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { ITEM_IDS, ITEMS } from '@mmo/shared';
import type { DropInfo, ItemId } from '@mmo/shared';

/** 一种物品掉在地上时的样子。 */
interface ItemLook {
  /** 模型的放大倍数。原始模型是真实大小（一堆金币只有 20 厘米宽），从游戏的视角看太小。 */
  scale: number;
  /**
   * 乘在模型颜色上的红、绿、蓝倍数。模型的颜色是按带环境反射的渲染调的，
   * 这里没有环境反射，原样画出来偏暗；金币还偏橙，多给一点绿色让它更像金子。
   */
  tint: [number, number, number];
  /** 地上光晕的颜色；没有模型时，代替它的小方块也用这个颜色。 */
  color: number;
  /** 掉在地上时向一侧倾斜的角度（弧度）。剑的模型是竖着的，斜着放才不会像一根插在地上的杆子。 */
  tilt?: number;
  /**
   * 只有武器有，拿在手里时用：grip 是握柄的中点在模型里的高度（米），这一点对准手心；
   * scale 是放大倍数，原始模型拿在这些人物手里显得太长。
   */
  held?: { grip: number; scale: number };
}

const ITEM_LOOKS: Record<ItemId, ItemLook> = {
  gold: { scale: 4, tint: [1.35, 2.1, 1], color: 0xffcf4a },
  potion: { scale: 3, tint: [3.2, 3.2, 3.2], color: 0xff5a5a },
  sword: { scale: 1.2, tint: [1.6, 2.2, 2.4], color: 0x9fd8ff, tilt: 1.05, held: { grip: -0.04, scale: 0.85 } },
};

/** 一种物品的模型。所有同种的掉落物共用它的几何体和材质。 */
export interface ItemModel {
  /** 掉在地上时的样子：已经放大、摆好角度，底部贴着地面，水平方向以自己的中心为原点。 */
  object: THREE.Object3D;
  /** 放大之后的高度。 */
  height: number;
  /** 只有武器有：拿在手里时的样子，握柄的中点在原点，剑身沿 Y 轴。 */
  held?: THREE.Object3D;
}

/** 加载成功的物品模型。缺了哪个，哪种物品就用小方块代替。 */
export type ItemAssets = Partial<Record<ItemId, ItemModel>>;

/** 加载物品模型，文件是 tools/models/build-items.mjs 生成的。 */
export async function loadItemAssets(): Promise<ItemAssets> {
  const loader = new GLTFLoader();
  const assets: ItemAssets = {};
  await Promise.all(
    ITEM_IDS.map(async (id) => {
      try {
        const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/item_${id}.glb`);
        const look = ITEM_LOOKS[id];
        const source = gltf.scene;
        source.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh || Array.isArray(mesh.material)) return;
          mesh.castShadow = true;
          (mesh.material as THREE.MeshStandardMaterial).color.setRGB(...look.tint);
        });

        // 地上的样子：放大、倾斜，再挪到“底部贴地、水平居中”的位置，这样它绕着自己的中心转。
        const placed = source.clone();
        placed.scale.setScalar(look.scale);
        placed.rotation.z = look.tilt ?? 0;
        placed.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(placed);
        const height = box.max.y - box.min.y;
        if (!(height > 0)) throw new Error('模型没有高度');
        placed.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
        const model: ItemModel = { object: new THREE.Group().add(placed), height };

        if (look.held) {
          const held = source.clone();
          held.scale.setScalar(look.held.scale);
          held.position.y = -look.held.grip * look.held.scale;
          model.held = new THREE.Group().add(held);
        }
        assets[id] = model;
      } catch (err) {
        console.warn(`物品模型 item_${id}.glb 加载失败，改用小方块显示。`, err);
      }
    }),
  );
  return assets;
}

let heldFallbackGeometry: THREE.BoxGeometry | undefined;

/**
 * 做一件拿在手里的武器，放到人物右手的 Weapon_R 节点下面用。
 * 握住的地方在原点，剑身沿 Y 轴。模型没加载成功时用一根细长的方块代替。
 */
export function createHeldWeapon(item: ItemId, assets: ItemAssets): THREE.Object3D {
  const held = assets[item]?.held;
  if (held) return held.clone();
  heldFallbackGeometry ??= new THREE.BoxGeometry(0.07, 0.95, 0.025).translate(0, 0.38, 0);
  const mesh = new THREE.Mesh(heldFallbackGeometry, fallbackMaterial(item));
  mesh.castShadow = true;
  return mesh;
}

const FALLBACK_SIZE = 0.45;
/** 物品悬在离地这么高的地方，上下轻轻浮动，并且慢慢旋转。 */
const HOVER_HEIGHT = 0.12;
const BOB_HEIGHT = 0.06;
const BOB_SPEED = 2.6;
const SPIN_SPEED = 1.4;
/** 刚出现时从小变大“弹”出来，持续这么久。 */
const POP_SECONDS = 0.3;
const GLOW_RADIUS = 0.75;
const LABEL_GAP = 0.4;

let fallbackGeometry: THREE.OctahedronGeometry | undefined;
let glowGeometry: THREE.CircleGeometry | undefined;
let glowTexture: THREE.CanvasTexture | undefined;
const fallbackMaterials = new Map<ItemId, THREE.MeshStandardMaterial>();
const glowMaterials = new Map<ItemId, THREE.MeshBasicMaterial>();

/** 一张中间亮、边缘淡出的圆形贴图，所有光晕共用。 */
function createGlowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.35)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function glowMaterial(item: ItemId): THREE.MeshBasicMaterial {
  let material = glowMaterials.get(item);
  if (!material) {
    glowTexture ??= createGlowTexture();
    material = new THREE.MeshBasicMaterial({
      color: ITEM_LOOKS[item].color,
      map: glowTexture,
      transparent: true,
      depthWrite: false,
    });
    glowMaterials.set(item, material);
  }
  return material;
}

function fallbackMaterial(item: ItemId): THREE.MeshStandardMaterial {
  let material = fallbackMaterials.get(item);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color: ITEM_LOOKS[item].color, roughness: 0.4 });
    fallbackMaterials.set(item, material);
  }
  return material;
}

/** 物品头顶显示的文字：金币总是带数量，其他物品只有一堆里不止一个时才带。 */
function labelText(item: ItemId, count: number): string {
  const name = ITEMS[item].name;
  return item === 'gold' || count > 1 ? `${name} ×${count}` : name;
}

/**
 * 地上的一堆物品：模型、脚下的光晕和头顶的名字。
 * 它不会移动，位置在创建时就定了；几何体和材质都是共用的，销毁时不需要释放。
 */
export class DropView {
  readonly root = new THREE.Group();
  readonly x: number;
  readonly z: number;
  /** 物品顶端离地的高度，点选时用它确定范围。 */
  readonly height: number;
  private readonly body = new THREE.Group();
  private readonly label: CSS2DObject;
  private readonly phase: number;
  private age = 0;

  constructor(info: DropInfo, assets: ItemAssets) {
    this.x = info.x;
    this.z = info.z;
    // 按 id 错开，同时掉下来的几样东西不会整齐划一地浮动。
    this.phase = info.id * 1.7;

    const model = assets[info.item];
    if (model) {
      this.body.add(model.object.clone());
      this.height = model.height + HOVER_HEIGHT;
    } else {
      fallbackGeometry ??= new THREE.OctahedronGeometry(FALLBACK_SIZE / 2);
      const mesh = new THREE.Mesh(fallbackGeometry, fallbackMaterial(info.item));
      mesh.position.y = FALLBACK_SIZE / 2;
      mesh.castShadow = true;
      this.body.add(mesh);
      this.height = FALLBACK_SIZE + HOVER_HEIGHT;
    }
    this.body.rotation.y = this.phase;
    this.body.scale.setScalar(0.01);

    glowGeometry ??= new THREE.CircleGeometry(GLOW_RADIUS, 24).rotateX(-Math.PI / 2);
    const glow = new THREE.Mesh(glowGeometry, glowMaterial(info.item));
    glow.position.y = 0.04;

    const element = document.createElement('div');
    element.className = `drop-label ${info.item}`;
    element.textContent = labelText(info.item, info.count);
    this.label = new CSS2DObject(element);
    this.label.position.set(0, this.height + LABEL_GAP, 0);

    this.root.add(this.body, glow, this.label);
    this.root.position.set(info.x, 0, info.z);
  }

  update(dt: number): void {
    this.age += dt;
    const t = Math.min(1, this.age / POP_SECONDS);
    // 先冲过头一点再收回来。
    const pop = 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
    this.body.scale.setScalar(Math.max(0.01, pop));
    this.body.position.y = HOVER_HEIGHT + Math.sin(this.age * BOB_SPEED + this.phase) * BOB_HEIGHT;
    this.body.rotation.y += dt * SPIN_SPEED;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.label.element.remove();
  }
}
