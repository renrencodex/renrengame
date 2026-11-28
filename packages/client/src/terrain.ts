import * as THREE from 'three';
import { mulberry32, Terrain } from '@mmo/shared';
import type { GameMap } from '@mmo/shared';
import grassUrl from './assets/landscape/grass.webp';
import dirtUrl from './assets/landscape/dirt.webp';
import stoneUrl from './assets/landscape/stone.webp';
import woodUrl from './assets/landscape/wood.webp';

const MATERIALS = {
  grass: { url: grassUrl, base: [119, 137, 83] },
  dirt: { url: dirtUrl, base: [161, 135, 100] },
  stone: { url: stoneUrl, base: [148, 141, 119] },
  wood: { url: woodUrl, base: [154, 115, 79] },
} as const;

type MaterialName = keyof typeof MATERIALS;
export type LandscapeTextures = Record<MaterialName, THREE.Texture>;

/** 进场时与人物模型一起载入。个别材质失效时仍能看清道路、河道和障碍。 */
export async function loadLandscapeTextures(): Promise<LandscapeTextures> {
  const loader = new THREE.TextureLoader();
  async function load(name: MaterialName): Promise<THREE.Texture> {
    const { url, base } = MATERIALS[name];
    let texture: THREE.Texture;
    try {
      texture = await loader.loadAsync(url);
    } catch {
      texture = new THREE.DataTexture(new Uint8Array([...base, 255]), 1, 1);
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    return texture;
  }
  const [grass, dirt, stone, wood] = await Promise.all([load('grass'), load('dirt'), load('stone'), load('wood')]);
  return { grass, dirt, stone, wood };
}

const SHORE_DEPTH = 2.25;
const SHORE_OFFSETS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
  [2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, 1], [2, -1], [-2, -1],
  [1, 2], [-1, 2], [1, -2], [-1, -2], [2, 2], [-2, 2], [2, -2], [-2, -2],
].map(([x, z]) => ({ x, z, distance: Math.hypot(Math.max(0, Math.abs(x) - 0.5), Math.max(0, Math.abs(z) - 0.5)) }));

const PLANT_TINT: Record<Terrain, readonly [number, number, number]> = {
  [Terrain.Grass]: [232, 242, 224],
  [Terrain.Forest]: [174, 212, 202],
  [Terrain.Meadow]: [253, 245, 192],
  [Terrain.Village]: [241, 232, 192],
  [Terrain.Stone]: [196, 210, 191],
  [Terrain.Bank]: [211, 216, 173],
  [Terrain.Water]: [180, 205, 180],
  [Terrain.Road]: [235, 235, 209],
  [Terrain.Bridge]: [235, 235, 209],
};

/** 混合纹理的四个通道是泥土、石板、湿岸、到水边的有符号距离。 */
export function terrainLayers({ size, terrain, seed, landmarks }: GameMap): { layers: Uint8Array; tint: Uint8Array } {
  const layers = new Uint8Array(terrain.length * 4);
  const tint = new Uint8Array(layers.length);
  const random = mulberry32(seed ^ 0x23254ed9);
  const step = 11;
  const side = Math.ceil(size / step) + 1;
  const tones = Float32Array.from({ length: side * side }, random);
  const ruins = landmarks.find((site) => site.kind === 'ruins');

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const index = z * size + x;
      const surface = terrain[index] as Terrain;
      const wet = surface === Terrain.Water;
      let distance = SHORE_DEPTH;
      for (const offset of SHORE_OFFSETS) {
        const col = x + offset.x;
        const row = z + offset.z;
        if (col >= 0 && col < size && row >= 0 && row < size && (terrain[row * size + col] === Terrain.Water) !== wet) {
          distance = offset.distance;
          break;
        }
      }

      const i = Math.floor(z / step) * side + Math.floor(x / step);
      const u = (x % step) / step;
      const v = (z % step) / step;
      const tone = THREE.MathUtils.lerp(THREE.MathUtils.lerp(tones[i], tones[i + 1], u),
        THREE.MathUtils.lerp(tones[i + side], tones[i + side + 1], u), v);
      const plaza = surface === Terrain.Village || surface === Terrain.Road;
      let stone = surface === Terrain.Stone ? 1 : 0;
      if (plaza) {
        const fromCenter = Math.hypot(x + 0.5 - size / 2, z + 0.5 - size / 2);
        stone = 1 - THREE.MathUtils.smoothstep(fromCenter, 6.45, 7.4);
      }
      if (ruins && surface === Terrain.Road) {
        const inside = Math.abs(x + 0.5 - ruins.x);
        stone = Math.max(stone, (1 - THREE.MathUtils.smoothstep(inside, 8, 11.5)) * 0.65);
      }
      const dirt = surface === Terrain.Road || surface === Terrain.Bridge || surface === Terrain.Bank || wet
        ? 1 : surface === Terrain.Village ? 0.23 + tone * 0.29 : 0;
      const at = index * 4;
      layers[at] = Math.round(dirt * (1 - stone) * 255);
      layers[at + 1] = Math.round(stone * 255);
      layers[at + 2] = wet ? 255 : Math.round((1 - distance / SHORE_DEPTH) * 255);
      layers[at + 3] = Math.round((0.5 + (wet ? distance : -distance) / (2 * SHORE_DEPTH)) * 255);
      const colors = PLANT_TINT[surface];
      tint[at] = colors[0];
      tint[at + 1] = colors[1];
      tint[at + 2] = colors[2];
      tint[at + 3] = Math.round((0.15 + tone * 0.74) * 255);
    }
  }
  return { layers, tint };
}

/** 连续有水的行合成一片。几何包住岸线，实际水面边缘由同一张遮罩裁切。 */
function waterStrips({ size, terrain }: GameMap): THREE.BufferGeometry {
  const vertices: number[] = [];
  let minX = size;
  let maxX = 0;
  let start = 0;
  for (let z = 0; z <= size; z++) {
    let left = size;
    let right = 0;
    if (z < size) {
      for (let x = 0; x < size; x++) {
        if (terrain[z * size + x] === Terrain.Water) {
          left = Math.min(left, x);
          right = x + 1;
        }
      }
    }
    if (left < right) {
      if (minX === size) start = z;
      minX = Math.min(minX, left);
      maxX = Math.max(maxX, right);
    } else if (minX < maxX) {
      const x0 = Math.max(0, minX - 0.35);
      const x1 = Math.min(size, maxX + 0.35);
      const z0 = Math.max(0, start - 0.35);
      const z1 = Math.min(size, z + 0.35);
      vertices.push(x0, 0.008, z0, x0, 0.008, z1, x1, 0.008, z0,
        x1, 0.008, z0, x0, 0.008, z1, x1, 0.008, z1);
      minX = size;
      maxX = 0;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function controlTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function createTerrain(map: GameMap, textures: LandscapeTextures) {
  const { size } = map;
  const { layers, tint } = terrainLayers(map);
  const layerMap = controlTexture(layers, size);
  const tintMap = controlTexture(tint, size);
  const time = { value: 0 };
  const detail = { value: 1 };
  const groundMaterial = new THREE.MeshStandardMaterial({ roughness: 0.96 });
  groundMaterial.customProgramCacheKey = () => 'hand-painted-ground';
  groundMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uLayers: { value: layerMap }, uTint: { value: tintMap }, uGrass: { value: textures.grass },
      uDirt: { value: textures.dirt }, uStone: { value: textures.stone },
      uTerrainSize: { value: size },
    });
    // 用世界坐标重复细纹理，用网格遮罩决定每种材质出现在哪。
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vTerrain;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrain = vec2(uv.x, 1.0 - uv.y);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vTerrain;
      uniform sampler2D uLayers, uTint, uGrass, uDirt, uStone;
      uniform float uTerrainSize;`)
      .replace('#include <map_fragment>', `
        vec2 metres = vTerrain * uTerrainSize;
        vec4 region = texture2D(uTint, vTerrain);
        vec3 foliage = texture2D(uGrass, metres / 6.2).rgb;
        vec2 ragged = vec2(foliage.r - foliage.g, foliage.b - foliage.g) * 0.53 / uTerrainSize;
        vec4 blend = texture2D(uLayers, vTerrain + ragged);
        vec3 dirt = texture2D(uDirt, metres / 7.5).rgb;
        vec3 paving = texture2D(uStone, metres / 5.7).rgb;
        foliage *= region.rgb * 1.1;
        dirt = mix(dirt, dirt * vec3(0.63, 0.80, 0.77), blend.b * 0.82);
        float grassAmount = max(0.0, 1.0 - blend.r - blend.g);
        vec3 surface = foliage * grassAmount + dirt * blend.r + paving * blend.g;
        diffuseColor.rgb *= surface * mix(0.81, 1.17, region.a);
      `);
  };

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), groundMaterial);
  ground.position.set(size / 2, 0, size / 2);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;

  const riverMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55 });
  riverMaterial.customProgramCacheKey = () => 'hand-painted-river';
  riverMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uLayers: { value: layerMap }, uClock: time, uDetail: detail, uTerrainSize: { value: size } });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vRiver;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRiver = position.xz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vRiver;
      uniform sampler2D uLayers;
      uniform float uClock, uDetail, uTerrainSize;`)
      .replace('#include <map_fragment>', `
        float shore = texture2D(uLayers, vRiver / uTerrainSize).a - 0.5;
        float edgeRipple = 0.010 * sin(vRiver.y * 4.5 + vRiver.x * 3.3 - uClock * 1.37);
        if (shore + edgeRipple < 0.0) discard;
        float depth = smoothstep(0.0, 0.48, shore);
        float swell = sin(vRiver.y * 4.1 + sin(vRiver.x * 1.56 + vRiver.y * 0.49) * 1.50 - uClock * 1.48);
        float curl = sin(vRiver.y * 7.7 - vRiver.x * 5.0 - uClock * 1.85);
        float ripple = smoothstep(0.62, 1.0, swell * 0.75 + curl * 0.25);
        float glint = 0.0;
        if (uDetail > 0.5) {
          glint = smoothstep(0.82, 1.0, cos(vRiver.x * 7.3 + vRiver.y * 12.1 + swell * 1.6 - uClock * 1.7)) * ripple;
        }
        float foam = (1.0 - smoothstep(0.012, 0.080, shore)) * smoothstep(0.06, 0.82, swell + 0.22);
        vec3 shallows = vec3(0.081, 0.218, 0.194) + swell * vec3(0.009, 0.016, 0.013);
        vec3 current = vec3(0.021, 0.099, 0.135) + ripple * vec3(0.027, 0.064, 0.059);
        diffuseColor.rgb *= mix(shallows, current, depth) + foam * vec3(0.18, 0.20, 0.14) + glint * vec3(0.036, 0.076, 0.081);
      `);
  };
  const river = new THREE.Mesh(waterStrips(map), riverMaterial);
  river.receiveShadow = true;
  return { ground, river, time, detail };
}
