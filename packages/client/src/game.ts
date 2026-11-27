import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { generateMap, INTERP_DELAY_MS } from '@mmo/shared';
import type { EntityInfo, ServerMsg } from '@mmo/shared';
import { CameraRig } from './camera';
import { EntityView } from './entities';
import type { CharacterAssets } from './entities';
import type { Hud } from './hud';
import { Input, MoveMarker } from './input';
import { SnapshotBuffer } from './interpolation';
import type { Sample } from './interpolation';
import { LocalPlayer } from './localPlayer';
import type { Net } from './net';
import { WorldScene } from './scene';

interface Remote {
  view: EntityView;
  buffer: SnapshotBuffer;
}

/** 客户端主体：把网络消息变成场景里的角色，并驱动每一帧的更新和渲染。 */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly world: WorldScene;
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly local: LocalPlayer;
  private readonly marker = new MoveMarker();
  private readonly remotes = new Map<number, Remote>();
  private readonly sample: Sample = { x: 0, z: 0, moving: false };
  private selfView: EntityView | null = null;
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
    this.world = new WorldScene(map);
    this.world.scene.add(this.marker.mesh);

    // WebGL 不可用时这里会抛出异常，由调用方提示用户。
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    // 名字标签用 DOM 元素叠在画面上，文字清晰，也不用自己画字。
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    const canvas = this.renderer.domElement;
    this.rig = new CameraRig(canvas, 1);
    this.rig.snapTo(map.size / 2, map.size / 2);
    this.input = new Input(canvas, this.rig.camera, (x, z) => this.onMoveInput(x, z));

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
        for (const [id, x, z, moving] of msg.entities) {
          if (id === this.selfId) {
            this.local.onServerState(x, z, moving === 1);
          } else {
            this.remotes.get(id)?.buffer.push(msg.time, x, z, moving === 1);
          }
        }
        break;
      case 'welcome':
      case 'pong':
        break;
    }
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
  }

  private onEnter(info: EntityInfo): void {
    if (info.id === this.selfId) {
      this.local.place(info.x, info.z);
      if (!this.selfView) {
        this.selfView = new EntityView(info.id, info.name, true, this.assets);
        this.world.scene.add(this.selfView.root);
      }
      this.selfView.place(info.x, info.z);
      this.rig.snapTo(info.x, info.z);
      this.hud.show();
      return;
    }

    let remote = this.remotes.get(info.id);
    if (!remote) {
      remote = { view: new EntityView(info.id, info.name, false, this.assets), buffer: new SnapshotBuffer() };
      this.remotes.set(info.id, remote);
      this.world.scene.add(remote.view.root);
    }
    remote.view.place(info.x, info.z);
    // 先放一个初始状态，之后的快照会接着它插值。
    remote.buffer.push(this.net.serverNow(), info.x, info.z, info.moving);
  }

  private onMoveInput(x: number, z: number): void {
    if (!this.selfView) return;
    // 先在本地验证并开始走，再告诉服务器。服务器会用同样的规则重新算一遍。
    if (!this.local.requestMove(x, z)) return;
    this.net.send({ t: 'moveTo', x, z });
    this.marker.show(x, z);
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

    this.local.update(dt, now);
    if (this.selfView) {
      this.selfView.setPose(this.local.x, this.local.z, this.local.moving);
      this.selfView.update(dt);
    }

    // 其他玩家显示的是稍早一点的状态，这样总有前后两个快照可以插值。
    const renderTime = this.net.serverNow() - INTERP_DELAY_MS;
    for (const remote of this.remotes.values()) {
      if (remote.buffer.sample(renderTime, this.sample)) {
        remote.view.setPose(this.sample.x, this.sample.z, this.sample.moving);
      }
      remote.view.update(dt);
    }

    this.marker.update(dt);
    this.rig.update(this.local.x, this.local.z, dt);
    this.world.followSun(this.local.x, this.local.z);

    this.renderer.render(this.world.scene, this.rig.camera);
    this.labels.render(this.world.scene, this.rig.camera);

    this.hud.frame(now, {
      rtt: this.net.rtt,
      visible: this.remotes.size + (this.selfView ? 1 : 0),
      x: this.local.x,
      z: this.local.z,
      corrections: this.local.corrections,
    });
  };
}
