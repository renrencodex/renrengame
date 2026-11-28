import * as THREE from 'three';
import { merchantPosition, SAFE_ZONE_RADIUS } from '@mmo/shared';
import type { GameMap } from '@mmo/shared';
import { createLandscape } from './landscape';
import type { LandscapeTextures } from './terrain';

const SKY_COLOR = 0xacbeb6;
/** 雾从离镜头这么远的地方开始，到这么远时完全盖住。按宽屏下镜头的默认远近定的。 */
const FOG_NEAR = 37;
const FOG_FAR = 155;
/** 阴影只覆盖玩家周围这么大的范围，跟着玩家移动。 */
const SHADOW_RANGE = 45;
const SUN_OFFSET = new THREE.Vector3(-35, 60, 25);
const MERCHANT_RUG_RADIUS = 1.3;

/** 3D 场景：地面、障碍物、安全区边界、商人的地毯、光照和雾。 */
export class WorldScene {
  readonly scene = new THREE.Scene();
  private readonly sun: THREE.DirectionalLight;
  private readonly landscape: ReturnType<typeof createLandscape>;
  private readonly fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR);

  constructor(map: GameMap, textures: LandscapeTextures) {
    const scene = this.scene;
    scene.background = new THREE.Color(SKY_COLOR);
    scene.fog = this.fog;

    scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x626e5c, 1.20));

    const sun = new THREE.DirectionalLight(0xffe7c1, 1.95);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -SHADOW_RANGE;
    sun.shadow.camera.right = SHADOW_RANGE;
    sun.shadow.camera.top = SHADOW_RANGE;
    sun.shadow.camera.bottom = -SHADOW_RANGE;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 1.65;
    scene.add(sun, sun.target);
    this.sun = sun;

    this.landscape = createLandscape(map, textures);
    scene.add(
      this.landscape.group,
      createSurroundings(map.size),
      createSafeZoneRing(map.size),
      createMerchantRug(map.size),
    );
    this.followSun(map.size / 2, map.size / 2);
  }

  update(camera: THREE.Camera, seconds: number): void {
    this.landscape.update(camera, seconds);
  }

  reduceDetail(): void {
    this.landscape.reduceDetail();
    const shadow = this.sun.shadow;
    shadow.map?.dispose();
    shadow.map = null;
    shadow.mapSize.set(1024, 1024);
  }

  /**
   * 竖屏时镜头会按比例拉远（CameraRig.viewScale），雾也要跟着变远，
   * 不然镜头一拉远，整个画面就都罩在雾里了。
   */
  setViewScale(scale: number): void {
    this.fog.near = FOG_NEAR * scale;
    this.fog.far = FOG_FAR * scale;
  }

  /** 让平行光和它的阴影范围跟着玩家走。 */
  followSun(x: number, z: number): void {
    this.sun.position.set(x + SUN_OFFSET.x, SUN_OFFSET.y, z + SUN_OFFSET.z);
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
  }
}

/** 地图外面一圈深色的地面，让地图边界看得出来。 */
function createSurroundings(size: number): THREE.Mesh {
  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 4, size * 4),
    new THREE.MeshStandardMaterial({ color: 0x33472b, roughness: 1, metalness: 0 }),
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.set(size / 2, -0.05, size / 2);
  return outer;
}

/** 出生点周围安全区的边界：地上的一圈浅色线，怪物不会越过它。 */
function createSafeZoneRing(size: number): THREE.Mesh {
  const geometry = new THREE.RingGeometry(SAFE_ZONE_RADIUS - 0.12, SAFE_ZONE_RADIUS + 0.12, 128);
  geometry.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0xd8f6ff, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  ring.position.set(size / 2, 0.03, size / 2);
  return ring;
}

/**
 * 商人脚下的地毯：一块深红色的圆垫子，外面一圈金边。
 * 商人和玩家用的是同一种人物模型，靠这块地毯老远就能认出他站在哪。
 */
function createMerchantRug(size: number): THREE.Group {
  const rug = new THREE.Group();
  const mat = new THREE.Mesh(
    new THREE.CircleGeometry(MERCHANT_RUG_RADIUS, 48),
    new THREE.MeshStandardMaterial({ color: 0x8a2a3a, roughness: 1, metalness: 0 }),
  );
  mat.receiveShadow = true;
  const trim = new THREE.Mesh(
    new THREE.RingGeometry(MERCHANT_RUG_RADIUS - 0.12, MERCHANT_RUG_RADIUS, 48),
    new THREE.MeshStandardMaterial({ color: 0xe8c060, roughness: 0.8, metalness: 0 }),
  );
  trim.position.z = 0.01;
  trim.receiveShadow = true;
  rug.add(mat, trim);
  rug.rotation.x = -Math.PI / 2;
  const at = merchantPosition(size);
  rug.position.set(at.x, 0.02, at.z);
  return rug;
}
