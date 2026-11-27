import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // 通过远程预览域名访问开发服务器时需要放行；前导点表示匹配所有子域名。
    allowedHosts: ['.preview.renrencodex.com'],
    proxy: {
      // 游戏服务器默认监听 8080，见 packages/shared/src/constants.ts 的 SERVER_PORT。
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': { target: 'http://localhost:8080' },
    },
  },
  build: {
    target: 'es2022',
    // three.js 压缩后就有 600 多 KB，把提示阈值调到它之上。
    chunkSizeWarningLimit: 800,
  },
});
