import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadStaticFiles, serveStatic } from '../src/static';

const INDEX = '<!doctype html><title>game</title>';
const SCRIPT = `console.log(${JSON.stringify('x'.repeat(4000))});`;
const SECRET = 'DATABASE_URL=secret';

let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  // dist 目录的旁边放一个不该被读到的文件，dist 里再放一个指向它的符号链接。
  root = mkdtempSync(join(tmpdir(), 'static-test-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, 'models'));
  writeFileSync(join(root, '.env'), SECRET);
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), SCRIPT);
  writeFileSync(join(dist, 'models', 'robot.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]));
  symlinkSync(join(root, '.env'), join(dist, 'leak.txt'));

  const files = loadStaticFiles(dist);
  server = createServer((req, res) => {
    if (serveStatic(files, req, res)) return;
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

/** 不经过 fetch 的 URL 规范化，原样发送请求路径。 */
async function rawGet(path: string): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request(`${base}/`, { path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('静态文件', () => {
  it('根路径和 /index.html 都返回入口页面，并且要求浏览器每次确认是否有新版本', async () => {
    for (const path of ['/', '/index.html', '/?from=share']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toBe(INDEX);
    }
  });

  it('带哈希的资源可以长期缓存，支持 gzip 的客户端收到压缩后的内容', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(Number(res.headers.get('content-length'))).toBeLessThan(SCRIPT.length / 2);
    expect(await res.text()).toBe(SCRIPT);
  });

  it('不支持 gzip 的客户端收到原始内容', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'accept-encoding': 'identity' } });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(Number(res.headers.get('content-length'))).toBe(SCRIPT.length);
    expect(await res.text()).toBe(SCRIPT);
  });

  it('子目录里的文件按扩展名返回类型；压缩后没有变小的文件不压缩', async () => {
    const res = await fetch(`${base}/models/robot.glb`, { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toHaveLength(8);
  });

  it('带着上次的 ETag 再请求时返回 304，不重复传内容', async () => {
    const first = await fetch(`${base}/`);
    const etag = first.headers.get('etag') as string;
    expect(etag).toMatch(/^".+"$/);
    const second = await fetch(`${base}/`, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('HEAD 请求只返回头', async () => {
    const res = await fetch(`${base}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('content-length'))).toBe(INDEX.length);
    expect(await res.text()).toBe('');
  });

  it('不存在的路径和 GET、HEAD 以外的方法不处理', async () => {
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/assets/`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(404);
  });

  it('读不到目录外面的文件：路径里的 .. 和符号链接都不起作用', async () => {
    for (const path of [
      '/../.env',
      '/assets/../../.env',
      '/%2e%2e/.env',
      '/..%2f.env',
      '/assets/..%2f..%2f.env',
      '//etc/passwd',
      '/leak.txt',
      '/%',
    ]) {
      const res = await rawGet(path);
      expect(res.status, path).toBe(404);
      expect(res.body).not.toContain(SECRET);
    }
  });

  it('目录里没有 index.html 时启动就报错', () => {
    expect(() => loadStaticFiles(join(root, 'dist', 'assets'))).toThrow('index.html');
    expect(() => loadStaticFiles(join(root, 'missing'))).toThrow();
  });
});
