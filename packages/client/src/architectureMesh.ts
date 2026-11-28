import * as THREE from 'three';
import { ROOF_COLUMNS, ROOF_COURSES } from './scenePaint';

/** 檐口略平、屋脊稍陡，瓦片和山墙共用这条轮廓。 */
export function roofProfile(progress: number): number {
  return 0.5 - progress * (1.28 - 0.28 * progress);
}

export function roofShell(low: boolean): THREE.BufferGeometry {
  const positions: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const ridge = Array.from({ length: ROOF_COURSES + 1 }, (_, i) => i / ROOF_COURSES);
  function patch(side: number, span: readonly number[], across: readonly number[], rise: (i: number, j: number) => number, underside = false) {
    const offset = positions.length / 3;
    for (let i = 0; i < span.length; i++) {
      for (let j = 0; j < across.length; j++) {
        positions.push(side * span[i] / 2, roofProfile(span[i]) + rise(i, j), across[j] - 0.5);
        uv.push(across[j], span[i]);
      }
    }
    const flip = (side > 0) !== underside;
    for (let i = 0; i < span.length - 1; i++) {
      for (let j = 0; j < across.length - 1; j++) {
        const a = offset + i * across.length + j;
        const c = a + across.length;
        if (flip) index.push(a, a + 1, c, a + 1, c + 1, c);
        else index.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  }

  for (const side of [-1, 1]) {
    patch(side, ridge, [0, 1], () => 0);
    patch(side, ridge, [0, 1], () => -0.046, true);
    if (low) continue;
    for (let row = 0; row < ROOF_COURSES; row++) {
      const inset = 0.019 / ROOF_COURSES;
      const a = ridge[row] + inset;
      const b = ridge[row + 1] - inset;
      const stagger = (row % 2) * 0.5;
      for (let col = 0; col <= ROOF_COLUMNS; col++) {
        const start = Math.max(0, (col - stagger + 0.038) / ROOF_COLUMNS);
        const end = Math.min(1, (col + 1 - stagger - 0.038) / ROOF_COLUMNS);
        if (end <= start) continue;
        const middle = (start + end) / 2;
        const warp = Math.sin(side * col * 3.19 + row * 1.7) * 0.008;
        patch(side, [a, (a + b) / 2, b, b + inset * 0.64], [start, middle, end], (i, j) => {
          if (i === 3) return 0.003 + warp;
          return 0.014 + i * 0.010 + (j === 1 ? 0.032 : 0) + warp;
        });
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

export function gableMesh(): THREE.BufferGeometry {
  const profile = new THREE.Shape();
  profile.moveTo(-0.5, -0.5);
  for (let row = ROOF_COURSES - 1; row >= 0; row--) {
    const step = row / ROOF_COURSES;
    profile.lineTo(-step / 2, roofProfile(step));
  }
  for (let row = 1; row <= ROOF_COURSES; row++) {
    const step = row / ROOF_COURSES;
    profile.lineTo(step / 2, roofProfile(step));
  }
  profile.closePath();
  return new THREE.ExtrudeGeometry(profile, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
}

export function awningMesh(): THREE.BufferGeometry {
  const sheet = new THREE.PlaneGeometry(1, 1, 4, 10).rotateX(-Math.PI / 2);
  const points = sheet.getAttribute('position');
  for (let i = 0; i < points.count; i++) {
    const u = points.getX(i) + 0.5;
    const v = points.getZ(i) + 0.5;
    points.setY(i, 0.46 - v * 0.71 - Math.sin(v * Math.PI) * (0.30 + 0.12 * Math.sin(u * Math.PI)));
  }
  sheet.computeVertexNormals();
  return sheet;
}

export function canopyValance(): THREE.BufferGeometry {
  const fringe = new THREE.PlaneGeometry(1, 1, 10, 1);
  const points = fringe.getAttribute('position');
  for (let i = 0; i < points.count; i++) {
    if (points.getY(i) > 0) continue;
    const x = points.getX(i);
    points.setY(i, -0.12 - Math.cos(x * Math.PI) * 0.38);
    points.setZ(i, Math.sin(x * 4.8) * 0.09);
  }
  fringe.computeVertexNormals();
  return fringe;
}
