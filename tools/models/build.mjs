// 把 Quaternius 的素材处理成游戏里用的人物模型。
//
// 用法：
//   node build.mjs <素材目录> [输出目录]
//
// <素材目录> 里要有这两个解压后的文件夹（都是 CC0 授权，来源见 README）：
//   Universal Base Characters[Standard]/
//   Universal Animation Library[Standard]/
//
// 输出 human_male.glb 和 human_female.glb，每个文件里有身体、眼睛、眉毛、头发、
// 右手上挂武器的位置和游戏用到的几个动作。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune, quantize, resample } from '@gltf-transform/functions';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = process.argv[2];
const outDir = process.argv[3] ?? path.join(here, '../../packages/client/public/models');
if (!sourceDir) {
  console.error('用法：node build.mjs <素材目录> [输出目录]');
  process.exit(1);
}

const BASE = path.join(sourceDir, 'Universal Base Characters[Standard]');
const BODY_DIR = path.join(BASE, 'Base Characters/Godot - UE');
const SKIN_DIR = path.join(BASE, 'Base Characters/Textures');
const HAIR_DIR = path.join(BASE, 'Hairstyles/Origin at 0/glTF (Godot)');
const ANIMATIONS = path.join(sourceDir, 'Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb');

/** 游戏里用到的动作。 */
const CLIPS = ['Idle_Loop', 'Jog_Fwd_Loop', 'Punch_Jab', 'Punch_Cross', 'Sword_Idle', 'Sword_Attack', 'Death01'];
/** 这些骨头保留位移，其余骨头只保留旋转，骨头的长短以人物自己的为准。 */
const TRANSLATED_BONES = new Set(['root', 'pelvis']);

const CHARACTERS = [
  {
    out: 'human_male.glb',
    body: 'Superhero_Male_FullBody.gltf',
    skin: 'T_Superhero_Male_Ligh.png',
    hair: 'Hair_SimpleParted.gltf',
    hairTexture: 'T_Hair_1_BaseColor.png',
  },
  {
    out: 'human_female.glb',
    body: 'Superhero_Female_FullBody.gltf',
    skin: 'T_Superhero_Female_Light_BaseColor.png',
    hair: 'Hair_Long.gltf',
    hairTexture: 'T_Hair_2_BaseColor.png',
  },
];

const SKIN_TEXTURE_SIZE = 1024;
const HAIR_TEXTURE_SIZE = 512;
const EYE_TEXTURE_SIZE = 256;
const KEPT_ATTRIBUTES = new Set(['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']);
/** 衣服的默认颜色，游戏里会按角色再换。 */
const CLOTH_COLORS = {
  Shirt: [0.25, 0.35, 0.55, 1],
  Pants: [0.07, 0.08, 0.1, 1],
  Boots: [0.04, 0.03, 0.025, 1],
};
/** 握在手里的东西的中心，离手指根部的连线有多远（米）：朝手心一侧、朝指尖一侧。 */
const GRIP_TOWARD_PALM = 0.03;
const GRIP_TOWARD_FINGERTIPS = 0.015;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/**
 * 读入一个 .gltf 文件，但不读它引用的贴图：原始文件里有几个贴图的文件名写错了，
 * 直接读会失败。需要的贴图由这个脚本自己按文件名去取。
 */
async function readWithoutTextures(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const material of json.materials ?? []) {
    delete material.normalTexture;
    delete material.occlusionTexture;
    delete material.emissiveTexture;
    delete material.pbrMetallicRoughness?.baseColorTexture;
    delete material.pbrMetallicRoughness?.metallicRoughnessTexture;
  }
  const resources = {};
  for (const buffer of json.buffers) {
    resources[buffer.uri] = new Uint8Array(fs.readFileSync(path.join(path.dirname(file), decodeURIComponent(buffer.uri))));
  }
  return io.readJSON({ json, resources });
}

async function webp(file, size) {
  return sharp(file).resize(size, size, { fit: 'inside' }).webp({ quality: 82, effort: 6 }).toBuffer();
}

function nodesByName(doc) {
  return new Map(doc.getRoot().listNodes().map((node) => [node.getName(), node]));
}

function nodeByName(doc, name) {
  const node = nodesByName(doc).get(name);
  if (!node) throw new Error(`找不到节点 ${name}`);
  return node;
}

// ---------- 四元数 [x, y, z, w] ----------

function multiply([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function conjugate([x, y, z, w]) {
  return [-x, -y, -z, w];
}

function rotate(q, [x, y, z]) {
  const [rx, ry, rz] = multiply(multiply(q, [x, y, z, 0]), conjugate(q));
  return [rx, ry, rz];
}

function angleBetween(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** 三个互相垂直的单位向量（旋转后的 X、Y、Z 轴）对应的四元数。 */
function fromAxes(x, y, z) {
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4];
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    return [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  }
  if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    return [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  }
  const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
  return [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s];
}

// ---------- 向量 [x, y, z] ----------

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => scale(a, 1 / Math.hypot(...a));

// ---------- 身体 ----------

/**
 * 原始模型只穿着内衣。这里按站立姿势下的位置把身体的三角形分成四块：
 * 皮肤、上衣、裤子、鞋，各用一个材质。上衣、裤子和鞋是纯色的，游戏里可以换色。
 */
function makeClassifier(doc) {
  const at = (name) => nodeByName(doc, name).getWorldTranslation();
  const ankle = at('foot_l')[1];
  const knee = at('calf_l')[1];
  const waist = at('pelvis')[1] + 0.07;
  const neck = at('neck_01');
  const wrist = Math.abs(at('hand_l')[0]);
  const bootTop = ankle + 0.4 * (knee - ankle);
  return ([x, y, z]) => {
    if (y < bootTop) return 'Boots';
    if (y < waist) return 'Pants';
    // T 形站姿，手臂沿 x 轴伸开：袖子到手腕为止。
    if (Math.abs(x) > wrist - 0.02) return 'Skin';
    if (y > neck[1] + 0.05) return 'Skin';
    if (y > neck[1] - 0.03 && Math.hypot(x, z - neck[2]) < 0.085) return 'Skin';
    return 'Shirt';
  };
}

function splitBody(doc, mesh, materials) {
  const classify = makeClassifier(doc);
  const buffer = doc.getRoot().listBuffers()[0];
  const [source] = mesh.listPrimitives();
  const position = source.getAttribute('POSITION');
  const indices = source.getIndices().getArray();
  const groups = { Skin: [], Shirt: [], Pants: [], Boots: [] };
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  for (let i = 0; i < indices.length; i += 3) {
    position.getElement(indices[i], a);
    position.getElement(indices[i + 1], b);
    position.getElement(indices[i + 2], c);
    const center = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    groups[classify(center)].push(indices[i], indices[i + 1], indices[i + 2]);
  }
  for (const [name, list] of Object.entries(groups)) {
    if (list.length === 0) throw new Error(`${name} 没有分到任何三角形`);
    const part = source.clone();
    part.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(list)).setBuffer(buffer));
    part.setMaterial(materials[name]);
    mesh.addPrimitive(part);
  }
  mesh.removePrimitive(source);
  source.dispose();
}

/** 把一个不带骨骼的发型模型挂到头部的骨头上。 */
async function attachHair(doc, file, material) {
  const hairDoc = await readWithoutTextures(file);
  const [sourceMesh] = hairDoc.getRoot().listMeshes();
  const [sourcePrimitive] = sourceMesh.listPrimitives();
  const buffer = doc.getRoot().listBuffers()[0];
  const copy = (accessor) =>
    doc.createAccessor().setType(accessor.getType()).setArray(accessor.getArray().slice()).setBuffer(buffer);
  const primitive = doc.createPrimitive().setMaterial(material).setIndices(copy(sourcePrimitive.getIndices()));
  for (const semantic of ['POSITION', 'NORMAL', 'TEXCOORD_0']) {
    primitive.setAttribute(semantic, copy(sourcePrimitive.getAttribute(semantic)));
  }
  const head = nodeByName(doc, 'Head');
  if (head.getWorldScale().some((s) => Math.abs(s - 1) > 1e-4)) throw new Error('头部骨头带缩放，没法直接挂头发');
  // 头发的顶点是按整个人物的坐标摆的，所以给它一个“头部骨头的逆变换”。
  const inverse = conjugate(head.getWorldRotation());
  const [x, y, z] = head.getWorldTranslation();
  const node = doc
    .createNode('Hair')
    .setMesh(doc.createMesh('Hair').addPrimitive(primitive))
    .setRotation(inverse)
    .setTranslation(rotate(inverse, [-x, -y, -z]));
  head.addChild(node);
}

/**
 * 在右手的骨头下面加一个空节点 Weapon_R，表示“握在手里的东西”的位置和朝向。
 * 游戏里把武器模型放到这个节点下面，武器就跟着手动。约定：
 *   原点 是握住的那一段的中心；
 *   Y 轴 从小指一侧指向食指一侧，剑身沿这个方向伸出去；
 *   X 轴 指向指尖的方向，剑刃在 X–Y 平面里。
 * 位置和朝向都是用站立姿势下手和手指根部的骨头算出来的，男女模型的手大小不同，各算各的。
 */
function addWeaponSocket(doc) {
  const hand = nodeByName(doc, 'hand_r');
  if (hand.getWorldScale().some((s) => Math.abs(s - 1) > 1e-4)) throw new Error('右手的骨头带缩放，没法直接挂武器');
  const at = (name) => nodeByName(doc, name).getWorldTranslation();
  const index = at('index_01_r');
  const pinky = at('pinky_01_r');
  const y = normalize(subtract(index, pinky));
  const toFingers = normalize(subtract(at('middle_01_r'), at('hand_r')));
  const x = normalize(subtract(toFingers, scale(y, dot(toFingers, y))));
  // 右手：X × Y 指向手背，手心在反方向。
  const z = cross(x, y);
  const center = add(
    add(scale(add(index, pinky), 0.5), scale(z, -GRIP_TOWARD_PALM)),
    scale(x, GRIP_TOWARD_FINGERTIPS),
  );
  const inverse = conjugate(hand.getWorldRotation());
  const socket = doc
    .createNode('Weapon_R')
    .setRotation(multiply(inverse, fromAxes(x, y, z)))
    .setTranslation(rotate(inverse, subtract(center, hand.getWorldTranslation())));
  hand.addChild(socket);
}

// ---------- 动作 ----------

/**
 * 把动作库里的动作搬到人物的骨架上。
 *
 * 两副骨架的骨头名字一样，但关节的位置不同，所以每根骨头站立时的朝向也不同，
 * 直接照搬旋转会让脖子、肩膀歪掉。这里保持“相对站立姿势转了多少”不变：
 *   人物的旋转 = A · 动作库的旋转 · B
 * A 和 B 是由两边站立姿势算出来的常量。
 */
function copyAnimations(doc, source) {
  const buffer = doc.getRoot().listBuffers()[0];
  const targets = nodesByName(doc);
  const globalRest = (node) => (node ? node.getWorldRotation() : [0, 0, 0, 1]);
  const missing = new Set(CLIPS);
  let largestCorrection = 0;

  for (const sourceAnimation of source.getRoot().listAnimations()) {
    if (!missing.delete(sourceAnimation.getName())) continue;
    const animation = doc.createAnimation(sourceAnimation.getName());
    for (const channel of sourceAnimation.listChannels()) {
      const sourceNode = channel.getTargetNode();
      const targetPath = channel.getTargetPath();
      const name = sourceNode.getName();
      const keep = targetPath === 'rotation' || (targetPath === 'translation' && TRANSLATED_BONES.has(name));
      if (!keep) continue;
      const node = targets.get(name);
      if (!node) throw new Error(`人物的骨架里没有 ${name}`);
      const sourceSampler = channel.getSampler();
      if (sourceSampler.getInterpolation() === 'CUBICSPLINE') throw new Error('不支持三次样条插值的动作');

      const output = sourceSampler.getOutput();
      const count = output.getCount();
      let values;
      if (targetPath === 'rotation') {
        const a = multiply(conjugate(globalRest(node.getParentNode())), globalRest(sourceNode.getParentNode()));
        const b = multiply(conjugate(globalRest(sourceNode)), globalRest(node));
        largestCorrection = Math.max(largestCorrection, angleBetween(b, [0, 0, 0, 1]));
        values = new Float32Array(count * 4);
        const q = [0, 0, 0, 1];
        for (let i = 0; i < count; i++) values.set(multiply(multiply(a, output.getElement(i, q)), b), i * 4);
      } else {
        // 位移按两边骨头的长度比例缩放，腿长的人物胯部相应高一些。
        const from = Math.hypot(...sourceNode.getTranslation());
        const ratio = from > 1e-6 ? Math.hypot(...node.getTranslation()) / from : 1;
        const parentDifference = angleBetween(globalRest(node.getParentNode()), globalRest(sourceNode.getParentNode()));
        if (parentDifference > 0.1) throw new Error(`${name} 的父骨头朝向不同，位移不能直接照搬`);
        values = new Float32Array(count * 3);
        const p = [0, 0, 0];
        for (let i = 0; i < count; i++) {
          output.getElement(i, p);
          values.set([p[0] * ratio, p[1] * ratio, p[2] * ratio], i * 3);
        }
      }

      const sampler = doc
        .createAnimationSampler()
        .setInterpolation(sourceSampler.getInterpolation())
        .setInput(
          doc.createAccessor().setType('SCALAR').setArray(Float32Array.from(sourceSampler.getInput().getArray())).setBuffer(buffer),
        )
        .setOutput(
          doc
            .createAccessor()
            .setType(targetPath === 'rotation' ? 'VEC4' : 'VEC3')
            .setArray(values)
            .setBuffer(buffer),
        );
      animation
        .addSampler(sampler)
        .addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(targetPath).setSampler(sampler));
    }
  }
  if (missing.size > 0) throw new Error(`动作库里没有这些动作：${[...missing].join('、')}`);
  return largestCorrection;
}

// ---------- 组装 ----------

async function buildCharacter(spec, animationSource) {
  const doc = await readWithoutTextures(path.join(BODY_DIR, spec.body));
  const root = doc.getRoot();
  doc.createExtension(EXTTextureWebP).setRequired(true);

  const texture = async (name, file, size) =>
    doc.createTexture(name).setImage(await webp(file, size)).setMimeType('image/webp');
  const material = (name, map) => {
    const m = doc.createMaterial(name).setRoughnessFactor(0.85).setMetallicFactor(0);
    if (map) m.setBaseColorTexture(map);
    if (CLOTH_COLORS[name]) m.setBaseColorFactor(CLOTH_COLORS[name]);
    return m;
  };
  const materials = {
    Skin: material('Skin', await texture('Skin', path.join(SKIN_DIR, spec.skin), SKIN_TEXTURE_SIZE)),
    Shirt: material('Shirt'),
    Pants: material('Pants'),
    Boots: material('Boots'),
    Hair: material('Hair', await texture('Hair', path.join(HAIR_DIR, spec.hairTexture), HAIR_TEXTURE_SIZE)),
    Eyes: material('Eyes', await texture('Eyes', path.join(SKIN_DIR, 'T_Eye_Brown.png'), EYE_TEXTURE_SIZE)),
  };

  let foundBody = false;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) {
        if (!KEPT_ATTRIBUTES.has(semantic)) primitive.setAttribute(semantic, null);
      }
    }
    const [primitive] = mesh.listPrimitives();
    const original = primitive.getMaterial().getName();
    let name;
    if (original.startsWith('MI_Superhero')) {
      name = 'Body';
      splitBody(doc, mesh, materials);
      foundBody = true;
    } else if (original.startsWith('MI_Hair')) {
      name = 'Eyebrows';
      primitive.setMaterial(materials.Hair);
    } else if (original === 'MI_Eyes') {
      name = 'Eyes';
      primitive.setMaterial(materials.Eyes);
    } else {
      throw new Error(`没见过的材质 ${original}`);
    }
    mesh.setName(name);
    for (const parent of mesh.listParents()) if (parent.propertyType === PropertyType.NODE) parent.setName(name);
  }
  if (!foundBody) throw new Error('没有找到身体的模型');

  await attachHair(doc, path.join(HAIR_DIR, spec.hair), materials.Hair);
  addWeaponSocket(doc);
  const largestCorrection = copyAnimations(doc, animationSource);

  await doc.transform(
    resample(),
    // 挂武器的节点是空的，默认会被当成没用的东西清掉。
    prune({ keepLeaves: true }),
    // 材质不合并：上衣、裤子、鞋要各自换色。
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE] }),
    // 位置保持原样，其余属性压成整数，文件更小。
    quantize({ pattern: /^(NORMAL|TEXCOORD_\d+|WEIGHTS_\d+)$/ }),
  );

  const bytes = await io.writeBinary(doc);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, spec.out), bytes);
  console.log(`${spec.out}  ${(bytes.byteLength / 1024).toFixed(0)} KB，动作按站立姿势最多修正了 ${largestCorrection.toFixed(1)}°`);
}

const animationSource = await io.read(ANIMATIONS);
for (const spec of CHARACTERS) await buildCharacter(spec, animationSource);
