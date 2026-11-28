import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mulberry32, Terrain } from '@mmo/shared';
import type { Bridge, GameMap, Obstacle, Point } from '@mmo/shared';
import { Scenery } from './scenery';
import { createTerrain } from './terrain';
import type { LandscapeTextures } from './terrain';

const FULL_TURN = Math.PI * 2;
const FINE = { detail: true } as const;
const OAK = 0xead3b3;
const DARK_OAK = 0xb8a18b;
const GRASS = [0x789448, 0x9eaa53, 0x6d8b4a, 0xa3a75c];
const REEDS = [0x829656, 0x969c65, 0x778d54];
const PETALS = [0xf3d972, 0xe9dec3, 0xc2a5cd, 0xebc77b];

function pick<T>(palette: readonly T[], random: () => number): T {
  return palette[Math.floor(random() * palette.length)];
}

export function createLandscape(map: GameMap, textures: LandscapeTextures) {
  const group = new THREE.Group();
  const scenery = new Scenery();
  const surface = createTerrain(map, textures);
  group.add(surface.ground, surface.river, scenery.group);

  const random = mulberry32(map.seed ^ 0xf132ac43);
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
  addPlants(scenery, map, mulberry32(map.seed ^ 0x78a27b51));
  const village = map.landmarks.find((site) => site.kind === 'village');
  if (village) addPlazaRim(scenery, village, random);
  addSigns(scenery, group, map);
  scenery.build(textures.wood, textures.dirt);

  return {
    group,
    update(camera: THREE.Camera, seconds: number) {
      surface.time.value = seconds;
      scenery.update(camera);
    },
    reduceDetail() {
      surface.detail.value = 0;
      scenery.reduceDetail();
    },
  };
}

function addTree(scenery: Scenery, obstacle: Obstacle, random: () => number): void {
  const x = obstacle.x + 0.5;
  const z = obstacle.z + 0.5;
  const height = obstacle.h;
  const yaw = random() * FULL_TURN;
  const pine = random() < 0.72;
  scenery.add('contact', [x, 0.012, z], [1.75, 1, 1.46], 0xffffff);
  scenery.add('trunk', [x, height * 0.30, z], [0.53, height * 0.6, 0.48], DARK_OAK, { yaw });
  for (let i = 0; i < 3; i++) {
    const angle = yaw + i * 2.1;
    scenery.add('trunk', [x + Math.cos(angle) * 0.19, 0.12, z + Math.sin(angle) * 0.19],
      [0.22, 0.56, 0.24], OAK, { yaw: -angle, roll: 1.29, detail: true });
  }
  if (pine) {
    const palette = random() < 0.55 ? [0x385a42, 0x426b4c, 0x567d54, 0x71935d] : [0x4e6640, 0x5b7948, 0x698851, 0x87a166];
    const layers = height > 5.2 ? 4 : 3;
    for (let layer = 0; layer < layers; layer++) {
      const upper = layer / (layers - 1);
      const width = height * (0.59 - 0.35 * upper) * (0.89 + random() * 0.19);
      const drift = Math.sin(yaw + layer) * 0.17;
      scenery.add('pine', [x + drift, height * (0.43 + upper * 0.37), z - drift * 0.5],
        [width, height * (0.38 - upper * 0.04), width * 0.96], palette[layer], { yaw: yaw + layer * 0.63 });
    }
  } else {
    const palette = random() < 0.73 ? [0x597545, 0x75954e, 0x9cae65] : [0x7a7546, 0xa69353, 0xc5aa64];
    for (let branch = 0; branch < 4; branch++) {
      const angle = yaw + branch * 2.39996;
      const dx = 0.55 * Math.cos(angle);
      const dz = 0.55 * Math.sin(angle);
      scenery.add('leaves', [x + dx, height * (0.62 + 0.055 * branch), z + dz],
        [height * (0.52 - 0.036 * branch), height * 0.46, height * 0.49], palette[branch % palette.length], { yaw: angle });
    }
    scenery.add('leaves', [x - 0.21, height * 0.92, z + 0.12], [height * 0.36, height * 0.33, height * 0.38], palette[2], { yaw });
  }
}

function addRock(scenery: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const cx = x + w * 0.5;
  const cz = z + d * 0.5;
  scenery.add('contact', [cx, 0.012, cz], [w * 1.45, 1, d * 1.36], 0xffffff);
  scenery.add('rock', [cx, h * 0.34, cz], [w * 0.97, h, d * 0.97],
    pick([0x8b8f7c, 0x707e77, 0x939284], random), { yaw: (random() - 0.5) * 0.3, roll: -0.07 });
  scenery.add('rock', [x + w * 0.27, h * 0.13, z + d * 0.68], [w * 0.41, h * 0.48, d * 0.46], 0x899179);
  if (h > 1.0) {
    scenery.add('rock', [cx - w * 0.12, h * 0.75, cz + d * 0.11],
      [w * 0.40, h * 0.17, d * 0.39], 0x788453, FINE);
  }
}

function addWall(scenery: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const alongX = w >= d;
  const length = alongX ? w : d;
  const width = (alongX ? d : w) - 0.16;
  const columns = Math.ceil(length / 1.12);
  const rows = Math.ceil(h / 0.53);
  const brick = length / columns;
  const rise = h / rows;
  const at = (u: number, y: number, side = 0): [number, number, number] => alongX
    ? [x + u, y, z + d / 2 + side] : [x + w / 2 + side, y, z + u];
  const yaw = alongX ? 0 : Math.PI / 2;
  scenery.add('contact', [x + w / 2, 0.012, z + d / 2], [w + 0.94, 1, d + 0.88], 0xffffff);
  scenery.add('stone', [x + w / 2, 0.14, z + d / 2], [w - 0.06, 0.28, d - 0.06], 0x747e69);
  for (let row = 0; row < rows; row++) {
    const offset = row % 2 ? -brick * 0.43 : 0;
    for (let col = 0; col <= columns; col++) {
      const start = Math.max(0, col * brick + offset);
      const end = Math.min(length, (col + 1) * brick + offset);
      if (end - start < 0.12 || (row === rows - 1 && columns >= 3 && random() < 0.22)) continue;
      const u = (start + end) / 2;
      const worn = (random() - 0.5) * 0.12;
      const shade = pick([0x7c8277, 0x95948a, 0x798075, 0xa2a091, 0x8c927f], random);
      scenery.add('stone', at(u, (row + 0.5) * rise + worn * 0.45),
        [end - start - 0.032, rise - 0.03 + worn, width + worn], shade, { yaw, roll: worn * 0.29 });
    }
  }
  for (let i = 0; i < columns + 2; i++) {
    const edge = (i % 2 ? 1 : -1) * (width / 2 + random() * 0.33);
    const grain = 0.13 + random() * 0.22;
    scenery.add('rock', at(random() * length, grain * 0.25, edge), [grain * 1.3, grain * 0.54, grain],
      pick([0xa09e8a, 0x849080, 0x858674], random), { yaw: random() * FULL_TURN, detail: true });
  }
}

function addHouse(scenery: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const cx = x + w / 2;
  const cz = z + d / 2;
  const front = z + d - 0.1;
  const right = x + w - 0.1;
  const tiles = random() < 0.68 ? [0x97574d, 0xad6453, 0xb4795f, 0x9c6558] : [0x5f7771, 0x718982, 0x667a72, 0x7e8b81];
  scenery.add('contact', [cx, 0.012, cz], [w + 1.65, 1, d + 1.5], 0xffffff);
  scenery.add('stone', [cx, 0.21, cz], [w - 0.08, 0.42, d - 0.08], 0x8c897d);
  scenery.add('box', [cx, h / 2, cz], [w - 0.24, h - 0.10, d - 0.24], 0xd6b78c);
  scenery.add('roof', [cx, h + 0.66, cz], [w + 0.38, 1.72, d + 0.39], tiles[0]);
  scenery.add('wood', [cx, h + 1.54, cz], [0.18, 0.16, d + 0.54], DARK_OAK);
  for (const side of [-1, 1]) {
    const halfSpan = (w + 0.38) / 2;
    const pitch = Math.atan2(1.72, halfSpan);
    const rowLength = Math.hypot(halfSpan, 1.72) / 5;
    const count = Math.ceil((d + 0.36) / 0.52);
    const spacing = (d + 0.36) / count;
    scenery.add('wood', [cx + side * halfSpan, h - 0.17, cz], [0.17, 0.20, d + 0.45], DARK_OAK);
    for (let row = 0; row < 5; row++) {
      const progress = (row + 0.49) / 5;
      const px = cx + side * halfSpan * progress;
      const py = h + 1.55 - 1.72 * progress;
      const stagger = row % 2 ? -spacing * 0.46 : 0;
      for (let col = 0; col <= count; col++) {
        const a = Math.max(0, spacing * col + stagger);
        const b = Math.min(d + 0.36, spacing * (col + 1) + stagger);
        if (b - a < 0.1) continue;
        scenery.add('box', [px, py + (random() - 0.5) * 0.027, z - 0.18 + (a + b) / 2],
          [rowLength * 1.03, 0.079, b - a - 0.022], pick(tiles, random), { roll: -side * pitch, detail: true });
      }
    }
  }
  const chimneyX = x + w * 0.74;
  const chimneyZ = z + d * 0.27;
  scenery.add('stone', [chimneyX, h + 1.14, chimneyZ], [0.57, 1.48, 0.60], 0x888677);
  scenery.add('stone', [chimneyX, h + 1.9, chimneyZ], [0.73, 0.19, 0.73], 0x676b62);
  for (const y of [h + 1.17, h + 1.50, h + 1.8]) {
    scenery.add('box', [chimneyX, y, chimneyZ], [0.59, 0.023, 0.62], 0x78766a, FINE);
  }

  for (const upright of [x + 0.17, cx - w * 0.22, cx + w * 0.22, x + w - 0.17]) {
    scenery.add('wood', [upright, h / 2, front], [0.18, h, 0.20], DARK_OAK);
  }
  for (const y of [0.46, h * 0.73, h - 0.20]) {
    scenery.add('wood', [cx, y, front], [w - 0.15, 0.14, 0.18], DARK_OAK);
  }
  const doorZ = front + 0.09;
  scenery.add('wood', [cx, 0.95, doorZ], [1.13, 1.90, 0.16], DARK_OAK);
  for (let plank = -1; plank <= 1; plank++) {
    scenery.add('wood', [cx + 0.31 * plank, 0.94, doorZ + 0.08], [0.296, 1.74, 0.06], OAK, FINE);
  }
  for (const y of [0.38, 1.47]) scenery.add('box', [cx, y, doorZ + 0.12], [0.87, 0.073, 0.055], 0x544f46, FINE);
  scenery.add('box', [cx + 0.37, 0.9, doorZ + 0.14], [0.08, 0.13, 0.07], 0xc9a666, FINE);
  for (const windowX of [cx - w * 0.35, cx + w * 0.35]) addWindow(scenery, windowX, h * 0.56, front + 0.08, 0);
  addWindow(scenery, right + 0.08, h * 0.56, cz, Math.PI / 2);
  for (const y of [0.46, h * 0.73, h - 0.20]) scenery.add('wood', [right, y, cz], [0.17, 0.14, d - 0.12], DARK_OAK);
  for (const at of [z + 0.17, cz + 0.7, z + d - 0.17]) {
    scenery.add('wood', [right, h / 2, at], [0.19, h, 0.18], DARK_OAK);
  }
}

function addWindow(scenery: Scenery, x: number, y: number, z: number, yaw: number): void {
  const at = (side: number, up: number, out: number): [number, number, number] =>
    [x + side * Math.cos(yaw) + out * Math.sin(yaw), y + up, z - side * Math.sin(yaw) + out * Math.cos(yaw)];
  scenery.add('wood', at(0, 0, 0), [0.95, 0.79, 0.17], DARK_OAK, { yaw });
  scenery.add('box', at(0, 0, 0.10), [0.70, 0.53, 0.052], 0xe6b878, { yaw });
  scenery.add('stone', at(0, -0.36, 0.10), [1.1, 0.13, 0.31], 0x9c9281, { yaw });
  scenery.add('wood', at(0, 0, 0.14), [0.082, 0.56, 0.056], DARK_OAK, { yaw, detail: true });
  scenery.add('wood', at(0, 0, 0.14), [0.73, 0.07, 0.056], DARK_OAK, { yaw, detail: true });
  for (const side of [-0.63, 0.63]) {
    scenery.add('wood', at(side, 0.01, 0.04), [0.29, 0.68, 0.10], 0xd5d3b4, { yaw, detail: true });
  }
}

function addFence(scenery: Scenery, { x, z, w, d, h }: Obstacle): void {
  const alongX = w > d;
  const length = alongX ? w : d;
  const yaw = alongX ? 0 : Math.PI / 2;
  const at = (u: number, y: number): [number, number, number] => alongX ? [x + u, y, z + d / 2] : [x + w / 2, y, z + u];
  const spans = Math.ceil(length / 1.42);
  for (let i = 0; i <= spans; i++) {
    const offset = 0.19 + (i / spans) * (length - 0.38);
    scenery.add('wood', at(offset, h / 2), [0.29, h, 0.34], DARK_OAK, { yaw });
    scenery.add('wood', at(offset, h - 0.025), [0.37, 0.13, 0.40], OAK, { yaw, roll: 0.07, detail: true });
  }
  for (const level of [0.31, 0.72]) scenery.add('wood', at(length / 2, h * level), [length - 0.12, 0.14, 0.23], OAK, { yaw });
}

function addStall(scenery: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const cx = x + w / 2;
  const cz = z + d / 2;
  const cloth = random() < 0.5 ? 0xa0564a : 0x4e8180;
  scenery.add('contact', [cx, 0.012, cz], [w + 0.86, 1, d + 0.75], 0xffffff);
  for (const px of [x + 0.17, x + w - 0.17]) {
    for (const pz of [z + 0.18, z + d - 0.18]) {
      scenery.add('wood', [px, h / 2, pz], [0.19, h, 0.18], DARK_OAK);
      scenery.add('stone', [px, 0.12, pz], [0.32, 0.24, 0.30], 0x93927d);
    }
  }
  scenery.add('wood', [cx, 0.48, cz], [w - 0.48, 0.90, d - 0.48], DARK_OAK);
  scenery.add('wood', [cx, 0.99, cz], [w - 0.18, 0.15, d - 0.22], OAK);
  const stripe = w / 7;
  for (let i = 0; i < 7; i++) {
    const px = x + stripe * (i + 0.5);
    const shade = i % 2 ? 0xd5c0a0 : cloth;
    scenery.add('box', [px, h, cz], [stripe + 0.003, 0.095, d], shade, { pitch: 0.088 });
    scenery.add('box', [px, h - d * 0.045 - 0.15, z + d - 0.06], [stripe - 0.024, 0.23, 0.11], shade);
    scenery.add('box', [px, h - d * 0.045 - 0.24, z + d - 0.008], [stripe - 0.08, 0.052, 0.022], 0xd0ab71, FINE);
  }
  for (const side of [-1, 1]) {
    const px = cx + side * w * 0.23;
    scenery.add('wood', [px, 1.23, cz - 0.19], [0.63, 0.38, 0.58], OAK, { yaw: side * 0.08 });
    scenery.add('wood', [px, 1.22, cz + 0.105], [0.61, 0.12, 0.07], DARK_OAK, { roll: -side * 0.35, detail: true });
    for (const fruit of [-0.17, 0.0, 0.16]) {
      scenery.add('rock', [px + fruit, 1.47, cz - 0.09 + random() * 0.17], [0.16, 0.14, 0.17],
        pick([0xbb6851, 0xd49a56, 0x858e48], random), FINE);
    }
  }
}

function addBridge(scenery: Scenery, map: GameMap, { x, z, w, d }: Bridge, random: () => number): void {
  const boards = Math.ceil(w / 0.35);
  const spacing = w / boards;
  const shades = [0xe0c4a7, 0xeed5b6, 0xc9b8a4, 0xf1dcbd, 0xd4b896];
  // 桥面顶端低于移动标记。临水一侧的栏杆留在可行走格子外。
  for (let board = 0; board < boards; board++) {
    const px = x + (board + 0.5) * spacing;
    const endcap = board === 0 || board === boards - 1;
    scenery.add('wood', [px, -0.033, z + d / 2], [spacing - 0.019, 0.13, d], endcap ? DARK_OAK : pick(shades, random));
    if (board % 2 === 0) {
      for (const edge of [z + 0.27, z + d - 0.27]) {
        scenery.add('box', [px, 0.035, edge], [0.043, 0.008, 0.048], 0x544d44, FINE);
      }
    }
  }
  for (const row of [z - 1, z + d]) {
    let left = x;
    while (left < x + w && map.terrain[row * map.size + left] !== Terrain.Water) left++;
    let right = left;
    while (right < x + w && map.terrain[row * map.size + right] === Terrain.Water) right++;
    if (right === left) continue;
    const edge = row === z - 1 ? z - 0.15 : z + d + 0.15;
    const length = right - left;
    const spans = Math.ceil(length / 1.52);
    scenery.add('wood', [(left + right) / 2, -0.014, edge], [length, 0.15, 0.24], DARK_OAK);
    for (let i = 0; i <= spans; i++) {
      const px = left + 0.17 + (i / spans) * (length - 0.34);
      scenery.add('trunk', [px, 0.35, edge], [0.27, 1.30, 0.26], OAK);
      scenery.add('wood', [px, 1.02, edge], [0.32, 0.13, 0.24], OAK, { roll: 0.045 });
      scenery.add('box', [px, 0.15, edge], [0.29, 0.07, 0.24], 0x605e50, FINE);
    }
    for (const y of [0.38, 0.78]) scenery.add('wood', [(left + right) / 2, y, edge], [length, 0.105, 0.19], OAK);
  }
}

function addPlants(scenery: Scenery, { size, terrain, blocked, landmarks }: GameMap, random: () => number): void {
  const at = (x: number, z: number) => Math.floor(z) * size + Math.floor(x);
  for (let i = 0; i < size * 19; i++) {
    const x = random() * size;
    const z = random() * size;
    const index = at(x, z);
    if (blocked[index]) continue;
    const surface = terrain[index];
    const reeds = surface === Terrain.Bank;
    const villageEdge = surface === Terrain.Village && Math.hypot(x - size / 2, z - size / 2) > 9.8;
    if (!reeds && !villageEdge && surface !== Terrain.Grass && surface !== Terrain.Meadow && surface !== Terrain.Forest) continue;
    const fern = surface === Terrain.Forest && random() < 0.24;
    const height = (reeds ? 0.47 : fern ? 0.42 : 0.30) * (0.72 + random() * 0.65);
    scenery.add(fern ? 'fern' : 'grass', [x, 0, z], [fern ? 0.95 : 0.6, height, fern ? 0.95 : 0.6],
      pick(reeds ? REEDS : GRASS, random), { yaw: random() * FULL_TURN, detail: fern });
  }

  const meadow = landmarks.find(({ kind }) => kind === 'meadow');
  if (!meadow) return;
  for (let patch = 0; patch < 135; patch++) {
    const x = meadow.x + (random() - 0.5) * 95;
    const z = meadow.z + (random() - 0.5) * 68;
    const petals = pick(PETALS, random);
    if (terrain[at(x, z)] !== Terrain.Meadow) continue;
    for (let tuft = 0; tuft < 7 + (patch % 8); tuft++) {
      const px = x + (random() - 0.5) * 3.6;
      const pz = z + (random() - 0.5) * 2.7;
      const index = at(px, pz);
      if (terrain[index] !== Terrain.Meadow || blocked[index]) continue;
      const h = 0.21 + random() * 0.33;
      scenery.add('grass', [px, 0, pz], [0.82, h, 0.82], pick(GRASS, random), { yaw: random() * FULL_TURN });
      if (random() < 0.71) {
        const width = 0.14 + random() * 0.09;
        scenery.add('bloom', [px + 0.06, h * 0.81, pz + 0.02], [width, 0.21, width], petals,
          { yaw: random() * FULL_TURN, detail: tuft % 3 === 0 });
      }
    }
  }
}

function addPlazaRim(scenery: Scenery, { x, z }: Point, random: () => number): void {
  for (let i = 0; i < 54; i++) {
    const angle = (i / 54) * FULL_TURN;
    const radius = 6.21 + (random() - 0.5) * 0.038;
    scenery.add('stone', [x + Math.cos(angle) * radius, 0.003, z + Math.sin(angle) * radius], [0.27, 0.031, 0.69],
      pick([0xaaa68f, 0xb6ad95, 0xa39d83], random), { yaw: -angle, detail: true });
  }
}

function addSigns(scenery: Scenery, group: THREE.Group, map: GameMap): void {
  const post = ({ x, z }: Point, name: string, width: number) => {
    scenery.add('wood', [x, 0.88, z], [0.15, 1.76, 0.16], OAK);
    scenery.add('wood', [x, 1.48, z], [width, 0.38, 0.14], OAK);
    scenery.add('wood', [x, 1.67, z - 0.01], [width + 0.042, 0.082, 0.19], DARK_OAK);
    for (const nail of [-0.39, 0.39]) scenery.add('box', [x + nail * width, 1.50, z + 0.076], [0.062, 0.064, 0.021], 0x635d51, FINE);
    const element = document.createElement('div');
    element.className = 'landmark-sign';
    element.textContent = name;
    const label = new CSS2DObject(element);
    label.position.set(x, 1.98, z);
    group.add(label);
  };
  const village = map.landmarks.find((site) => site.kind === 'village');
  if (!village) return;
  const exits = { forest: [-12.6, -5.5], meadow: [-0.6, 12.1], ruins: [12.2, 3.1] } as const;
  for (const site of map.landmarks) {
    const dx = site.kind === 'village' ? -4.7 : -2.2;
    post({ x: site.x + dx, z: site.z - 2.9 }, site.name, 1.55);
    if (site.kind === 'village') continue;
    const [x, z] = exits[site.kind];
    post({ x: village.x + x, z: village.z + z }, `往${site.name}`, 1.8);
  }
}
