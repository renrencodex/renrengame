import * as THREE from 'three';
import { PointerGestures } from './gestures';

/** 按住不放时，每隔这么久重新发一次移动目标。 */
const HOLD_REPEAT_MS = 150;
const MARKER_SECONDS = 0.6;

/**
 * 鼠标和触摸输入。按下时先问一下有没有点中怪物（onPick），
 * 没点中才把点击位置换算成地面上的坐标，当作移动处理。两根手指捏合是调镜头远近（onZoom）。
 * 哪些指针事件算“按下”、哪些算“缩放”由 PointerGestures 判断，这里只负责接事件和换算坐标。
 */
export class Input {
  private readonly ndc = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  private readonly gestures: PointerGestures;
  private pressed = false;
  private lastFireAt = 0;
  private active = true;

  /**
   * @param onMove 点了地面上的 (x, z)。按住不放时会反复调用。
   * @param onPick 按下时调用，参数是相对画布左上角的像素坐标。返回 true 表示点中了目标，这次按下不再当作移动。
   * @param onZoom 双指捏合时调用，参数是镜头距离要乘的倍数。角色死亡时也照常调用。
   */
  constructor(
    private readonly dom: HTMLElement,
    private readonly camera: THREE.Camera,
    private readonly onMove: (x: number, z: number) => void,
    private readonly onPick: (px: number, py: number) => boolean = () => false,
    onZoom: (factor: number) => void = () => {},
  ) {
    this.gestures = new PointerGestures({
      onPress: (px, py) => {
        if (!this.active || this.onPick(px, py)) return;
        this.pressed = true;
        this.setPointer(px, py);
        this.fire(performance.now());
      },
      onDrag: (px, py) => {
        if (this.pressed) this.setPointer(px, py);
      },
      onRelease: () => {
        this.pressed = false;
      },
      onZoom,
    });

    dom.addEventListener('pointerdown', (ev) => {
      const touch = ev.pointerType === 'touch';
      if (!touch && ev.button !== 0) return;
      // 手指滑到画布外面（比如状态栏上）时，后面的事件还是发给画布。
      dom.setPointerCapture(ev.pointerId);
      const rect = dom.getBoundingClientRect();
      this.gestures.down(ev.pointerId, touch, ev.clientX - rect.left, ev.clientY - rect.top, performance.now());
    });
    dom.addEventListener('pointermove', (ev) => {
      if (!this.gestures.has(ev.pointerId)) return;
      const rect = dom.getBoundingClientRect();
      this.gestures.move(ev.pointerId, ev.clientX - rect.left, ev.clientY - rect.top);
    });
    dom.addEventListener('pointerup', (ev) => this.gestures.up(ev.pointerId));
    dom.addEventListener('pointercancel', (ev) => this.gestures.cancel(ev.pointerId));
    // 正常情况下它跟在抬起、打断之后，那时已经没东西可清。这里是兜底：万一抬起的事件没送到，
    // 那根手指会一直被当成按着，之后每次单指点击都会被当成“第二根手指”，再也走不了路。
    dom.addEventListener('lostpointercapture', (ev) => this.gestures.cancel(ev.pointerId));
    dom.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  /** 是否接受点击和移动。角色死亡时关掉，缩放不受影响。 */
  get enabled(): boolean {
    return this.active;
  }

  set enabled(value: boolean) {
    this.active = value;
    if (!value) this.pressed = false;
  }

  /** 每帧调用。按住时持续朝指针位置移动。 */
  update(now: number): void {
    this.gestures.update(now);
    if (this.pressed && now - this.lastFireAt >= HOLD_REPEAT_MS) this.fire(now);
  }

  /** px、py 是相对画布左上角的像素坐标。 */
  private setPointer(px: number, py: number): void {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
  }

  private fire(now: number): void {
    this.lastFireAt = now;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (this.raycaster.ray.intersectPlane(this.ground, this.hit)) this.onMove(this.hit.x, this.hit.z);
  }
}

/** 点击地面后显示的目标标记，扩散并淡出。 */
export class MoveMarker {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private age = MARKER_SECONDS;

  constructor() {
    const geometry = new THREE.RingGeometry(0.35, 0.5, 32);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.mesh.position.y = 0.06;
    this.mesh.visible = false;
  }

  show(x: number, z: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
    this.mesh.visible = true;
    this.age = 0;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.age += dt;
    const t = this.age / MARKER_SECONDS;
    if (t >= 1) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.material.opacity = 1 - t;
    this.mesh.scale.setScalar(1 + t * 0.8);
  }
}
