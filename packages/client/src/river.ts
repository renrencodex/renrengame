import * as THREE from 'three';
import { mulberry32, Terrain } from '@mmo/shared';
import type { GameMap } from '@mmo/shared';
import { periodicNoise, repeatingTexture } from './scenePaint';

const SURFACE_Y = 0.008;
const BANK_PADDING = 0.35;

/** 河心坐标跨桥面连续，桥两侧的水纹能顺着同一条河道流动。 */
export function riverCentres(bounds: readonly ({ left: number; right: number } | null)[]): Float32Array {
  const centres = new Float32Array(bounds.length);
  let previous = -1;
  for (let row = 0; row < bounds.length; row++) {
    const span = bounds[row];
    if (!span) continue;
    centres[row] = (span.left + span.right) / 2;
    if (previous < 0) {
      centres.fill(centres[row], 0, row);
    } else {
      for (let gap = previous + 1; gap < row; gap++) {
        centres[gap] = THREE.MathUtils.lerp(centres[previous], centres[row], (gap - previous) / (row - previous));
      }
    }
    previous = row;
  }
  if (previous >= 0) centres.fill(centres[previous], previous + 1);
  return centres;
}

function riverStrip({ size, terrain }: GameMap) {
  const spans = Array.from({ length: size }, (_, z) => {
    let left = size;
    let right = 0;
    for (let x = 0; x < size; x++) {
      if (terrain[z * size + x] !== Terrain.Water) continue;
      left = Math.min(left, x);
      right = x + 1;
    }
    return left < right ? { left, right } : null;
  });
  const positions: number[] = [];
  let minX = size;
  let maxX = 0;
  let start = 0;
  for (let row = 0; row <= size; row++) {
    const span = spans[row];
    if (span) {
      if (minX === size) start = row;
      minX = Math.min(minX, span.left);
      maxX = Math.max(maxX, span.right);
    } else if (minX < maxX) {
      const left = Math.max(0, minX - BANK_PADDING);
      const right = Math.min(size, maxX + BANK_PADDING);
      const front = Math.max(0, start - BANK_PADDING);
      const back = Math.min(size, row + BANK_PADDING);
      positions.push(left, SURFACE_Y, front, left, SURFACE_Y, back, right, SURFACE_Y, front,
        right, SURFACE_Y, front, left, SURFACE_Y, back, right, SURFACE_Y, back);
      minX = size;
      maxX = 0;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  const centres = riverCentres(spans);
  const origin = Math.min(...centres);
  const range = Math.max(1, Math.max(...centres) - origin);
  const data = new Uint8Array(size * 4);
  centres.forEach((centre, row) => { data[row * 4] = Math.round((centre - origin) * 255 / range); });
  const path = new THREE.DataTexture(data, 1, size);
  path.magFilter = path.minFilter = THREE.LinearFilter;
  path.needsUpdate = true;
  return { geometry, path, domain: new THREE.Vector2(origin, range) };
}

/** 四个通道分别存水纹坡度的两个分量、流纹强度和河床砂石。 */
function paintCurrent(seed: number): THREE.DataTexture {
  const side = 128;
  const data = new Uint8Array(side * side * 4);
  const random = mulberry32(seed ^ 0xbad51c9a);
  const broad = periodicNoise(11, 7, random);
  const breaks = periodicNoise(23, 15, random);
  const grains = periodicNoise(83, 71, random);
  const stoneSide = 16;
  const pebbles = Array.from({ length: stoneSide ** 2 }, () => ({
    u: 0.30 + random() * 0.4, v: 0.31 + random() * 0.38, radius: 0.12 + random() ** 1.32 * 0.22, tone: 0.34 + random() * 0.45,
  }));
  const wave = (u: number, v: number) => broad(u, v) * 0.73 + breaks(u, v) * 0.27;
  const byte = (value: number) => Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const u = (x + 0.5) / side;
      const v = (y + 0.5) / side;
      const point = pebbles[Math.floor(v * stoneSide) * stoneSide + Math.floor(u * stoneSide)];
      const du = (u * stoneSide) % 1 - point.u;
      const dv = (v * stoneSide) % 1 - point.v;
      const distance = Math.hypot(du, dv * 1.25);
      const pebble = 1 - THREE.MathUtils.smoothstep(distance, point.radius * 0.78, point.radius);
      const sand = 0.28 + wave(u, v) * 0.15 + (grains(u, v) - 0.5) * 0.17;
      const shine = Math.max(0, -dv) * 0.48;
      data.set([
        byte(0.5 + 2.2 * (wave(u + 0.004, v) - wave(u - 0.004, v))),
        byte(0.5 + 2.2 * (wave(u, v + 0.006) - wave(u, v - 0.006))),
        byte(wave(u, v)),
        byte(THREE.MathUtils.lerp(sand, point.tone + shine, pebble)),
      ], (y * side + x) * 4);
    }
  }
  return repeatingTexture(data, side);
}

export function createRiver(map: GameMap, shores: THREE.Texture) {
  const clock = { value: 0 };
  const detail = { value: 1 };
  const { geometry, path, domain } = riverStrip(map);
  const current = paintCurrent(map.seed);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.36 });
  material.customProgramCacheKey = () => 'river-current-and-shallows';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uShore: { value: shores }, uPath: { value: path }, uCurrent: { value: current },
      uPathDomain: { value: domain }, uWaterSize: { value: map.size }, uClock: clock, uDetail: detail,
    });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vRiver;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRiver = position.xz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vRiver;
      uniform sampler2D uShore, uPath, uCurrent;
      uniform vec2 uPathDomain;
      uniform float uWaterSize, uClock, uDetail;
    `).replace('#include <map_fragment>', `
      float shoreline = texture2D(uShore, vRiver / uWaterSize).a - 0.5;
      if (shoreline < -0.010) discard;

      float centre = uPathDomain.x + uPathDomain.y * texture2D(uPath, vec2(0.5, vRiver.y / uWaterSize)).r;
      vec2 stream = vec2(vRiver.x - centre, vRiver.y);
      vec2 flowUV = stream * vec2(0.19, 0.11) + vec2(0.0, -uClock * 0.085);
      vec4 currentA = texture2D(uCurrent, flowUV);
      float surge = (currentA.b - 0.5) * 0.017;
      float edge = shoreline + surge;
      if (edge < 0.0) discard;

      float depth = smoothstep(0.0, 0.48, edge);
      vec2 slopes = (currentA.rg - 0.5) * 0.44;
      float streamShade = currentA.b;
      if (uDetail > 0.5) {
        vec2 crossUV = vec2(stream.x * 0.17 + stream.y * 0.041, stream.y * 0.18 - stream.x * 0.075);
        vec4 currentB = texture2D(uCurrent, crossUV + vec2(uClock * 0.024, -uClock * 0.134));
        slopes += (currentB.rg - 0.5) * 0.24;
        streamShade = mix(streamShade, currentB.b, 0.41);
      }
      vec3 riverNormal = normalize(vec3(-slopes.x, 1.0, -slopes.y));
      vec3 eye = normalize(cameraPosition - vec3(vRiver.x, ${SURFACE_Y}, vRiver.y));
      float reflectSky = pow(1.0 - clamp(dot(eye, riverNormal), 0.0, 1.0), 2.45);

      // 浅水保留河床纹理，向深处渐渐过渡到水体本身的颜色。
      float bed = 0.48;
      if (edge < 0.38) {
        bed = texture2D(uCurrent, vRiver * 0.205 + slopes * 0.027).a;
      }
      vec3 gravel = mix(vec3(0.057, 0.139, 0.128), vec3(0.225, 0.282, 0.180), bed);
      vec3 deep = vec3(0.021, 0.106, 0.145);
      float ribbons = 1.0 - smoothstep(0.012, 0.061, abs(streamShade - 0.53));
      float shallowsLight = ribbons * (1.0 - smoothstep(0.028, 0.30, edge));
      float flecks = smoothstep(0.56, 0.82, streamShade) * smoothstep(-0.03, 0.14, slopes.y);
      float sheen = ribbons * smoothstep(0.032, 0.105, slopes.x) * depth;
      float lightFoam = (1.0 - smoothstep(0.009, 0.061, edge)) * smoothstep(0.34, 0.67, currentA.b);
      float brokenEdge = (1.0 - smoothstep(0.007, 0.029, abs(edge - 0.044))) * smoothstep(0.61, 0.79, streamShade);
      diffuseColor.rgb *= mix(gravel, deep, depth)
        + vec3(0.085, 0.163, 0.192) * reflectSky * 1.8
        + vec3(0.024, 0.046, 0.036) * shallowsLight
        + vec3(0.038, 0.072, 0.071) * flecks
        + vec3(0.030, 0.061, 0.070) * sheen
        + vec3(0.156, 0.195, 0.157) * (lightFoam + brokenEdge * 0.57);
    `).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = normalize((viewMatrix * vec4(riverNormal, 0.0)).xyz);
    `);
  };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return { mesh, clock, detail };
}
