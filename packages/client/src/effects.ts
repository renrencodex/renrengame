import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const FLOAT_SECONDS = 0.8;
const FLOAT_RISE = 1.1;

/** 选中目标脚下的圈，轻微地缩放提示“正在攻击它”。 */
export class TargetRing {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private age = 0;

  constructor() {
    const geometry = new THREE.RingGeometry(0.62, 0.78, 40);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.mesh.position.y = 0.05;
    this.mesh.visible = false;
  }

  /** 把圈放到 (x, z)。 */
  show(x: number, z: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.age += dt;
    this.mesh.scale.setScalar(1 + Math.sin(this.age * 6) * 0.06);
  }
}

interface FloatingText {
  object: CSS2DObject;
  age: number;
  baseY: number;
}

/** 伤害飘字：从被打中的角色头上冒出来，往上飘并淡出。 */
export class FloatingTexts {
  private readonly active: FloatingText[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  /** 在 (x, y, z) 冒出一段文字。className 用来区分“我打出的伤害”和“我受到的伤害”。 */
  spawn(x: number, y: number, z: number, text: string, className: string): void {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    const object = new CSS2DObject(element);
    // 稍微错开一点，连续几次命中的数字不会完全叠在一起。
    object.position.set(x + (Math.random() - 0.5) * 0.5, y, z);
    this.scene.add(object);
    this.active.push({ object, age: 0, baseY: y });
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const item = this.active[i];
      item.age += dt;
      const t = item.age / FLOAT_SECONDS;
      if (t >= 1) {
        item.object.removeFromParent();
        item.object.element.remove();
        this.active.splice(i, 1);
        continue;
      }
      item.object.position.y = item.baseY + t * FLOAT_RISE;
      item.object.element.style.opacity = String(1 - t * t);
    }
  }
}
