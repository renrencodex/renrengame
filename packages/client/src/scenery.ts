import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { awningMesh, canopyValance, gableMesh, roofShell } from './architectureMesh';
import { paintBark, paintFoliage, paintPlaster, paintRoofTiles } from './scenePaint';
import { barkTrunk, broadleafCrown, pineBough } from './treeMeshes';

const CHUNK_SIZE = 32;
const CROWN_DETAIL_DISTANCE = 55;
const LOD_MARGIN = 4;

type Vec3 = [number, number, number];
type Shape = 'box' | 'wood' | 'stone' | 'plaster' | 'gable' | 'roof' | 'awning' | 'valance' | 'glass'
  | 'trunk' | 'bark' | 'pine' | 'leaves' | 'rock' | 'grass' | 'fern' | 'bloom' | 'contact';

interface Placement {
  yaw?: number;
  pitch?: number;
  roll?: number;
  detail?: boolean;
}

interface Part extends Placement {
  position: Vec3;
  size: Vec3;
  color: number;
}

type Batch = THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>;

/** 按区块、几何及材质组织实例，远景只开简化模型。 */
export class Scenery {
  readonly group = new THREE.Group();
  private readonly parts = new Map<string, { shape: Shape; detail: boolean; entries: Part[] }>();
  private readonly ornaments: Batch[] = [];
  private readonly levels: { near: Batch; far: Batch; bounds: THREE.Sphere }[] = [];
  private reduced = false;

  add(shape: Shape, position: Vec3, size: Vec3, color: number, placement: Placement = {}): void {
    const { detail = false } = placement;
    const key = `${shape}:${Math.floor(position[0] / CHUNK_SIZE)}:${Math.floor(position[2] / CHUNK_SIZE)}:${detail}`;
    const part = { position, size, color, ...placement };
    const group = this.parts.get(key);
    if (group) group.entries.push(part);
    else this.parts.set(key, { shape, detail, entries: [part] });
  }

  build(wood: THREE.Texture, dust: THREE.Texture): void {
    const plain = new THREE.MeshStandardMaterial({ roughness: 0.89 });
    const grain = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.91 });
    const plaster = paintPlaster();
    const wall = new THREE.MeshStandardMaterial({ map: plaster, roughness: 0.97 });
    const fabric = new THREE.MeshStandardMaterial({ map: plaster, roughness: 1, side: THREE.DoubleSide });
    const leaves = (needles: boolean) => new THREE.MeshStandardMaterial({
      map: paintFoliage(needles), roughness: 0.93, vertexColors: true, emissive: 0x101b10, side: THREE.DoubleSide,
    });
    const blades = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide, vertexColors: true });
    const materials: Record<Shape, THREE.Material> = {
      box: plain, rock: plain, wood: grain, trunk: grain, stone: masonryMaterial(dust), plaster: wall, gable: wall,
      roof: new THREE.MeshStandardMaterial({ map: paintRoofTiles(), roughness: 0.80 }), awning: fabric, valance: fabric,
      glass: new THREE.MeshStandardMaterial({ roughness: 0.44, emissive: 0x9a581d, emissiveIntensity: 0.42 }),
      bark: new THREE.MeshStandardMaterial({ map: paintBark(), roughness: 0.95 }), pine: leaves(true), leaves: leaves(false),
      grass: blades, fern: blades, bloom: blades,
      contact: new THREE.MeshBasicMaterial({ map: contactTexture(), transparent: true, depthWrite: false }),
    };
    const geometryCache = new Map<string, THREE.BufferGeometry>();
    const transform = new THREE.Object3D();
    const color = new THREE.Color();
    const geometry = (shape: Shape, low = false) => {
      const key = `${shape}:${low}`;
      let value = geometryCache.get(key);
      if (!value) {
        value = partGeometry(shape, low);
        geometryCache.set(key, value);
      }
      return value;
    };

    for (const { shape, detail, entries } of this.parts.values()) {
      const plant = shape === 'grass' || shape === 'fern' || shape === 'bloom';
      const tree = shape === 'pine' || shape === 'leaves';
      const material = materials[shape];
      const mesh: Batch = new THREE.InstancedMesh(geometry(shape), material, entries.length);
      mesh.castShadow = shape !== 'contact' && shape !== 'glass' && shape !== 'gable' && shape !== 'valance' && !plant && !detail;
      mesh.receiveShadow = shape !== 'contact' && shape !== 'glass';
      entries.forEach(({ position, size, color: tone, yaw = 0, pitch = 0, roll = 0 }, index) => {
        transform.position.set(...position);
        transform.scale.set(...size);
        transform.rotation.set(pitch, yaw, roll, 'YXZ');
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
        mesh.setColorAt(index, color.setHex(tone));
      });
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      if (detail) this.ornaments.push(mesh);
      if (!detail && (tree || shape === 'bark' || shape === 'stone' || shape === 'grass' || shape === 'roof')) {
        const far: Batch = new THREE.InstancedMesh(geometry(shape, true), material, entries.length);
        far.instanceMatrix = mesh.instanceMatrix;
        far.instanceColor = mesh.instanceColor;
        far.computeBoundingSphere();
        const bounds = mesh.boundingSphere!.clone().union(far.boundingSphere!);
        mesh.boundingSphere = bounds;
        far.boundingSphere = bounds;
        far.castShadow = mesh.castShadow;
        far.receiveShadow = mesh.receiveShadow;
        far.visible = false;
        this.group.add(far);
        this.levels.push({ near: mesh, far, bounds });
      }
    }
    this.parts.clear();
  }

  reduceDetail(): void {
    this.reduced = true;
    for (const mesh of this.ornaments) mesh.visible = false;
  }

  update(camera: THREE.Camera): void {
    for (const { near, far, bounds } of this.levels) {
      const distance = camera.position.distanceTo(bounds.center) - Math.min(bounds.radius, 13);
      const threshold = CROWN_DETAIL_DISTANCE + (near.visible ? LOD_MARGIN : -LOD_MARGIN);
      near.visible = !this.reduced && distance < threshold;
      far.visible = !near.visible;
    }
  }
}

function partGeometry(shape: Shape, low: boolean): THREE.BufferGeometry {
  switch (shape) {
    case 'box':
    case 'wood':
    case 'glass':
    case 'plaster': return new THREE.BoxGeometry(1, 1, 1);
    case 'stone': return low ? new THREE.BoxGeometry(1, 1, 1) : new RoundedBoxGeometry(1, 1, 1, 1, 0.055);
    case 'trunk': return new THREE.CylinderGeometry(0.3, 0.5, 1, 7);
    case 'bark': return barkTrunk(low);
    case 'pine': return pineBough(low);
    case 'leaves': return broadleafCrown(low);
    case 'rock': return new THREE.DodecahedronGeometry(0.5, 0);
    case 'grass': return bladeGeometry(low ? 4 : 7, 0.075, low);
    case 'fern': return bladeGeometry(7, 0.18, false);
    case 'bloom': return bloomGeometry();
    case 'contact': return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    case 'roof': return roofShell(low);
    case 'gable': return gableMesh();
    case 'awning': return awningMesh();
    case 'valance': return canopyValance();
  }
}

function shadeLeaves(geometry: THREE.BufferGeometry, bottom: number): THREE.BufferGeometry {
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const tint = THREE.MathUtils.lerp(bottom, 1.15, THREE.MathUtils.clamp(positions.getY(i) + 0.5, 0, 1));
    colors.set([tint * 0.98, tint, tint * 0.94], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function bladeGeometry(leaves: number, breadth: number, low: boolean): THREE.BufferGeometry {
  const vertices: number[] = [];
  for (let i = 0; i < leaves; i++) {
    const angle = i * 2.39996;
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    const span = 0.24 + (i % 3) * 0.12;
    const h = 0.57 + (i % 4) * 0.13;
    const blade = (at: number, y: number, edge: number): Vec3 => [x * at - z * edge, y, z * at + x * edge];
    const left = blade(0.04, 0, breadth * 0.42);
    const right = blade(0.04, 0, -breadth * 0.42);
    const tip = blade(span, h, 0);
    if (low) {
      vertices.push(...left, ...right, ...tip);
    } else {
      const bendLeft = blade(span * 0.36, h * 0.65, breadth * 0.60);
      const bendRight = blade(span * 0.36, h * 0.65, -breadth * 0.60);
      vertices.push(...left, ...right, ...bendLeft, ...bendLeft, ...right, ...bendRight, ...bendLeft, ...bendRight, ...tip);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return shadeLeaves(geometry.translate(0, -0.35, 0), 0.68).translate(0, 0.35, 0);
}

function bloomGeometry(): THREE.BufferGeometry {
  const vertices: number[] = [];
  const colors: number[] = [];
  for (let petal = 0; petal < 5; petal++) {
    const a = (petal / 5) * Math.PI * 2;
    const x = Math.cos(a);
    const z = Math.sin(a);
    vertices.push(0, 0, 0, x * 0.36 - z * 0.24, 0.11, z * 0.36 + x * 0.24,
      x * 0.55, 0.18, z * 0.55, 0, 0, 0, x * 0.55, 0.18, z * 0.55,
      x * 0.36 + z * 0.24, 0.13, z * 0.36 - x * 0.24);
    colors.push(0.78, 0.68, 0.32, 0.98, 0.95, 0.82, 1.2, 1.17, 1.17,
      0.78, 0.68, 0.32, 1.2, 1.17, 1.17, 0.97, 0.91, 0.84);
  }
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  mesh.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  mesh.computeVertexNormals();
  return mesh;
}

function masonryMaterial(dust: THREE.Texture): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.98 });
  material.customProgramCacheKey = () => 'weathered-masonry';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStoneGrain = { value: dust };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      varying vec3 vBlock;
      varying float vBlockTop;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBlock = (instanceMatrix * vec4(position, 1.0)).xyz;
        vBlockTop = max(0.0, normal.y);
      `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vBlock;
      varying float vBlockTop;
      uniform sampler2D uStoneGrain;`)
      .replace('#include <map_fragment>', `
        vec2 grainUV = mix(vec2(vBlock.x + vBlock.z * 0.79, vBlock.y * 1.18), vBlock.xz, vBlockTop);
        float grit = texture2D(uStoneGrain, grainUV * 0.74).r;
        float weather = mix(0.72, 1.23, smoothstep(0.25, 0.46, grit));
        float damp = 1.0 - smoothstep(0.15, 1.36, vBlock.y);
        float moss = smoothstep(0.36, 0.445, grit) * (0.10 + vBlockTop * 0.63 + damp * 0.19);
        diffuseColor.rgb = mix(diffuseColor.rgb * weather, vec3(0.131, 0.174, 0.079), moss);
      `);
  };
  return material;
}

function contactTexture(): THREE.DataTexture {
  const side = 32;
  const data = new Uint8Array(side ** 2 * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const d = Math.hypot(x + 0.5 - side / 2, y + 0.5 - side / 2) / (side / 2);
      data[(y * side + x) * 4 + 3] = Math.round(61 * Math.max(0, 1 - d ** 2) ** 2);
    }
  }
  const texture = new THREE.DataTexture(data, side, side);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
