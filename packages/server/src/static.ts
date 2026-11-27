import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

interface StaticFile {
  body: Buffer;
  /** gzip 压缩后的内容。不值得压缩的文件为 null。 */
  gzip: Buffer | null;
  type: string;
  etag: string;
  /** 文件名里带内容哈希，内容永远不变，浏览器可以一直缓存。 */
  immutable: boolean;
}

/** 请求路径（比如 `/assets/index-abc.js`）到文件内容的映射。 */
export type StaticFiles = ReadonlyMap<string, StaticFile>;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};
/** 这些类型压缩后明显变小；图片、字体本身已经压缩过，不用再压。 */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.map', '.txt', '.svg', '.glb', '.wasm']);
/** Vite 构建时把带内容哈希的文件放在这个目录下。 */
const HASHED_PREFIX = '/assets/';

/**
 * 把构建好的客户端（packages/client/dist）整个读进内存。
 *
 * 文件只有几个、加起来一两兆，启动时读一次就够了。请求来了直接按路径查表，
 * 不会根据请求去拼文件系统路径，所以不存在用 `..` 读到目录外面的问题。
 */
export function loadStaticFiles(dir: string): StaticFiles {
  const files = new Map<string, StaticFile>();
  const walk = (current: string, urlPrefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, `${urlPrefix}${entry.name}/`);
      } else if (entry.isFile()) {
        const url = `${urlPrefix}${entry.name}`;
        const ext = extname(entry.name).toLowerCase();
        const body = readFileSync(fullPath);
        const compressed = COMPRESSIBLE.has(ext) ? gzipSync(body, { level: 9 }) : null;
        files.set(url, {
          body,
          gzip: compressed && compressed.length < body.length * 0.9 ? compressed : null,
          type: CONTENT_TYPES[ext] ?? 'application/octet-stream',
          etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
          immutable: url.startsWith(HASHED_PREFIX),
        });
      }
    }
  };
  walk(dir, '/');

  const index = files.get('/index.html');
  if (!index) throw new Error(`${dir} 里没有 index.html，请先执行 pnpm build。`);
  files.set('/', index);
  return files;
}

/** 请求的是已知的静态文件时把它发回去并返回 true，否则什么都不做、返回 false。 */
export function serveStatic(files: StaticFiles, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let path: string;
  try {
    path = decodeURIComponent((req.url ?? '').split('?', 1)[0]);
  } catch {
    return false;
  }
  const file = files.get(path);
  if (!file) return false;

  const headers: Record<string, string | number> = {
    'content-type': file.type,
    etag: file.etag,
    // 入口页面每次都要问一下有没有新版本，否则发版后玩家还在用旧的页面。
    'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (file.gzip) headers.vary = 'accept-encoding';

  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const useGzip = file.gzip !== null && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const body = useGzip ? (file.gzip as Buffer) : file.body;
  if (useGzip) headers['content-encoding'] = 'gzip';
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
