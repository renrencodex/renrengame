import type { Obstacle } from '@mmo/shared';
import { roofProfile } from './architectureMesh';
import type { Scenery } from './scenery';

type Vec3 = [number, number, number];
type Facade = (offset: number, y: number, out?: number) => Vec3;

const LIGHT_WOOD = 0xe9caa0;
const FRAME = 0xc1aa91;
const IRON = 0x554f48;

function facade(x: number, z: number, yaw: number): Facade {
  const a = Math.cos(yaw);
  const b = Math.sin(yaw);
  return (offset, y, out = 0) => [x + offset * a + out * b, y, z - offset * b + out * a];
}

function brace(scenery: Scenery, face: Facade, yaw: number, a: [number, number], b: [number, number], width: number, out: number): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  scenery.add('wood', face((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, out), [width, Math.hypot(dx, dy), width * 0.9], FRAME,
    { yaw, roll: -Math.atan2(dx, dy) });
}

export function addCottage(scenery: Scenery, { x, z, w, d, h }: Obstacle, random: () => number): void {
  const cx = x + w / 2;
  const cz = z + d / 2;
  const isSlate = random() < 0.37;
  const tile = isSlate ? 0x6f9a93 : 0xc97855;
  const render = isSlate ? 0xd5c6a6 : 0xe5c497;
  const eave = h - 0.065;
  const rise = 1.85 + random() * 0.44;
  const roofY = eave + rise / 2;
  const roofWidth = w + 0.66;

  scenery.add('contact', [cx, 0.012, cz], [w + 1.65, 1, d + 1.5], 0xffffff);
  scenery.add('stone', [cx, 0.21, cz], [w - 0.08, 0.42, d - 0.08], 0x8c897d);
  scenery.add('plaster', [cx, h / 2, cz], [w - 0.24, h - 0.095, d - 0.24], render);
  scenery.add('gable', [cx, roofY - 0.10, cz], [w - 0.23, rise * 0.96, d - 0.23], render);
  scenery.add('roof', [cx, roofY, cz], [roofWidth, rise, d + 0.66], tile);
  scenery.add('wood', [cx, eave + rise + 0.045, cz], [0.23, 0.17, d + 0.74], LIGHT_WOOD);
  for (const side of [-1, 1]) {
    scenery.add('wood', [cx + side * (roofWidth * 0.5 - 0.035), eave - 0.035, cz], [0.18, 0.19, d + 0.71], FRAME);
    for (let i = 0; i < 5; i++) {
      scenery.add('wood', [cx + side * (w * 0.5 - 0.07), h - 0.32, z + 0.19 + (d - 0.38) * i / 4],
        [0.60, 0.16, 0.19], LIGHT_WOOD, { detail: true });
    }
  }
  for (const yaw of [0, Math.PI]) {
    const face = facade(cx, cz + Math.cos(yaw) * (d / 2 - 0.072), yaw);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const a = i / 3;
        const b = (i + 1) / 3;
        brace(scenery, face, yaw,
          [side * roofWidth * a / 2, roofY + rise * roofProfile(a) - 0.08],
          [side * roofWidth * b / 2, roofY + rise * roofProfile(b) - 0.08], 0.17, 0.34);
      }
      brace(scenery, face, yaw, [side * w * 0.38, h - 0.22], [0, eave + rise * 0.76], 0.13, 0.005);
    }
    brace(scenery, face, yaw, [0, h - 0.21], [0, eave + rise - 0.15], 0.16, 0.025);
  }

  addChimney(scenery, cx + w * 0.20, cz - d * 0.19, eave + rise * 0.49, eave + rise + 0.43);
  const front = facade(cx, z + d - 0.075, 0);
  const side = facade(x + w - 0.075, cz, Math.PI / 2);
  addTimberedWall(scenery, front, w, h, 0);
  addTimberedWall(scenery, side, d, h, Math.PI / 2);

  for (const offset of [-w * 0.32, w * 0.32]) addWindow(scenery, front, offset, h * 0.58, 0, isSlate);
  addWindow(scenery, side, -d * 0.19, h * 0.58, Math.PI / 2, !isSlate);
  brace(scenery, side, Math.PI / 2, [d * 0.19, 0.56], [d * 0.45, h - 0.29], 0.16, 0.035);

  scenery.add('wood', front(0, 1.04, 0.04), [1.28, 2.08, 0.14], FRAME);
  for (let plank = -2; plank <= 2; plank++) {
    scenery.add('wood', front(plank * 0.205, 0.99, 0.119), [0.197, 1.83, 0.05], plank % 2 === 0 ? LIGHT_WOOD : 0xd6bd9b);
  }
  scenery.add('stone', front(0, 0.098, 0.039), [1.38, 0.19, 0.34], 0xa29b88);
  for (const y of [0.47, 1.44]) {
    scenery.add('box', front(-0.162, y, 0.157), [0.60, 0.065, 0.030], IRON, { detail: true });
    scenery.add('box', front(-0.40, y, 0.176), [0.047, 0.051, 0.026], 0xa29a83, { detail: true });
  }
  scenery.add('box', front(0.35, 0.96, 0.165), [0.131, 0.037, 0.052], 0xc3a36c, { detail: true });
  addLantern(scenery, front, w * 0.225, h * 0.67);
}

function addTimberedWall(scenery: Scenery, face: Facade, width: number, h: number, yaw: number): void {
  for (const at of [-0.47, -0.225, 0.225, 0.47]) {
    scenery.add('wood', face(width * at, h * 0.5), [0.21, h, 0.20], FRAME, { yaw });
  }
  for (const y of [0.47, h - 0.20]) scenery.add('wood', face(0, y), [width - 0.08, 0.175, 0.22], FRAME, { yaw });
  const blocks = Math.ceil(width / 0.77);
  for (let i = 0; i < blocks; i++) {
    const x = width * ((i + 0.5) / blocks - 0.5);
    scenery.add('stone', face(x, 0.225, 0.016), [width / blocks - 0.028, 0.35 + Math.cos(i * 3) * 0.025, 0.16],
      i % 3 === 0 ? 0xa19b89 : 0x8d8e81, { yaw });
  }
}

function addChimney(scenery: Scenery, x: number, z: number, bottom: number, top: number): void {
  const rows = 6;
  const rise = (top - bottom) / rows;
  for (let row = 0; row < rows; row++) {
    scenery.add('stone', [x + Math.sin(row * 2.3) * 0.022, bottom + (row + 0.5) * rise, z],
      [0.54 + (row % 2) * 0.055, rise - 0.015, 0.57 + ((row + 1) % 2) * 0.031], row % 3 === 0 ? 0x8f8c7d : 0x9d9783);
  }
  scenery.add('stone', [x, top + 0.07, z], [0.76, 0.14, 0.76], 0x817e71);
  scenery.add('box', [x, top + 0.14, z], [0.34, 0.019, 0.34], 0x3f3c35);
  for (const sign of [-1, 1]) {
    scenery.add('stone', [x + sign * 0.27, top + 0.167, z], [0.14, 0.11, 0.68], 0xa29b86);
    scenery.add('stone', [x, top + 0.167, z + sign * 0.27], [0.42, 0.11, 0.14], 0xa29b86);
  }
}

function addWindow(scenery: Scenery, face: Facade, offset: number, y: number, yaw: number, warm: boolean): void {
  const at: Facade = (side, up, out) => face(offset + side, y + up, (out ?? 0) + 0.07);
  scenery.add('wood', at(0, 0, 0), [1.0, 0.88, 0.19], FRAME, { yaw });
  scenery.add('wood', at(0, 0, 0.107), [0.79, 0.65, 0.048], 0x9c917f, { yaw });
  for (const x of [-1, 1]) {
    for (const top of [-1, 1]) {
      const window = warm ? (top === 1 ? 0xf6ce83 : 0xc3824e) : (top === 1 ? 0xaabfba : 0x648987);
      scenery.add('glass', at(x * 0.179, top * 0.147, 0.142), [0.301, 0.24, 0.032], window, { yaw });
    }
  }
  for (const wing of [-1, 1]) {
    scenery.add('wood', at(wing * 0.588, 0.02, 0.03), [0.24, 0.73, 0.094], 0xbccab4, { yaw: yaw + wing * 0.18 });
    for (const strap of [-0.23, 0.23]) {
      scenery.add('wood', at(wing * 0.588, strap, 0.09), [0.21, 0.052, 0.065], FRAME, { yaw, detail: true });
    }
  }
  scenery.add('stone', at(0, -0.398, 0.12), [1.12, 0.14, 0.34], 0xa79c89, { yaw });
  scenery.add('wood', at(0, 0.438, 0.08), [1.16, 0.12, 0.25], LIGHT_WOOD, { yaw });
}

function addLantern(scenery: Scenery, face: Facade, offset: number, y: number): void {
  scenery.add('box', face(offset, y + 0.23, 0.11), [0.07, 0.08, 0.26], IRON);
  scenery.add('glass', face(offset, y, 0.215), [0.214, 0.28, 0.20], 0xf9c369);
  for (const cap of [-0.16, 0.16]) {
    scenery.add('box', face(offset, y + cap, 0.215), [0.28, 0.055, 0.27], IRON);
  }
  for (const corner of [-1, 1]) {
    scenery.add('box', face(offset + corner * 0.104, y, 0.317), [0.025, 0.31, 0.025], IRON, { detail: true });
  }
}
