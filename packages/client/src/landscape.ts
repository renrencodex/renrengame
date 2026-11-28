import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mulberry32, Terrain } from '@mmo/shared';
import type { Bridge, GameMap, Obstacle, Point } from '@mmo/shared';

const TILE_PIXELS = 8;
// 批次只画视野里的小片景物。远处森林也不会挤占村庄里的绘制时间。
const BATCH_SIZE = 32;
const GROUND: Record<Terrain, readonly [number, number, number]> = {
  [Terrain.Grass]: [116, 133, 72],
  [Terrain.Forest]: [74, 100, 59],
  [Terrain.Meadow]: [141, 152, 86],
  [Terrain.Village]: [135, 129, 88],
  [Terrain.Stone]: [128, 133, 104],
  [Terrain.Bank]: [153, 143, 97],
  [Terrain.Water]: [56, 106, 119],
  [Terrain.Road]: [170, 145, 105],
  [Terrain.Bridge]: [133, 94, 57],
};

type Vec3 = [number, number, number];
type Shape = 'box' | 'roof' | 'trunk' | 'pine' | 'leaves' | 'rock' | 'tuft' | 'flower';

interface Part {
  position: Vec3;
  size: Vec3;
  color: number;
  yaw: number;
  roll: number;
}

/** 静态景物按几何形状合批。草叶单独绘制，不进入阴影贴图。 */
class Scenery {
  private readonly batches = new Map<string, { shape: Shape; parts: Part[] }>();

  add(shape: Shape, position: Vec3, size: Vec3, color: number, yaw = 0, roll = 0): void {
    const key = `${shape}:${Math.floor(position[0] / BATCH_SIZE)}:${Math.floor(position[2] / BATCH_SIZE)}`;
    const part = { position, size, color, yaw, roll };
    const batch = this.batches.get(key);
    if (batch) batch.parts.push(part);
    else this.batches.set(key, { shape, parts: [part] });
  }

  mesh(): THREE.Group {
    const group = new THREE.Group();
    const solids = new THREE.MeshStandardMaterial({ roughness: 0.92 });
    const blades = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide });
    const transform = new THREE.Object3D();
    const color = new THREE.Color();
    const shapes = new Map<Shape, THREE.BufferGeometry>();

    for (const { shape, parts } of this.batches.values()) {
      let geometry = shapes.get(shape);
      if (!geometry) {
        geometry = partGeometry(shape);
        shapes.set(shape, geometry);
      }
      const mesh = new THREE.InstancedMesh(geometry, shape === 'tuft' ? blades : solids, parts.length);
      mesh.castShadow = shape !== 'tuft' && shape !== 'flower';
      mesh.receiveShadow = true;
      parts.forEach((part, index) => {
        transform.position.set(...part.position);
        transform.scale.set(...part.size);
        transform.rotation.set(0, part.yaw, part.roll);
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
        mesh.setColorAt(index, color.setHex(part.color));
      });
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    return group;
  }
}

export function createLandscape(map: GameMap): THREE.Group {
  const group = new THREE.Group();
  const scenery = new Scenery();
  const random = mulberry32(map.seed ^ 0xf132ac43);
  group.add(createGround(map));

  for (const obstacle of map.obstacles) {
    switch (obstacle.kind) {
      case 'tree': addTree(scenery, obstacle, random); break;
      case 'rock': addRock(scenery, obstacle, random); break;
      case 'wall': addWall(scenery, obstacle, random); break;
      case 'house': addHouse(scenery, obstacle, random); break;
      case 'fence': addFence(scenery, obstacle); break;
      case 'stall': addStall(scenery, obstacle, random); break;
    }
  }
  for (const bridge of map.bridges) addBridge(scenery, map, bridge, random);
  addPlants(scenery, map, random);
  addSigns(scenery, group, map);
  group.add(scenery.mesh());
  return group;
}

function createGround({ size, seed, terrain }: GameMap): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * TILE_PIXELS;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const random = mulberry32(seed ^ 0x1d8e4e27);
  const step = 8;
  const side = Math.ceil(size / step) + 1;
  const tones = Float32Array.from({ length: side * side }, () => (random() - 0.5) * 29);
  const colors = [...Object.values(GROUND), [142, 139, 119]].map(([r, g, b]) =>
    Array.from({ length: 49 }, (_, i) => `rgb(${r + i - 24}, ${g + i - 24}, ${b + i - 24})`));
  const plazaColors = colors[colors.length - 1];
  const center = size / 2;

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const surface = terrain[z * size + x];
      const i = Math.floor(z / step) * side + Math.floor(x / step);
      const u = (x % step) / step;
      const v = (z % step) / step;
      const top = THREE.MathUtils.lerp(tones[i], tones[i + 1], u);
      const bottom = THREE.MathUtils.lerp(tones[i + side], tones[i + side + 1], u);
      const tone = THREE.MathUtils.lerp(top, bottom, v) + (random() - 0.5) * 6;
      const px = x * TILE_PIXELS;
      const pz = z * TILE_PIXELS;
      const plaza = (surface === Terrain.Village || surface === Terrain.Road) &&
        Math.hypot(x + 0.5 - center, z + 0.5 - center) < 6.6;
      ctx.fillStyle = (plaza ? plazaColors : colors[surface])[Math.round(tone) + 24];
      ctx.fillRect(px, pz, TILE_PIXELS, TILE_PIXELS);

      const shift = random() < 0.5 ? 0 : 2;
      if (surface === Terrain.Stone || plaza) {
        ctx.fillStyle = '#38332342';
        ctx.fillRect(px, pz, TILE_PIXELS, 1);
        ctx.fillRect(px, pz + 4, TILE_PIXELS, 1);
        ctx.fillRect(px + 2, pz + 1, 1, 3);
        ctx.fillRect(px + 5, pz + 5, 1, 3);
        ctx.fillStyle = '#f1e2b741';
        ctx.fillRect(px + shift, pz + 2, 4, 1);
        ctx.fillRect(px + 1, pz + 5, 3, 1);
      } else if (surface === Terrain.Water) {
        ctx.fillStyle = '#aff4ef49';
        if (random() < 0.43) ctx.fillRect(px + shift, pz + Math.floor(random() * 7), 3 + shift, 1);
        if (terrain[z * size + x - 1] !== Terrain.Water) ctx.fillRect(px, pz, 1, TILE_PIXELS);
        if (terrain[z * size + x + 1] !== Terrain.Water) ctx.fillRect(px + 7, pz, 1, TILE_PIXELS);
      } else {
        ctx.fillStyle = random() < 0.5 ? '#f7e2a443' : '#423c2941';
        ctx.fillRect(px + Math.floor(random() * 6), pz + Math.floor(random() * 7), 2 + shift, 1);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(size / 2, 0, size / 2);
  ground.receiveShadow = true;
  return ground;
}

function partGeometry(shape: Shape): THREE.BufferGeometry {
  switch (shape) {
    case 'box': return new THREE.BoxGeometry(1, 1, 1);
    case 'trunk': return new THREE.CylinderGeometry(0.34, 0.5, 1, 6);
    case 'pine': return new THREE.ConeGeometry(0.5, 1, 8);
    case 'leaves': return new THREE.IcosahedronGeometry(0.5, 1);
    case 'rock': return new THREE.DodecahedronGeometry(0.5, 0);
    case 'flower': return new THREE.IcosahedronGeometry(0.5, 0);
    case 'roof': {
      const profile = new THREE.Shape();
      profile.moveTo(-0.5, -0.5);
      profile.lineTo(0.5, -0.5);
      profile.lineTo(0, 0.5);
      profile.closePath();
      return new THREE.ExtrudeGeometry(profile, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
    }
    case 'tuft': {
      const vertices = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const x = Math.cos(a);
        const z = Math.sin(a);
        vertices.push(x * 0.1 - z * 0.07, 0, z * 0.1 + x * 0.07, x * 0.12 + z * 0.07, 0, z * 0.12 - x * 0.07,
          x * 0.48, 0.58 + (i % 3) * 0.2, z * 0.48);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.computeVertexNormals();
      return geometry;
    }
  }
}

function addTree(s: Scenery, o: Obstacle, random: () => number): void {
  const x = o.x + 0.5;
  const z = o.z + 0.5;
  const h = o.h;
  const yaw = random() * Math.PI * 2;
  s.add('trunk', [x, h * 0.29, z], [0.5, h * 0.58, 0.5], 0x654b33, yaw);
  s.add('rock', [x, 0.17, z], [0.87, 0.37, 0.85], 0x534c37, yaw);
  if (random() < 0.7) {
    const shade = random() < 0.55 ? [0x2f523d, 0x3d694d, 0x547e54] : [0x3f6245, 0x50764c, 0x72905a];
    for (let i = 0; i < 3; i++) {
      const width = h * (0.58 - 0.14 * i);
      s.add('pine', [x, h * (0.46 + i * 0.17), z], [width, h * 0.43, width], shade[i], yaw + i * 0.25);
    }
  } else {
    const shade = random() < 0.75 ? [0x486640, 0x628244, 0x7b9855] : [0x776738, 0x99854b, 0xada05a];
    s.add('leaves', [x, h * 0.65, z], [h * 0.58, h * 0.61, h * 0.51], shade[0], yaw);
    s.add('leaves', [x + 0.45, h * 0.71, z + 0.61], [h * 0.47, h * 0.44, h * 0.5], shade[1], yaw + 0.6);
    s.add('leaves', [x - 0.36, h * 0.85, z - 0.25], [h * 0.42, h * 0.4, h * 0.4], shade[2], yaw + 0.18);
  }
}

function addRock(s: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const shade = random() < 0.5 ? 0x797969 : 0x687260;
  s.add('rock', [x + w * 0.5, h * 0.39, z + d * 0.48], [w * 0.94, h, d * 0.96], shade, (random() - 0.5) * 0.32);
  if (w > 1) s.add('rock', [x + w * 0.24, h * 0.16, z + d * 0.67], [w * 0.37, h * 0.44, d * 0.48], 0x86906c);
}

function addWall(s: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const alongX = w >= d;
  const length = alongX ? w : d;
  const width = (alongX ? d : w) - 0.16;
  const columns = Math.ceil(length / 1.18);
  const rows = Math.ceil(h / 0.57);
  const brick = length / columns;
  const rise = h / rows;
  const shades = [0x77786c, 0x88887a, 0x686f62, 0x969181];
  for (let row = 0; row < rows; row++) {
    const offset = row % 2 === 0 ? 0 : -brick * 0.42;
    for (let col = 0; col <= columns; col++) {
      const start = Math.max(0, col * brick + offset);
      const end = Math.min(length, (col + 1) * brick + offset);
      if (end - start < 0.13) continue;
      const u = (start + end) / 2;
      const y = (row + 0.5) * rise;
      const variation = (random() - 0.5) * 0.11;
      const shade = shades[Math.floor(random() * shades.length)];
      s.add('box', alongX ? [x + u, y, z + d / 2] : [x + w / 2, y, z + u],
        [end - start - 0.045, rise - 0.04 + variation, width + variation], shade, alongX ? 0 : Math.PI / 2);
    }
  }
  s.add('box', [x + w / 2, h * 0.09, z + d / 2], [w - 0.08, h * 0.18, d - 0.08], 0x696e58);
}

function addHouse(s: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const cx = x + w / 2;
  const cz = z + d / 2;
  const front = z + d - 0.1;
  const wood = 0x69482f;
  const roof = random() < 0.65 ? 0x885342 : 0x52645a;
  s.add('box', [cx, 0.22, cz], [w - 0.1, 0.44, d - 0.1], 0x7b7565);
  s.add('box', [cx, h / 2, cz], [w - 0.24, h - 0.12, d - 0.24], 0xd3b98c);
  s.add('roof', [cx, h + 0.57, cz], [w + 0.15, 1.66, d + 0.16], wood);
  s.add('roof', [cx, h + 0.7, cz], [w + 0.34, 1.7, d + 0.38], roof);
  s.add('box', [cx, h + 1.55, cz], [0.22, 0.13, d + 0.47], wood);
  s.add('box', [x + w * 0.74, h + 1.12, z + d * 0.28], [0.56, 1.45, 0.6], 0x81796c);
  s.add('box', [x + w * 0.74, h + 1.89, z + d * 0.28], [0.7, 0.19, 0.72], 0x6c665c);
  for (const post of [x + 0.2, cx - w * 0.25, cx + w * 0.25, x + w - 0.2]) {
    s.add('box', [post, h / 2, front], [0.17, h, 0.19], wood);
  }
  for (const y of [0.48, h * 0.72, h - 0.17]) s.add('box', [cx, y, front], [w - 0.12, 0.13, 0.15], wood);
  s.add('box', [cx, 0.91, front + 0.04], [1.08, 1.82, 0.12], 0x503b2d);
  s.add('box', [cx + 0.29, 0.94, front + 0.12], [0.10, 0.1, 0.07], 0xb89557);
  for (const window of [cx - w * 0.35, cx + w * 0.35]) {
    s.add('box', [window, h * 0.57, front + 0.05], [0.83, 0.7, 0.15], wood);
    s.add('box', [window, h * 0.57, front + 0.14], [0.64, 0.47, 0.03], 0xebc477);
    s.add('box', [window, h * 0.57, front + 0.16], [0.08, 0.56, 0.04], wood);
  }
  const right = x + w - 0.13;
  s.add('box', [right, h * 0.73, cz], [0.18, 0.12, d - 0.13], wood);
  for (const at of [z + 0.17, cz, z + d - 0.17]) s.add('box', [right, h / 2, at], [0.19, h, 0.18], wood);
}

function addFence(s: Scenery, { x, z, w, d, h }: Obstacle): void {
  const alongX = w > d;
  const length = alongX ? w : d;
  const yaw = alongX ? 0 : Math.PI / 2;
  const at = (u: number, y: number): Vec3 => alongX ? [x + u, y, z + d / 2] : [x + w / 2, y, z + u];
  const spans = Math.ceil(length / 1.45);
  for (let i = 0; i <= spans; i++) s.add('box', at(0.16 + (i / spans) * (length - 0.32), h / 2), [0.32, h, 0.34], 0x795b3b, yaw);
  for (const level of [0.35, 0.72]) s.add('box', at(length / 2, h * level), [length - 0.12, 0.13, 0.27], 0x95734d, yaw);
}

function addStall(s: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const cx = x + w / 2;
  const cz = z + d / 2;
  const cloth = random() < 0.5 ? 0x88493c : 0x4d776c;
  for (const px of [x + 0.18, x + w - 0.18]) {
    for (const pz of [z + 0.18, z + d - 0.18]) s.add('box', [px, h / 2, pz], [0.18, h, 0.18], 0x614832);
  }
  s.add('box', [cx, 0.52, cz], [w - 0.48, 0.91, d - 0.4], 0x835c3d);
  s.add('box', [cx, 1, cz], [w - 0.25, 0.15, d - 0.25], 0xb48b55);
  const stripe = w / 7;
  for (let i = 0; i < 7; i++) {
    const px = x + stripe * (i + 0.5);
    const shade = i % 2 ? 0xd9c7a1 : cloth;
    s.add('box', [px, h, cz], [stripe, 0.13, d], shade);
    s.add('box', [px, h - 0.14, z + d - 0.05], [stripe, 0.22, 0.12], shade);
  }
  for (const u of [-1, 1]) s.add('box', [cx + u * w * 0.22, 1.25, cz], [0.59, 0.41, 0.56], 0x96774e);
}

function addBridge(s: Scenery, map: GameMap, { x, z, w, d }: Bridge, random: () => number): void {
  const boards = Math.ceil(w / 0.34);
  const plank = w / boards;
  const shades = [0x997247, 0xa78255, 0x85613e, 0xb09262];
  // 桥面略高于地表，仍在点击标记和选中圆环下方。
  for (let i = 0; i < boards; i++) {
    s.add('box', [x + (i + 0.5) * plank, -0.025, z + d / 2],
      [plank - 0.017, 0.12, d], shades[Math.floor(random() * shades.length)]);
  }
  for (const row of [z - 1, z + d]) {
    // 栏杆只排在实际临水的桥边。干地上的两端从侧面也能走上来。
    let left = x;
    while (left < x + w && map.terrain[row * map.size + left] !== Terrain.Water) left++;
    let right = left;
    while (right < x + w && map.terrain[row * map.size + right] === Terrain.Water) right++;
    if (right === left) continue;
    const edge = row === z - 1 ? z - 0.13 : z + d + 0.13;
    const length = right - left;
    const spans = Math.ceil(length / 1.55);
    for (let i = 0; i <= spans; i++) {
      const px = left + 0.15 + (i / spans) * (length - 0.3);
      s.add('box', [px, 0.5, edge], [0.22, 1, 0.16], 0x705035);
      s.add('box', [px, 1.01, edge], [0.29, 0.14, 0.21], 0x936e43);
    }
    for (const y of [0.35, 0.77]) s.add('box', [(left + right) / 2, y, edge], [length, 0.12, 0.15], 0x785536);
  }
}

function addPlants(s: Scenery, { size, terrain, blocked }: GameMap, random: () => number): void {
  for (let i = 0; i < size * 20; i++) {
    const x = random() * size;
    const z = random() * size;
    const index = Math.floor(z) * size + Math.floor(x);
    if (blocked[index]) continue;
    const surface = terrain[index];
    const meadow = surface === Terrain.Meadow;
    const bank = surface === Terrain.Bank;
    const villageEdge = surface === Terrain.Village && Math.hypot(x - size / 2, z - size / 2) > 11;
    if (!meadow && !bank && !villageEdge && surface !== Terrain.Grass && surface !== Terrain.Forest) continue;
    if (bank && random() < 0.47) continue;
    const height = (bank ? 0.64 : meadow ? 0.4 : 0.31) * (0.69 + random() * 0.63);
    const shade = bank ? 0x777d48 : (random() < 0.5 ? 0x8c9851 : 0x5e773f);
    s.add('tuft', [x, 0, z], [0.47, height, 0.47], shade, random() * 6.28);
    if ((meadow || villageEdge) && random() < 0.33) {
      const flower = random() < 0.65 ? 0xdfbd58 : 0xd4c2bb;
      s.add('flower', [x + 0.06, height * 0.8, z], [0.13, 0.08, 0.14], flower);
    }
  }
}

function addSigns(s: Scenery, group: THREE.Group, map: GameMap): void {
  const post = ({ x, z }: Point, name: string, width: number) => {
    s.add('box', [x, 0.87, z], [0.15, 1.74, 0.16], 0x62452d);
    s.add('box', [x, 1.48, z], [width, 0.38, 0.14], 0x916a44);
    const element = document.createElement('div');
    element.className = 'landmark-sign';
    element.textContent = name;
    const label = new CSS2DObject(element);
    label.position.set(x, 1.98, z);
    group.add(label);
  };
  for (const site of map.landmarks) {
    const dx = site.kind === 'village' ? -4.7 : -2.2;
    post({ x: site.x + dx, z: site.z - 2.9 }, site.name, 1.55);
  }

  const village = map.landmarks.find((site) => site.kind === 'village');
  if (!village) return;
  const exits = {
    forest: [-12.6, -5.5],
    meadow: [-0.6, 12.1],
    ruins: [12.2, 3.1],
  } as const;
  for (const site of map.landmarks) {
    if (site.kind === 'village') continue;
    const [dx, dz] = exits[site.kind];
    post({ x: village.x + dx, z: village.z + dz }, `往${site.name}`, 1.8);
  }
}
