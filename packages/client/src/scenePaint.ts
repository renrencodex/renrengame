import * as THREE from 'three';
import { mulberry32 } from '@mmo/shared';

export const ROOF_COURSES = 6;
export const ROOF_COLUMNS = 11;

/** 周期噪声用于画材质，纹理接缝处的值和斜率能对上。 */
export function periodicNoise(cols: number, rows: number, random: () => number): (u: number, v: number) => number {
  const values = Float32Array.from({ length: cols * rows }, random);
  return (u, v) => {
    const px = (u - Math.floor(u)) * cols;
    const py = (v - Math.floor(v)) * rows;
    const x = Math.floor(px);
    const y = Math.floor(py);
    const dx = THREE.MathUtils.smoothstep(px - x, 0, 1);
    const dy = THREE.MathUtils.smoothstep(py - y, 0, 1);
    const east = (x + 1) % cols;
    const south = ((y + 1) % rows) * cols;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(values[y * cols + x], values[y * cols + east], dx),
      THREE.MathUtils.lerp(values[south + x], values[south + east], dx), dy,
    );
  };
}

export function repeatingTexture(data: Uint8Array, side: number, color = false): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, side, side);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function paintGrain(side: number, shade: (u: number, v: number) => number): THREE.DataTexture {
  const pixels = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const value = Math.round(THREE.MathUtils.clamp(shade((x + 0.5) / side, (y + 0.5) / side), 0, 255));
      pixels.set([value, value, value, 255], (y * side + x) * 4);
    }
  }
  return repeatingTexture(pixels, side, true);
}

export function paintRoofTiles(): THREE.Texture {
  const random = mulberry32(0x614bfb15);
  const salt = periodicNoise(43, 51, random);
  const kiln = periodicNoise(21, 17, random);
  const fired = Float32Array.from({ length: ROOF_COLUMNS * ROOF_COURSES }, random);
  return paintGrain(256, (u, v) => {
    const course = Math.floor(v * ROOF_COURSES);
    const along = u * ROOF_COLUMNS + (course % 2) * 0.5;
    const col = Math.floor(along) % ROOF_COLUMNS;
    const local = along - Math.floor(along);
    const row = v * ROOF_COURSES - course;
    const edge = THREE.MathUtils.smoothstep(Math.min(local, 1 - local), 0.015, 0.085);
    const overlap = THREE.MathUtils.smoothstep(row, 0.017, 0.14);
    const crown = Math.sin(Math.PI * local);
    const pigment = fired[course * ROOF_COLUMNS + col];
    return 122 + edge * 45 + overlap * 37 + crown * 20 + pigment * 19
      + (kiln(u, v) - 0.5) * 24 + (salt(u, v) - 0.5) * 12;
  });
}

export function paintBark(): THREE.Texture {
  const random = mulberry32(0x55f7674b);
  const bends = periodicNoise(5, 7, random);
  const grooves = periodicNoise(23, 7, random);
  const grain = periodicNoise(55, 13, random);
  return paintGrain(128, (u, v) => {
    const warped = u + (bends(u, v) - 0.5) * 0.12;
    const ridge = grooves(warped, v);
    const edge = ridge - grooves(warped + 0.009, v);
    const furrow = THREE.MathUtils.smoothstep(ridge, 0.2, 0.48);
    return 121 + furrow * 99 + edge * 46 + (grain(warped, v) - 0.5) * 37;
  });
}

export function paintPlaster(): THREE.Texture {
  const random = mulberry32(0xf37dda15);
  const trowel = periodicNoise(8, 9, random);
  const grit = periodicNoise(97, 103, random);
  return paintGrain(128, (u, v) => 224 + (trowel(u, v) - 0.5) * 48 + (grit(u, v) - 0.5) * 16);
}

/** 以灰度笔触画叶片，树冠的颜色仍由区域和每簇叶子的实例色决定。 */
export function paintFoliage(needles: boolean): THREE.Texture {
  const side = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext('2d')!;
  const random = mulberry32(needles ? 0x14124b9e : 0x18e62ab4);
  ctx.fillStyle = '#dedede';
  ctx.fillRect(0, 0, side, side);

  for (let i = 0; i < (needles ? 2100 : 900); i++) {
    const x = random() * side;
    const y = random() * side;
    const length = 3 + random() * (needles ? 8 : 12);
    const width = (0.16 + random() * 0.21) * length * (needles ? 0.5 : 1);
    const angle = needles ? (i % 2 ? 0.8 : 2.3) + (random() - 0.5) * 0.66 : random() * Math.PI * 2;
    const light = Math.floor(123 + random() * 131);
    const opacity = 0.19 + random() * 0.40;
    const brush = (px: number, py: number) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(-length * 0.5, 0);
      ctx.quadraticCurveTo(0, width * 1.32, length * 0.55, 0);
      ctx.quadraticCurveTo(0, -width, -length * 0.5, 0);
      ctx.fillStyle = `rgba(${light},${light},${light},${opacity})`;
      ctx.fill();
      ctx.restore();
    };
    const wrapX = x < length ? side : x > side - length ? -side : 0;
    const wrapY = y < length ? side : y > side - length ? -side : 0;
    brush(x, y);
    if (wrapX) brush(x + wrapX, y);
    if (wrapY) brush(x, y + wrapY);
    if (wrapX && wrapY) brush(x + wrapX, y + wrapY);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 2;
  return texture;
}
