import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function barkTrunk(low: boolean): THREE.BufferGeometry {
  if (low) return new THREE.CylinderGeometry(0.24, 0.51, 1, 6);
  const trunk = new THREE.LatheGeometry([
    new THREE.Vector2(0, -0.5), new THREE.Vector2(0.53, -0.5), new THREE.Vector2(0.43, -0.38),
    new THREE.Vector2(0.32, -0.03), new THREE.Vector2(0.23, 0.5), new THREE.Vector2(0, 0.5),
  ], 8);
  const points = trunk.getAttribute('position');
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i);
    const y = points.getY(i);
    const z = points.getZ(i);
    const bend = Math.sin((y + 0.5) * 2.2) * 0.082;
    points.setXYZ(i, x + bend, y, z + bend * 0.4);
  }
  return trunk;
}

export function pineBough(low: boolean): THREE.BufferGeometry {
  const profile = low ? [[0, -0.43], [0.48, -0.42], [0.39, -0.18], [0.24, 0.11], [0, 0.5]]
    : [[0, -0.43], [0.29, -0.46], [0.48, -0.42], [0.42, -0.25], [0.27, 0.08], [0.105, 0.35], [0, 0.5]];
  const needles = new THREE.LatheGeometry(profile.map(([radius, y]) => new THREE.Vector2(radius, y)), low ? 7 : 16);
  const points = needles.getAttribute('position');
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i);
    const y = points.getY(i);
    const z = points.getZ(i);
    const angle = Math.atan2(x, z);
    const taper = Math.hypot(x, z);
    const fray = Math.cos(angle * 6) * 0.078 + Math.sin(angle * 3 + 0.7) * 0.072;
    const droop = taper * (Math.cos(angle * 7 + 0.75) * 0.086 + Math.sin(angle * 3) * 0.12);
    points.setXYZ(i, x * (1 + fray) + (y + 0.43) * 0.06, y + droop, z * (1 + fray));
  }
  if (low) return paintCrown(needles, 0.69);
  const whorl = needles.toNonIndexed();
  needles.dispose();
  return mergePainted(whorl, leafSprays(10, true));
}

export function broadleafCrown(low: boolean): THREE.BufferGeometry {
  const crown = new THREE.IcosahedronGeometry(0.49, low ? 0 : 1);
  const points = crown.getAttribute('position');
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i);
    const y = points.getY(i);
    const z = points.getZ(i);
    const shape = 1 + Math.sin(x * 15 + y * 7) * Math.cos(z * 12 - y * 5) * 0.14;
    points.setXYZ(i, x * shape + y * 0.13, y * shape, z * shape);
  }
  return low ? paintCrown(crown, 0.75) : mergePainted(crown, leafSprays(13, false));
}

/** 外沿的叶簇直接进树冠几何，增加轮廓细节而不增加绘制调用。 */
function leafSprays(count: number, needles: boolean): THREE.BufferGeometry {
  const positions: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = i * 2.39996;
    const x = Math.cos(a);
    const z = Math.sin(a);
    const height = needles ? -0.24 - (i % 4) * 0.052 : -0.23 + (i % 6) * 0.105;
    const start = needles ? 0.32 + (i % 4) * 0.031 : 0.37 - height ** 2 * 0.7;
    const end = start + (needles ? 0.102 + (i % 3) * 0.028 : 0.126);
    const mid = (start + end) * 0.5;
    const width = (needles ? 0.065 : 0.10) + Math.sin(i * 1.9) * 0.026;
    const down = needles ? -0.075 - (i % 3) * 0.034 : 0.035 * Math.sin(i * 4.4);
    const left = [x * mid - z * width, height + 0.018, z * mid + x * width];
    const right = [x * mid + z * width, height - 0.018, z * mid - x * width];
    const base = [x * start, height, z * start];
    const spine = [x * mid, height + 0.054, z * mid];
    const tip = [x * end, height + down, z * end];
    positions.push(...base, ...left, ...spine, ...left, ...tip, ...spine,
      ...base, ...spine, ...right, ...spine, ...tip, ...right);
    const u = ((i * 0.618) % 1) * 0.78;
    const v = ((i * 0.231) % 1) * 0.78;
    const centre = [u + 0.104, v + 0.087];
    uv.push(u, v, u + 0.11, v + 0.18, ...centre, u + 0.11, v + 0.18, u + 0.2, v + 0.08, ...centre,
      u, v, ...centre, u + 0.10, v, ...centre, u + 0.2, v + 0.08, u + 0.10, v);
  }
  const sprays = new THREE.BufferGeometry();
  sprays.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  sprays.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  sprays.computeVertexNormals();
  return sprays;
}

function mergePainted(core: THREE.BufferGeometry, sprays: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = mergeGeometries([paintCrown(core, 0.75), paintCrown(sprays, 0.87)]);
  core.dispose();
  sprays.dispose();
  return geometry;
}

function paintCrown(geometry: THREE.BufferGeometry, bottom: number): THREE.BufferGeometry {
  const points = geometry.getAttribute('position');
  const colors = new Float32Array(points.count * 3);
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i);
    const y = points.getY(i);
    const z = points.getZ(i);
    const planes = Math.sin(x * 17 + z * 11 + y * 6) * 0.06 + Math.cos(z * 21 - x * 5) * 0.037;
    const shade = THREE.MathUtils.lerp(bottom, 1.23, THREE.MathUtils.clamp(y + 0.60, 0, 1)) + planes;
    colors.set([shade, shade * 1.02, shade * 0.92], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}
