import { merchantPosition, SAFE_ZONE_RADIUS, Terrain } from '@mmo/shared';
import type { GameMap, Obstacle, Point } from '@mmo/shared';
import { uiText } from './ui';

const RADIUS = 32;
const SIDE = 256;
const TERRAIN_SCALE = 3;
const UPDATE_MS = 100;
const TERRAIN_COLORS: Record<Terrain, string> = {
  [Terrain.Grass]: '#596744',
  [Terrain.Forest]: '#3d5641',
  [Terrain.Meadow]: '#7f874e',
  [Terrain.Village]: '#857753',
  [Terrain.Stone]: '#77796b',
  [Terrain.Bank]: '#a19260',
  [Terrain.Water]: '#386f80',
  [Terrain.Road]: '#b39563',
  [Terrain.Bridge]: '#d1ab6d',
};
const OBSTACLE_COLORS: Record<Obstacle['kind'], string> = {
  tree: '#263c2d', rock: '#8a8a75', wall: '#bbb5a2', house: '#b28161', fence: '#554332', stall: '#a87353',
};

/** 地图标记留一点边距，避免标记的一半被圆框裁掉。 */
export function minimapMarker(x: number, z: number, point: Point): Point | null {
  const dx = point.x - x;
  const dz = point.z - z;
  return Math.hypot(dx, dz) <= RADIUS - 3 ? { x: dx / RADIUS, z: dz / RADIUS } : null;
}

/** 正北朝上的局部地形图，底图只在进入世界时生成一次。 */
export class Minimap {
  readonly element = document.createElement('section');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d');
  private terrain: HTMLCanvasElement | null = null;
  private merchant: Point = { x: 0, z: 0 };
  private lastPaint = -Infinity;
  private lastX = -Infinity;
  private lastZ = -Infinity;
  private lastYaw = -Infinity;

  constructor() {
    this.element.className = 'minimap';
    this.element.setAttribute('aria-label', '附近地形，青色圆环是安全区，金色标记是商人，浅色圆点是地标');
    this.canvas.width = SIDE;
    this.canvas.height = SIDE;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.element.append(this.canvas, uiText('minimap-north', '北'));
  }

  setMap(map: GameMap): void {
    this.terrain = terrainImage(map);
    this.merchant = merchantPosition(map.size);
    this.lastPaint = this.lastX = this.lastZ = this.lastYaw = -Infinity;
  }

  update(now: number, x: number, z: number, yaw: number): void {
    const { ctx, terrain } = this;
    if (!ctx || !terrain || now - this.lastPaint < UPDATE_MS) return;
    if (x === this.lastX && z === this.lastZ && yaw === this.lastYaw) return;
    this.lastPaint = now;
    this.lastX = x;
    this.lastZ = z;
    this.lastYaw = yaw;

    const half = SIDE / 2;
    const scale = half / RADIUS;
    const side = (terrain.width / TERRAIN_SCALE) * scale;
    ctx.fillStyle = '#182520';
    ctx.fillRect(0, 0, SIDE, SIDE);
    ctx.drawImage(terrain, half - x * scale, half - z * scale, side, side);

    const marker = minimapMarker(x, z, this.merchant);
    if (marker) {
      ctx.save();
      ctx.translate(half + marker.x * half, half + marker.z * half);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#f5c96d';
      ctx.strokeStyle = '#271a0a';
      ctx.lineWidth = 2;
      ctx.fillRect(-5, -5, 10, 10);
      ctx.strokeRect(-5, -5, 10, 10);
      ctx.restore();
    }

    // 人物模型朝 +Z，正北地图上 +Z 指向下方。
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(Math.PI - yaw);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 5);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fillStyle = '#fff2b4';
    ctx.strokeStyle = '#2b2617';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
}

function terrainImage(map: GameMap): HTMLCanvasElement | null {
  const terrain = document.createElement('canvas');
  terrain.width = terrain.height = map.size * TERRAIN_SCALE;
  const ctx = terrain.getContext('2d');
  if (!ctx) return null;
  ctx.scale(TERRAIN_SCALE, TERRAIN_SCALE);
  for (let z = 0; z < map.size; z++) {
    // 相邻的同色格子可以一次画完，保留桥和河岸的轮廓。
    for (let x = 0; x < map.size;) {
      const surface = map.terrain[z * map.size + x] as Terrain;
      let end = x + 1;
      while (end < map.size && map.terrain[z * map.size + end] === surface) end++;
      ctx.fillStyle = TERRAIN_COLORS[surface];
      ctx.fillRect(x, z, end - x, 1);
      x = end;
    }
  }

  for (const o of map.obstacles) {
    ctx.fillStyle = OBSTACLE_COLORS[o.kind];
    ctx.fillRect(o.x, o.z, o.w, o.d);
  }

  ctx.beginPath();
  ctx.arc(map.size / 2, map.size / 2, SAFE_ZONE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = '#62cfa32c';
  ctx.strokeStyle = '#9cdac69e';
  ctx.lineWidth = 0.55;
  ctx.fill();
  ctx.stroke();
  for (const landmark of map.landmarks) {
    ctx.beginPath();
    ctx.arc(landmark.x, landmark.z, 1.12, 0, Math.PI * 2);
    ctx.fillStyle = '#eddbb2';
    ctx.strokeStyle = '#3a3024';
    ctx.lineWidth = 0.45;
    ctx.fill();
    ctx.stroke();
  }
  return terrain;
}
