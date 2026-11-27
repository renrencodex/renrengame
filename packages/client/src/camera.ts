import * as THREE from 'three';

const FOV = 35;
/** 水平方向固定朝向（绕 Y 轴）。 */
const YAW = THREE.MathUtils.degToRad(45);
/** 俯角：镜头和地面的夹角。 */
const PITCH = THREE.MathUtils.degToRad(55);
const MIN_DISTANCE = 16;
const MAX_DISTANCE = 60;
const DEFAULT_DISTANCE = 34;
/** 跟随的平滑程度，越大跟得越紧。 */
const FOLLOW_SHARPNESS = 8;

/**
 * 2.5D 镜头：角度固定的斜俯视角，只跟随玩家平移，滚轮调节远近。
 * 用窄视角的透视相机，既保留一点近大远小，又接近等距视图的观感。
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private readonly target = new THREE.Vector3();
  private readonly direction = new THREE.Vector3(
    Math.sin(YAW) * Math.cos(PITCH),
    Math.sin(PITCH),
    Math.cos(YAW) * Math.cos(PITCH),
  );
  private distance = DEFAULT_DISTANCE;
  private targetDistance = DEFAULT_DISTANCE;

  constructor(dom: HTMLElement, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV, aspect, 1, 500);
    dom.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const next = this.targetDistance * Math.exp(ev.deltaY * 0.001);
        this.targetDistance = THREE.MathUtils.clamp(next, MIN_DISTANCE, MAX_DISTANCE);
      },
      { passive: false },
    );
    this.apply();
  }

  /** 立刻对准某个位置，不做平滑。 */
  snapTo(x: number, z: number): void {
    this.target.set(x, 0, z);
    this.apply();
  }

  update(x: number, z: number, dt: number): void {
    const k = 1 - Math.exp(-FOLLOW_SHARPNESS * dt);
    this.target.x += (x - this.target.x) * k;
    this.target.z += (z - this.target.z) * k;
    this.distance += (this.targetDistance - this.distance) * k;
    this.apply();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  private apply(): void {
    this.camera.position.copy(this.target).addScaledVector(this.direction, this.distance);
    this.camera.lookAt(this.target);
  }
}
