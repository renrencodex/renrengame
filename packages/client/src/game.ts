import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  AOI_CELL_SIZE,
  CLIENT_SHOP_RANGE,
  generateMap,
  INTERP_DELAY_MS,
  ITEM_IDS,
  ITEMS,
  MERCHANT_NAME,
  merchantPosition,
  Pathfinder,
  PLAYER_MAX_HP,
  PLAYER_RESPAWN_MS,
  POTION_COOLDOWN_MS,
  STATE_DEAD,
  STATE_MOVING,
} from '@mmo/shared';
import type {
  CharacterKind,
  DropInfo,
  EntityInfo,
  EntityState,
  Inventory,
  ItemId,
  Point,
  ServerMsg,
} from '@mmo/shared';
import { CameraRig } from './camera';
import { DropView } from './drops';
import type { ItemAssets } from './drops';
import { FloatingTexts, TargetRing } from './effects';
import { EntityView } from './entities';
import type { CharacterAssets } from './entities';
import type { Hud } from './hud';
import { Input, MoveMarker } from './input';
import { SnapshotBuffer } from './interpolation';
import type { Sample } from './interpolation';
import { LocalPlayer } from './localPlayer';
import type { Net } from './net';
import { pickEntity, screenPickCandidate } from './picking';
import type { PickCandidate } from './picking';
import { RenderQuality } from './renderQuality';
import { WorldScene } from './scene';
import { distanceVolume, inventorySound } from './sound';
import type { SoundPlayer } from './sound';
import type { SoundId } from './synth';
import { Targeting } from './targeting';
import type { LandscapeTextures } from './terrain';

/** 视野里除自己以外的一个实体（其他玩家或怪物）。 */
interface Remote {
  view: EntityView;
  buffer: SnapshotBuffer;
  kind: CharacterKind;
  name: string;
  hp: number;
  maxHp: number;
  dead: boolean;
  /** 最新快照里的位置。画面上显示的是插值后稍早一点的位置，追击要用最新的。 */
  x: number;
  z: number;
}

/** 点选怪物和物品时的最小半径（像素），保证离得远、看起来很小的目标也点得中。 */
const MIN_PICK_RADIUS = 22;
/** 发出喝药水的请求之后，这么久之内不再发第二次，等服务器的结果。 */
const USE_RETRY_MS = 500;
/** 同时捡到几样东西时，每一行提示文字之间的间隔。 */
const LOOT_TEXT_GAP = 0.4;
/** 点选时代表商人的 id。服务器下发的实体 id 都是正数，不会撞上。 */
const MERCHANT_PICK_ID = -1;
/** 点了商人之后，走到离他这么远的地方站住。 */
const MERCHANT_STAND_DISTANCE = 1.6;
/** 商店打开之后，走到比打开的距离再远这么多才关上，免得站在边上时开开关关。 */
const SHOP_CLOSE_MARGIN = 0.6;
/** 离商人超过这么远就不画他了。和服务器的视野差不多大，画面里本来也看不到那么远。 */
const MERCHANT_VISIBLE_DISTANCE = AOI_CELL_SIZE * 1.5;
/** 自己跑步时两次脚步声的间隔：跑步动作一个来回（0.933 秒，播放速度 1.2）迈两步。 */
const STEP_SECONDS = 0.39;
/** 起步之后过这么久响第一声。 */
const FIRST_STEP_SECONDS = 0.12;
/** 和自己无关的声音（别人打怪、别的怪物倒下）除了按距离变小，再打这个折扣，不盖过自己的。 */
const OTHERS_VOLUME = 0.6;
/** 声音在画面最左、最右时偏向那一侧的程度。不偏到底，戴耳机时不会只有一边响。 */
const PAN_WIDTH = 0.7;

/** 客户端主体：把网络消息变成场景里的角色，并驱动每一帧的更新和渲染。 */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly world: WorldScene;
  private readonly quality = new RenderQuality();
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly local: LocalPlayer;
  private readonly targeting: Targeting;
  private readonly marker = new MoveMarker();
  private readonly ring = new TargetRing();
  private readonly floating: FloatingTexts;
  private readonly remotes = new Map<number, Remote>();
  /** 视野里掉在地上的物品。 */
  private readonly drops = new Map<number, DropView>();
  private readonly sample: Sample = { x: 0, z: 0, moving: false };
  private readonly projected = new THREE.Vector3();
  /** 安全区里的商人。他不会动，位置由地图大小决定，所以不是服务器下发的实体。 */
  private readonly merchant: EntityView;
  private readonly merchantAt: Point;
  /** 点了商人、正在朝他走过去；走到跟前就打开商店。中途点了别的就作罢。 */
  private headingToShop = false;
  private selfView: EntityView | null = null;
  private selfDead = false;
  private selfHp = PLAYER_MAX_HP;
  /** 预计复活的本地时间，只用来显示倒计时；真正的复活以服务器的消息为准。 */
  private respawnAt = 0;
  /** 服务器最近一次发来的背包。还没收到过时为 null。 */
  private inventory: Inventory | null = null;
  /** 服务器最近一次说的、自己手里的武器。 */
  private weapon: ItemId | null = null;
  /** 这个时间之前不发喝药水的请求。服务器有自己的冷却判定，这里只是不发注定失败的请求。 */
  private potionReadyAt: number;
  /** 再过多久响下一声脚步。 */
  private stepIn = FIRST_STEP_SECONDS;
  private lastFrameAt = performance.now();

  constructor(
    private readonly container: HTMLElement,
    private readonly net: Net,
    private readonly hud: Hud,
    private readonly sound: SoundPlayer,
    private readonly assets: CharacterAssets | null,
    private readonly itemAssets: ItemAssets,
    landscape: LandscapeTextures,
    private readonly selfId: number,
    seed: number,
  ) {
    // 用服务器下发的种子生成和服务端完全相同的地图。
    const map = generateMap(seed);
    this.local = new LocalPlayer(map);
    const pathfinder = new Pathfinder(map);
    this.targeting = new Targeting((ax, az, bx, bz) => pathfinder.lineOfSight(ax, az, bx, bz));
    this.world = new WorldScene(map, landscape);
    this.world.scene.add(this.marker.mesh, this.ring.mesh);
    this.floating = new FloatingTexts(this.world.scene);

    this.merchantAt = merchantPosition(map.size);
    this.merchant = new EntityView(
      { id: MERCHANT_PICK_ID, kind: 'npc', name: MERCHANT_NAME, hp: 1, maxHp: 1 },
      false,
      assets,
      itemAssets,
    );
    this.merchant.place(this.merchantAt.x, this.merchantAt.z);
    // 平时面朝出生点的中心，有人来买东西时转向客人。
    this.merchant.turnTo(map.size / 2, map.size / 2);
    this.world.scene.add(this.merchant.root);

    // WebGL 不可用时这里会抛出异常，由调用方提示用户。
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
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
      (factor) => this.rig.zoomBy(factor),
    );

    // 刚进入世界时，服务器那边药水先走一轮冷却。
    this.potionReadyAt = performance.now() + POTION_COOLDOWN_MS;
    this.hud.setMap(map);
    this.hud.setPotionCooldown(this.potionReadyAt);
    this.hud.onUsePotion = () => this.usePotion();
    // 换武器由服务器判定，这里只把请求发出去；结果会随背包和 weapon 消息回来。
    this.hud.onEquip = (item) => {
      if (!this.selfDead) this.net.send({ t: 'equip', item });
    };
    this.hud.onUnequip = () => {
      if (!this.selfDead) this.net.send({ t: 'unequip' });
    };
    // 买卖也一样：服务器按它算的位置、金币和背包判定，成了就发来新的背包。
    this.hud.onBuy = (item, count) => {
      if (!this.selfDead) this.net.send({ t: 'buy', item, count });
    };
    this.hud.onSell = (item, count) => {
      if (!this.selfDead) this.net.send({ t: 'sell', item, count });
    };

    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown);
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
          if (remote) {
            remote.view.dispose();
            this.remotes.delete(id);
            continue;
          }
          const drop = this.drops.get(id);
          if (drop) {
            drop.dispose();
            this.drops.delete(id);
          }
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
          remote.hp = hp;
          remote.view.setHp(hp);
          if (id === this.targeting.targetId) this.hud.setTargetHp(hp, remote.maxHp);
          if (this.setRemoteDead(remote, state === STATE_DEAD) && remote.dead) {
            const cue = remote.kind === 'monster' ? 'monsterDeath' : 'playerDeath';
            // 自己正在打的那只倒下时，声音不按距离减小。
            this.playAt(cue, x, z, id === this.targeting.targetId);
          }
        }
        break;
      case 'hit':
        this.onHit(msg.from, msg.to, msg.damage);
        break;
      case 'heal':
        this.onHeal(msg.id, msg.amount);
        break;
      case 'inv':
        this.onInventory(msg.items, msg.weapon);
        break;
      case 'weapon': {
        const view = this.viewOf(msg.id);
        if (!view) break;
        view.setWeapon(msg.item);
        const { x, z } = view.root.position;
        this.playAt(msg.item ? 'equip' : 'unequip', x, z, msg.id === this.selfId);
        break;
      }
      case 'welcome':
      case 'pong':
        break;
    }
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.input.enabled = false;
    this.hud.onUsePotion = null;
    this.hud.onEquip = null;
    this.hud.onUnequip = null;
    this.hud.onBuy = null;
    this.hud.onSell = null;
    this.hud.closePanels();
    this.hud.setBanner(null);
    this.hud.hideTarget();
    this.hud.hide();
  }

  private onEnter(info: EntityInfo): void {
    if (info.kind === 'drop') {
      this.onDropEnter(info);
      return;
    }
    if (info.id === this.selfId) {
      // 进入世界，或者死亡后在出生点复活（服务端按“离开再进入”处理）。
      this.local.place(info.x, info.z);
      if (!this.selfView) {
        this.selfView = new EntityView(info, true, this.assets, this.itemAssets);
        this.world.scene.add(this.selfView.root);
        this.hud.setPlayer(info.name, this.selfView.portrait);
      }
      this.selfView.setWeapon(info.weapon ?? null);
      this.selfView.place(info.x, info.z);
      this.rig.snapTo(info.x, info.z);
      this.hud.show();
      this.onSelfState(info.x, info.z, info.state, info.hp);
      return;
    }

    let remote = this.remotes.get(info.id);
    if (!remote) {
      remote = {
        view: new EntityView(info, false, this.assets, this.itemAssets),
        buffer: new SnapshotBuffer(),
        kind: info.kind,
        name: info.name,
        hp: info.hp,
        maxHp: info.maxHp,
        dead: false,
        x: info.x,
        z: info.z,
      };
      this.remotes.set(info.id, remote);
      this.world.scene.add(remote.view.root);
    }
    remote.x = info.x;
    remote.z = info.z;
    remote.hp = info.hp;
    remote.view.place(info.x, info.z);
    remote.view.setHp(info.hp);
    remote.view.setWeapon(info.weapon ?? null);
    // 进入视野时已经死了的，直接显示倒地的样子，不再播一遍倒下的过程。
    this.setRemoteDead(remote, info.state === STATE_DEAD, true);
    // 先放一个初始状态，之后的快照会接着它插值。
    remote.buffer.push(this.net.serverNow(), info.x, info.z, info.state === STATE_MOVING);
  }

  private onDropEnter(info: DropInfo): void {
    if (this.drops.has(info.id)) return;
    const drop = new DropView(info, this.itemAssets);
    this.drops.set(info.id, drop);
    this.world.scene.add(drop.root);
  }

  /** 服务器发来的自己的权威状态。 */
  private onSelfState(x: number, z: number, state: EntityState, hp: number): void {
    this.selfHp = hp;
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
        this.headingToShop = false;
        this.hud.closeShop();
        this.respawnAt = performance.now() + PLAYER_RESPAWN_MS;
        this.sound.play('playerDeath');
      } else {
        this.hud.setBanner(null);
        this.sound.play('respawn');
      }
    }
    if (!dead) this.local.onServerState(x, z, state === STATE_MOVING);
  }

  /** 返回死活有没有变。 */
  private setRemoteDead(remote: Remote, dead: boolean, instant = false): boolean {
    if (remote.dead === dead) return false;
    remote.dead = dead;
    remote.view.setDead(dead, instant);
    return true;
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

    // 怪物只打玩家、玩家只打怪物，所以看挨打的是谁就知道是哪一种攻击；打人的不在视野里也没关系。
    let cue: SoundId;
    if (to === this.selfId) cue = 'hurt';
    else if (this.remotes.get(to)?.kind !== 'monster') cue = 'claw';
    else cue = attacker?.armed ? 'slash' : 'punch';
    this.playAt(cue, x, z, from === this.selfId || to === this.selfId);
  }

  /**
   * 在 (x, z) 响一个声音。own 是和自己直接有关的（自己打的、自己挨的），用原本的音量；
   * 别的按离自己多远变小，太远就不响。左右的位置跟着它在画面上的位置走。
   * 声音都是从已有的消息和状态里推出来的，不为它加消息；hit 和 heal 积压时会被丢掉，那一下就没有声音。
   */
  private playAt(id: SoundId, x: number, z: number, own: boolean): void {
    const volume = own ? 1 : OTHERS_VOLUME * distanceVolume(Math.hypot(x - this.local.x, z - this.local.z));
    if (volume <= 0) return;
    const onScreen = this.projected.set(x, 0, z).project(this.rig.camera);
    this.sound.play(id, volume, THREE.MathUtils.clamp(onScreen.x, -1, 1) * PAN_WIDTH);
  }

  private onHeal(id: number, amount: number): void {
    const view = this.viewOf(id);
    if (!view) return;
    const { x, z } = view.root.position;
    this.floating.spawn(x, view.height + 0.3, z, `+${amount}`, 'heal-text');
    // 自己喝药水的声音跟着背包的变化走（见 onInventory），那个不会丢。
    if (id !== this.selfId) this.playAt('drink', x, z, false);
  }

  /**
   * 服务器发来的背包和手里的武器。和上一次比，多出来的就是刚捡到的，在自己头上提示一下；
   * 药水少了说明刚喝了一瓶，开始冷却。
   */
  private onInventory(items: Inventory, weapon: ItemId | null): void {
    const before = this.inventory;
    const weaponBefore = this.weapon;
    this.inventory = items;
    this.weapon = weapon;
    this.hud.setInventory(items, weapon);
    // 第一次是进入世界时的背包，不算捡到。
    if (!before) return;

    const cue = inventorySound(before, weaponBefore, items, weapon);
    if (cue) this.sound.play(cue);
    if ((items.potion ?? 0) < (before.potion ?? 0)) {
      this.potionReadyAt = performance.now() + POTION_COOLDOWN_MS;
      this.hud.setPotionCooldown(this.potionReadyAt);
    }
    if (!this.selfView) return;
    const { x, z } = this.selfView.root.position;
    let line = 0;
    for (const id of ITEM_IDS) {
      // 手里的那一件也算进去，这样把武器拿起来、收回去不会被当成丢了或者捡到一件。
      const total = (items[id] ?? 0) + (weapon === id ? 1 : 0);
      const gained = total - (before[id] ?? 0) - (weaponBefore === id ? 1 : 0);
      if (gained <= 0) continue;
      // 从名字和血条的上方冒出来，不和它们叠在一起。
      const y = this.selfView.height + 0.9 + line++ * LOOT_TEXT_GAP;
      this.floating.spawn(x, y, z, `+${gained} ${ITEMS[id].name}`, `loot-text ${id}`);
    }
  }

  /** 喝一瓶治疗药水。能不能喝由服务器判定，这里只拦掉明显喝不了的情况。 */
  private usePotion(): void {
    const now = performance.now();
    if (!this.selfView || this.selfDead || now < this.potionReadyAt) return;
    if ((this.inventory?.potion ?? 0) < 1 || this.selfHp >= PLAYER_MAX_HP) return;
    this.potionReadyAt = now + USE_RETRY_MS;
    this.net.send({ t: 'use', item: 'potion' });
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    // 按住不放时的自动重复不算；正在输入框里打字时也不算。
    if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const target = ev.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (ev.key === '1') this.usePotion();
    else if (ev.key === 'b' || ev.key === 'B') this.hud.toggleBag();
    else if (ev.key === 'm' || ev.key === 'M') this.hud.toggleSound();
    else if (ev.key === 'Escape') {
      this.headingToShop = false;
      this.hud.closePanels();
    }
  };

  private viewOf(id: number): EntityView | null {
    return id === this.selfId ? this.selfView : (this.remotes.get(id)?.view ?? null);
  }

  // ---- 输入 ----

  private onMoveInput(x: number, z: number): void {
    if (!this.selfView || this.selfDead) return;
    // 点地面就是放弃当前的目标，也不再去找商人。
    this.clearTarget(true);
    this.headingToShop = false;
    // 先在本地验证并开始走，再告诉服务器。服务器会用同样的规则重新算一遍。
    if (!this.local.requestMove(x, z)) return;
    this.net.send({ t: 'moveTo', x, z });
    this.marker.show(x, z);
  }

  /** 按下时先看有没有点中怪物或地上的物品。px、py 是相对画布左上角的像素坐标。 */
  private onPick(px: number, py: number): boolean {
    if (!this.selfView || this.selfDead) return false;
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const camera = this.rig.camera;
    camera.updateMatrixWorld();
    const v = this.projected;
    const candidates: PickCandidate[] = [];
    /** 一个从地面 (x, z) 立起来、高 h 的目标，在屏幕上占的位置。 */
    const add = (id: number, x: number, z: number, h: number): void => {
      v.set(x, 0, z).project(camera);
      const foot = { x: v.x, y: v.y, z: v.z };
      v.set(x, h, z).project(camera);
      const candidate = screenPickCandidate(id, foot, { x: v.x, y: v.y, z: v.z }, width, height, MIN_PICK_RADIUS);
      if (candidate) candidates.push(candidate);
    };
    for (const [id, remote] of this.remotes) {
      if (remote.kind !== 'monster' || remote.dead) continue;
      const pos = remote.view.root.position;
      add(id, pos.x, pos.z, remote.view.height);
    }
    for (const [id, drop] of this.drops) add(id, drop.x, drop.z, drop.height);
    if (this.merchant.root.visible) add(MERCHANT_PICK_ID, this.merchantAt.x, this.merchantAt.z, this.merchant.height);

    const id = pickEntity(candidates, px, py);
    if (id === 0) return false;
    if (id === MERCHANT_PICK_ID) {
      this.visitMerchant();
      return true;
    }
    this.headingToShop = false;
    const drop = this.drops.get(id);
    if (drop) {
      // 点地上的物品就是走到它那里，走到跟前服务器会自动让角色捡起来。
      this.onMoveInput(drop.x, drop.z);
      return true;
    }
    if (id !== this.targeting.targetId) {
      const remote = this.remotes.get(id);
      if (!remote) return false;
      this.targeting.set(id);
      this.hud.showTarget(remote.name, remote.hp, remote.maxHp);
      this.net.send({ t: 'target', id });
    }
    return true;
  }

  /**
   * 点了商人：已经在他跟前就直接打开商店，否则先走过去。
   * 走过去用的是普通的 moveTo，服务器不知道“去找商人”这回事，它只在买卖时检查离商人够不够近。
   */
  private visitMerchant(): void {
    this.clearTarget(true);
    const m = this.merchantAt;
    const dx = this.local.x - m.x;
    const dz = this.local.z - m.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= CLIENT_SHOP_RANGE) {
      this.headingToShop = false;
      this.hud.openShop();
      return;
    }
    // 停在商人朝自己这一侧的面前，不站到他身上去。
    const x = m.x + (dx / distance) * MERCHANT_STAND_DISTANCE;
    const z = m.z + (dz / distance) * MERCHANT_STAND_DISTANCE;
    if (!this.local.requestMove(x, z)) return;
    this.net.send({ t: 'moveTo', x, z });
    this.headingToShop = true;
  }

  /** 每帧调用：走到商人跟前时打开商店，走远了关上；远得看不见时不画他。 */
  private updateMerchant(dt: number): void {
    const m = this.merchantAt;
    const distance = Math.hypot(this.local.x - m.x, this.local.z - m.z);
    this.merchant.root.visible = distance <= MERCHANT_VISIBLE_DISTANCE;
    if (!this.merchant.root.visible) return;
    if (!this.selfDead) {
      if (this.headingToShop && distance <= CLIENT_SHOP_RANGE) {
        this.headingToShop = false;
        this.hud.openShop();
      }
      if (this.hud.shopOpen) {
        if (distance > CLIENT_SHOP_RANGE + SHOP_CLOSE_MARGIN) this.hud.closeShop();
        else this.merchant.turnTo(this.local.x, this.local.z);
      }
    }
    this.merchant.update(dt);
  }

  /** 放弃当前的目标。notify 为 false 时不通知服务器（服务器自己已经清掉了，比如玩家死亡）。 */
  private clearTarget(notify: boolean): void {
    if (this.targeting.targetId === 0) return;
    this.targeting.clear();
    this.ring.hide();
    this.hud.hideTarget();
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

  /** 自己跑动时按固定的间隔响脚步声。别人和怪物的脚步不响，人一多就成了一片噪声。 */
  private updateSteps(dt: number): void {
    if (!this.local.moving) {
      this.stepIn = FIRST_STEP_SECONDS;
      return;
    }
    this.stepIn -= dt;
    if (this.stepIn > 0) return;
    // 多走过的那一点时间算进下一步里，帧率低的时候脚步也不会越来越慢、和跑步的动作错开。
    this.stepIn += STEP_SECONDS;
    this.sound.play('step');
  }

  private readonly resize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    this.labels.setSize(width, height);
    this.rig.resize(width / height);
    this.world.setViewScale(this.rig.viewScale);
  };

  private readonly frame = (): void => {
    const now = performance.now();
    // 切到后台再回来时 dt 会很大，限制一下避免一步跨太远。
    const dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;

    if (this.quality.update(now, document.visibilityState === 'visible')) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25) * 0.76);
      this.world.reduceDetail();
    }

    this.input.update(now);

    if (this.selfDead) {
      const seconds = Math.ceil((this.respawnAt - now) / 1000);
      this.hud.setBanner(seconds > 0 ? `你倒下了，${seconds} 秒后在出生点复活` : '正在复活…');
    } else {
      this.chaseTarget(now);
      this.local.update(dt, now);
      this.updateSteps(dt);
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
    for (const drop of this.drops.values()) drop.update(dt);
    this.updateMerchant(dt);

    this.marker.update(dt);
    this.ring.update(dt);
    this.floating.update(dt);
    this.rig.update(this.local.x, this.local.z, dt);
    this.world.followSun(this.local.x, this.local.z);
    this.world.update(this.rig.camera, now / 1000);

    this.renderer.render(this.world.scene, this.rig.camera);
    this.labels.render(this.world.scene, this.rig.camera);

    this.hud.frame(now, {
      rtt: this.net.rtt,
      players: this.remotes.size - monsters + (this.selfView ? 1 : 0),
      monsters,
      x: this.local.x,
      z: this.local.z,
      yaw: this.selfView?.root.rotation.y ?? 0,
      corrections: this.local.corrections,
    });
  };
}
