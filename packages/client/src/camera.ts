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
 * 画面比这个宽高比还窄（手机竖屏）时，把镜头按比例拉远，让左右看到的范围和这个宽高比时一样宽。
 * 视角是按画面高度定的，不这样做的话竖屏左右只看得到十来格，怪物从屏幕外面就能发现玩家。
 * 取 0.8 时，默认远近下左右一共能看到 17 格左右，比怪物发现玩家的距离（8 格）的两倍多一点。
 */
const MIN_ASPECT = 0.8;
/**
 * 算上竖屏拉远的倍数之后，镜头最远也不超过这么远。竖屏时画面上下看得很深，
 * 再远就会看到服务器还没下发实体的地方（视野最少保证一个 AOI 格子，32 格），怪物会在画面边上凭空冒出来。
 * 取 88 时，上下看到的范围和宽屏拉到最远时左右看到的范围差不多。
 */
const MAX_VIEW_DISTANCE = 88;

/** 这个宽高比下，镜头要比正常远多少倍。 */
export function narrowScreenScale(aspect: number): number {
  return aspect > 0 ? Math.max(1, MIN_ASPECT / aspect) : 1;
}

/**
 * 2.5D 镜头：角度固定的斜俯视角，只跟随玩家平移，滚轮或双指调节远近。
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
  /** 玩家调的远近。实际的距离还要乘上 scale。 */
  private distance = DEFAULT_DISTANCE;
  private targetDistance = DEFAULT_DISTANCE;
  private scale: number;

  constructor(dom: HTMLElement, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV, aspect, 1, 500);
    this.scale = narrowScreenScale(aspect);
    dom.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        this.zoomBy(Math.exp(ev.deltaY * 0.001));
      },
      { passive: false },
    );
    this.apply();
  }

  /** 因为画面太窄而把镜头拉远的倍数，宽屏时是 1。雾要跟着它一起变远。 */
  get viewScale(): number {
    return this.scale;
  }

  /** 把镜头距离乘上 factor：小于 1 拉近，大于 1 拉远，超出范围时停在边界上。 */
  zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance * factor, MIN_DISTANCE, this.maxDistance());
  }

  /** 玩家最远能调到多远。竖屏时实际距离要乘上 scale，所以能调的范围相应地小一些。 */
  private maxDistance(): number {
    return Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, MAX_VIEW_DISTANCE / this.scale));
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
    this.scale = narrowScreenScale(aspect);
    // 横屏时拉得很远、再转成竖屏：收回到竖屏允许的最远处。
    this.targetDistance = Math.min(this.targetDistance, this.maxDistance());
    this.apply();
  }

  private apply(): void {
    this.camera.position.copy(this.target).addScaledVector(this.direction, this.distance * this.scale);
    this.camera.lookAt(this.target);
  }
}
