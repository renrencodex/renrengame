// 把 Quaternius 的道具素材处理成游戏里地上的物品模型。
//
// 用法：
//   node build-items.mjs <素材目录> [输出目录]
//
// <素材目录> 里要有这个解压后的文件夹（CC0 授权，来源见 README）：
//   Fantasy Props MegaKit[Standard]/
//
// 输出 item_gold.glb、item_potion.glb 和 item_sword.glb。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { dedup, prune, quantize } from '@gltf-transform/functions';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = process.argv[2];
const outDir = process.argv[3] ?? path.join(here, '../../packages/client/public/models');
if (!sourceDir) {
  console.error('用法：node build-items.mjs <素材目录> [输出目录]');
  process.exit(1);
}

const MODEL_DIR = path.join(sourceDir, 'Fantasy Props MegaKit[Standard]/Exports/glTF');

/** 文件名里的物品名要和 shared/items.ts 里的 ItemId 一致，客户端按 item_<物品名>.glb 加载。 */
const ITEMS = [
  { out: 'item_gold.glb', source: 'Coin_Pile.gltf', metallic: 0.6, roughness: 0.35 },
  { out: 'item_potion.glb', source: 'Potion_2.gltf', metallic: 0, roughness: 0.3 },
  // 剑同时也是拿在手里的模型：剑身沿 Y 轴朝上，原点在握柄上。
  { out: 'item_sword.glb', source: 'Sword_Bronze.gltf', metallic: 0.6, roughness: 0.4 },
];

const KEPT_ATTRIBUTES = new Set(['POSITION', 'NORMAL', 'COLOR_0']);

const io = new NodeIO();

/**
 * 读入一个 .gltf 文件，但不读贴图。
 * 这些道具的颜色在顶点色里，贴图只是一层灰色的磨损细节，物品在游戏里很小，看不出来，
 * 不带贴图每个文件只有十几 KB。
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

async function buildItem(spec) {
  const doc = await readWithoutTextures(path.join(MODEL_DIR, spec.source));
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  if (meshes.length !== 1) throw new Error(`${spec.source} 里应该只有一个模型，实际有 ${meshes.length} 个`);

  // 换成一个不带贴图的材质，颜色全靠顶点色。客户端加载后还会按物品再调一次亮度。
  const material = doc
    .createMaterial('Item')
    .setMetallicFactor(spec.metallic)
    .setRoughnessFactor(spec.roughness)
    .setDoubleSided(true);
  let triangles = 0;
  for (const primitive of meshes[0].listPrimitives()) {
    if (!primitive.getAttribute('COLOR_0')) throw new Error(`${spec.source} 没有顶点色`);
    for (const semantic of primitive.listSemantics()) {
      if (!KEPT_ATTRIBUTES.has(semantic)) primitive.setAttribute(semantic, null);
    }
    primitive.setMaterial(material);
    triangles += primitive.getIndices().getCount() / 3;
  }
  meshes[0].setName('Item');
  for (const node of root.listNodes()) {
    if (node.getMesh()) node.setName('Item');
    // 模型的原点在底面中心，放到地上不需要再调整。这里确认没有额外的位移和缩放。
    if (node.getTranslation().some((v) => Math.abs(v) > 1e-6) || node.getScale().some((v) => Math.abs(v - 1) > 1e-6)) {
      throw new Error(`${spec.source} 的节点带位移或缩放`);
    }
  }

  await doc.transform(
    prune(),
    dedup({ propertyTypes: [PropertyType.ACCESSOR] }),
    // 位置保持原样，法线和顶点色压成整数。
    quantize({ pattern: /^(NORMAL|COLOR_\d+)$/ }),
  );

  const bytes = await io.writeBinary(doc);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, spec.out), bytes);
  console.log(`${spec.out}  ${(bytes.byteLength / 1024).toFixed(1)} KB，${triangles} 个三角形`);
}

for (const spec of ITEMS) await buildItem(spec);
