import * as THREE from 'three';

/** 按住不放时，每隔这么久重新发一次移动目标。 */
const HOLD_REPEAT_MS = 150;
const MARKER_SECONDS = 0.6;

/**
 * 鼠标和触摸输入。按下时先问一下有没有点中怪物（onPick），
 * 没点中才把点击位置换算成地面上的坐标，当作移动处理。
 */
export class Input {
  private readonly ndc = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  private pressed = false;
  private lastFireAt = 0;
  private active = true;

  /**
   * @param onMove 点了地面上的 (x, z)。按住不放时会反复调用。
   * @param onPick 按下时调用，参数是相对画布左上角的像素坐标。返回 true 表示点中了目标，这次按下不再当作移动。
   */
  constructor(
    private readonly dom: HTMLElement,
    private readonly camera: THREE.Camera,
    private readonly onMove: (x: number, z: number) => void,
    private readonly onPick: (px: number, py: number) => boolean = () => false,
  ) {
    dom.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !this.active) return;
      const rect = dom.getBoundingClientRect();
      if (this.onPick(ev.clientX - rect.left, ev.clientY - rect.top)) return;
      this.pressed = true;
      this.setPointer(ev);
      dom.setPointerCapture(ev.pointerId);
      this.fire(performance.now());
    });
    dom.addEventListener('pointermove', (ev) => {
      if (this.pressed) this.setPointer(ev);
    });
    const release = (): void => {
      this.pressed = false;
    };
    dom.addEventListener('pointerup', release);
    dom.addEventListener('pointercancel', release);
    dom.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  /** 是否接受输入。角色死亡时关掉。 */
  get enabled(): boolean {
    return this.active;
  }

  set enabled(value: boolean) {
    this.active = value;
    if (!value) this.pressed = false;
  }

  /** 每帧调用。按住时持续朝指针位置移动。 */
  update(now: number): void {
    if (this.pressed && now - this.lastFireAt >= HOLD_REPEAT_MS) this.fire(now);
  }

  private setPointer(ev: PointerEvent): void {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
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
