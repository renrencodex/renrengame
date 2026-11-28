import * as THREE from 'three';
import { merchantPosition, mulberry32, SAFE_ZONE_RADIUS } from '@mmo/shared';
import type { GameMap } from '@mmo/shared';

const SKY_COLOR = 0xa8c8e8;
/** 阴影只覆盖玩家周围这么大的范围，跟着玩家移动。 */
const SHADOW_RANGE = 45;
const SUN_OFFSET = new THREE.Vector3(-35, 60, 25);
/** 障碍物画得比网格略小一圈，角色贴着走时不会明显穿进去。 */
const OBSTACLE_INSET = 0.15;
/** 地面贴图一格对应的世界单位。 */
const GROUND_TILE = 4;
const MERCHANT_RUG_RADIUS = 1.3;

/** 3D 场景：地面、障碍物、安全区边界、商人的地毯、光照和雾。 */
export class WorldScene {
  readonly scene = new THREE.Scene();
  private readonly sun: THREE.DirectionalLight;

  constructor(map: GameMap) {
    const scene = this.scene;
    scene.background = new THREE.Color(SKY_COLOR);
    scene.fog = new THREE.Fog(SKY_COLOR, 40, 180);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6b4a, 1.3));

    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
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
    scene.add(sun, sun.target);
    this.sun = sun;

    scene.add(
      createGround(map.size),
      createSurroundings(map.size),
      createObstacles(map),
      createSafeZoneRing(map.size),
      createMerchantRug(map.size),
    );
    this.followSun(map.size / 2, map.size / 2);
  }

  /** 让平行光和它的阴影范围跟着玩家走。 */
  followSun(x: number, z: number): void {
    this.sun.position.set(x + SUN_OFFSET.x, SUN_OFFSET.y, z + SUN_OFFSET.z);
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
  }
}

function createGround(size: number): THREE.Mesh {
  const texture = createGroundTexture();
  texture.repeat.set(size / GROUND_TILE, size / GROUND_TILE);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(size / 2, 0, size / 2);
  ground.receiveShadow = true;
  return ground;
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

/** 用 canvas 画一张可平铺的草地贴图，带浅浅的格线，移动时能看出速度。 */
function createGroundTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#6f9e58';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.06)';
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** 所有障碍物合成一个 InstancedMesh，只占一次绘制调用。 */
function createObstacles(map: GameMap): THREE.InstancedMesh {
  const count = map.obstacles.length;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }),
    count,
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const rand = mulberry32(map.seed ^ 0x5bd1e995);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const o = map.obstacles[i];
    position.set(o.x + o.w / 2, o.h / 2, o.z + o.d / 2);
    scale.set(o.w - OBSTACLE_INSET * 2, o.h, o.d - OBSTACLE_INSET * 2);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(i, matrix);
    color.setHSL(0.07 + rand() * 0.05, 0.12 + rand() * 0.18, 0.5 + rand() * 0.2);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}
