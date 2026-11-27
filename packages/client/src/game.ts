import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  generateMap,
  INTERP_DELAY_MS,
  Pathfinder,
  PLAYER_MAX_HP,
  PLAYER_RESPAWN_MS,
  STATE_DEAD,
  STATE_MOVING,
} from '@mmo/shared';
import type { EntityInfo, EntityKind, EntityState, ServerMsg } from '@mmo/shared';
import { CameraRig } from './camera';
import { FloatingTexts, TargetRing } from './effects';
import { EntityView } from './entities';
import type { CharacterAssets } from './entities';
import type { Hud } from './hud';
import { Input, MoveMarker } from './input';
import { SnapshotBuffer } from './interpolation';
import type { Sample } from './interpolation';
import { LocalPlayer } from './localPlayer';
import type { Net } from './net';
import { pickEntity } from './picking';
import type { PickCandidate } from './picking';
import { WorldScene } from './scene';
import { Targeting } from './targeting';

/** 视野里除自己以外的一个实体（其他玩家或怪物）。 */
interface Remote {
  view: EntityView;
  buffer: SnapshotBuffer;
  kind: EntityKind;
  dead: boolean;
  /** 最新快照里的位置。画面上显示的是插值后稍早一点的位置，追击要用最新的。 */
  x: number;
  z: number;
}

/** 点选怪物时的最小半径（像素），保证离得远、看起来很小的怪物也点得中。 */
const MIN_PICK_RADIUS = 22;

/** 客户端主体：把网络消息变成场景里的角色，并驱动每一帧的更新和渲染。 */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly world: WorldScene;
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly local: LocalPlayer;
  private readonly targeting: Targeting;
  private readonly marker = new MoveMarker();
  private readonly ring = new TargetRing();
  private readonly floating: FloatingTexts;
  private readonly remotes = new Map<number, Remote>();
  private readonly sample: Sample = { x: 0, z: 0, moving: false };
  private readonly projected = new THREE.Vector3();
  private selfView: EntityView | null = null;
  private selfDead = false;
  /** 预计复活的本地时间，只用来显示倒计时；真正的复活以服务器的消息为准。 */
  private respawnAt = 0;
  private lastFrameAt = performance.now();

  constructor(
    private readonly container: HTMLElement,
    private readonly net: Net,
    private readonly hud: Hud,
    private readonly assets: CharacterAssets | null,
    private readonly selfId: number,
    seed: number,
  ) {
    // 用服务器下发的种子生成和服务端完全相同的地图。
    const map = generateMap(seed);
    this.local = new LocalPlayer(map);
    const pathfinder = new Pathfinder(map);
    this.targeting = new Targeting((ax, az, bx, bz) => pathfinder.lineOfSight(ax, az, bx, bz));
    this.world = new WorldScene(map);
    this.world.scene.add(this.marker.mesh, this.ring.mesh);
    this.floating = new FloatingTexts(this.world.scene);

    // WebGL 不可用时这里会抛出异常，由调用方提示用户。
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    // 名字、血条和伤害数字用 DOM 元素叠在画面上，文字清晰，也不用自己画字。
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    const canvas = this.renderer.domElement;
    this.rig = new CameraRig(canvas, 1);
    this.rig.snapTo(map.size / 2, map.size / 2);
    this.input = new Input(
      canvas,
      this.rig.camera,
      (x, z) => this.onMoveInput(x, z),
      (px, py) => this.onPick(px, py),
    );

    window.addEventListener('resize', this.resize);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  handleMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'enter':
        for (const info of msg.entities) this.onEnter(info);
        break;
      case 'leave':
        for (const id of msg.ids) {
          const remote = this.remotes.get(id);
          if (!remote) continue;
          remote.view.dispose();
          this.remotes.delete(id);
        }
        break;
      case 'snap':
        for (const [id, x, z, state, hp] of msg.entities) {
          if (id === this.selfId) {
            this.onSelfState(x, z, state, hp);
            continue;
          }
          const remote = this.remotes.get(id);
          if (!remote) continue;
          remote.buffer.push(msg.time, x, z, state === STATE_MOVING);
          remote.x = x;
          remote.z = z;
          // 血量和死亡不做插值，收到就生效。
          remote.view.setHp(hp);
          this.setRemoteDead(remote, state === STATE_DEAD);
        }
        break;
      case 'hit':
        this.onHit(msg.from, msg.to, msg.damage);
        break;
      case 'welcome':
      case 'pong':
        break;
    }
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
    this.input.enabled = false;
    this.hud.setBanner(null);
  }

  private onEnter(info: EntityInfo): void {
    if (info.id === this.selfId) {
      // 进入世界，或者死亡后在出生点复活（服务端按“离开再进入”处理）。
      this.local.place(info.x, info.z);
      if (!this.selfView) {
        this.selfView = new EntityView(info, true, this.assets);
        this.world.scene.add(this.selfView.root);
      }
      this.selfView.place(info.x, info.z);
      this.rig.snapTo(info.x, info.z);
      this.hud.show();
      this.onSelfState(info.x, info.z, info.state, info.hp);
      return;
    }

    let remote = this.remotes.get(info.id);
    if (!remote) {
      remote = {
        view: new EntityView(info, false, this.assets),
        buffer: new SnapshotBuffer(),
        kind: info.kind,
        dead: false,
        x: info.x,
        z: info.z,
      };
      this.remotes.set(info.id, remote);
      this.world.scene.add(remote.view.root);
    }
    remote.x = info.x;
    remote.z = info.z;
    remote.view.place(info.x, info.z);
    remote.view.setHp(info.hp);
    // 进入视野时已经死了的，直接显示倒地的样子，不再播一遍倒下的过程。
    this.setRemoteDead(remote, info.state === STATE_DEAD, true);
    // 先放一个初始状态，之后的快照会接着它插值。
    remote.buffer.push(this.net.serverNow(), info.x, info.z, info.state === STATE_MOVING);
  }

  /** 服务器发来的自己的权威状态。 */
  private onSelfState(x: number, z: number, state: EntityState, hp: number): void {
    this.selfView?.setHp(hp);
    this.hud.setHp(hp, PLAYER_MAX_HP);

    const dead = state === STATE_DEAD;
    if (dead !== this.selfDead) {
      this.selfDead = dead;
      this.selfView?.setDead(dead);
      this.input.enabled = !dead;
      if (dead) {
        // 倒在服务器说的位置，放下手头的一切。
        this.local.place(x, z);
        this.clearTarget(false);
        this.respawnAt = performance.now() + PLAYER_RESPAWN_MS;
      } else {
        this.hud.setBanner(null);
      }
    }
    if (!dead) this.local.onServerState(x, z, state === STATE_MOVING);
  }

  private setRemoteDead(remote: Remote, dead: boolean, instant = false): void {
    if (remote.dead === dead) return;
    remote.dead = dead;
    remote.view.setDead(dead, instant);
  }

  private onHit(from: number, to: number, damage: number): void {
    const attacker = this.viewOf(from);
    const target = this.viewOf(to);
    if (!target) return;
    const { x, z } = target.root.position;
    attacker?.attack(x, z);
    target.flash();
    const className = to === this.selfId ? 'damage-text taken' : 'damage-text';
    this.floating.spawn(x, target.height + 0.3, z, `-${damage}`, className);
  }

  private viewOf(id: number): EntityView | null {
    return id === this.selfId ? this.selfView : (this.remotes.get(id)?.view ?? null);
  }

  // ---- 输入 ----

  private onMoveInput(x: number, z: number): void {
    if (!this.selfView || this.selfDead) return;
    // 点地面就是放弃当前的目标。
    this.clearTarget(true);
    // 先在本地验证并开始走，再告诉服务器。服务器会用同样的规则重新算一遍。
    if (!this.local.requestMove(x, z)) return;
    this.net.send({ t: 'moveTo', x, z });
    this.marker.show(x, z);
  }

  /** 按下时先看有没有点中怪物。px、py 是相对画布左上角的像素坐标。 */
  private onPick(px: number, py: number): boolean {
    if (!this.selfView || this.selfDead) return false;
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const camera = this.rig.camera;
    camera.updateMatrixWorld();
    const v = this.projected;
    const candidates: PickCandidate[] = [];
    for (const [id, remote] of this.remotes) {
      if (remote.kind !== 'monster' || remote.dead) continue;
      const pos = remote.view.root.position;
      v.set(pos.x, 0, pos.z).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const footX = (v.x + 1) * 0.5 * width;
      const footY = (1 - v.y) * 0.5 * height;
      v.set(pos.x, remote.view.height, pos.z).project(camera);
      const headX = (v.x + 1) * 0.5 * width;
      const headY = (1 - v.y) * 0.5 * height;
      candidates.push({
        id,
        x: (footX + headX) / 2,
        y: (footY + headY) / 2,
        radius: Math.max(MIN_PICK_RADIUS, Math.hypot(headX - footX, headY - footY) * 0.6),
      });
    }
    const id = pickEntity(candidates, px, py);
    if (id === 0) return false;
    if (id !== this.targeting.targetId) {
      this.targeting.set(id);
      this.net.send({ t: 'target', id });
    }
    return true;
  }

  /** 放弃当前的目标。notify 为 false 时不通知服务器（服务器自己已经清掉了，比如玩家死亡）。 */
  private clearTarget(notify: boolean): void {
    if (this.targeting.targetId === 0) return;
    this.targeting.clear();
    this.ring.hide();
    if (notify) this.net.send({ t: 'target', id: 0 });
  }

  /**
   * 追击当前的目标：服务端只判定伤害，把角色带到目标旁边是客户端的事。
   * 这里发出的移动和点击地面完全一样，走的是同一套预测和校验。
   */
  private chaseTarget(now: number): void {
    if (this.targeting.targetId === 0) return;
    const remote = this.remotes.get(this.targeting.targetId);
    if (!remote || remote.dead) {
      // 目标死了或者离开了视野。
      this.clearTarget(true);
      return;
    }
    const order = this.targeting.update(now, this.local, remote);
    if (order && this.local.requestMove(order.x, order.z)) this.net.send({ t: 'moveTo', x: order.x, z: order.z });
    const pos = remote.view.root.position;
    this.ring.show(pos.x, pos.z);
  }

  private readonly resize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    this.labels.setSize(width, height);
    this.rig.resize(width / height);
  };

  private readonly frame = (): void => {
    const now = performance.now();
    // 切到后台再回来时 dt 会很大，限制一下避免一步跨太远。
    const dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;

    this.input.update(now);

    if (this.selfDead) {
      const seconds = Math.ceil((this.respawnAt - now) / 1000);
      this.hud.setBanner(seconds > 0 ? `你倒下了，${seconds} 秒后在出生点复活` : '正在复活…');
    } else {
      this.chaseTarget(now);
      this.local.update(dt, now);
    }
    if (this.selfView) {
      this.selfView.setPose(this.local.x, this.local.z, this.local.moving);
      this.selfView.update(dt);
    }

    // 其他实体显示的是稍早一点的状态，这样总有前后两个快照可以插值。
    const renderTime = this.net.serverNow() - INTERP_DELAY_MS;
    let monsters = 0;
    for (const remote of this.remotes.values()) {
      if (remote.kind === 'monster') monsters++;
      if (remote.buffer.sample(renderTime, this.sample)) {
        remote.view.setPose(this.sample.x, this.sample.z, this.sample.moving && !remote.dead);
      }
      remote.view.update(dt);
    }

    this.marker.update(dt);
    this.ring.update(dt);
    this.floating.update(dt);
    this.rig.update(this.local.x, this.local.z, dt);
    this.world.followSun(this.local.x, this.local.z);

    this.renderer.render(this.world.scene, this.rig.camera);
    this.labels.render(this.world.scene, this.rig.camera);

    this.hud.frame(now, {
      rtt: this.net.rtt,
      players: this.remotes.size - monsters + (this.selfView ? 1 : 0),
      monsters,
      x: this.local.x,
      z: this.local.z,
      corrections: this.local.corrections,
    });
  };
}
