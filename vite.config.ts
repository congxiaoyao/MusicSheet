import { defineConfig } from 'vite';

// 整曲存储服务器端口(与 server/index.mjs 一致)。
const API_PORT = process.env.PORT || '4173';
const API_TARGET = `http://localhost:${API_PORT}`;

export default defineConfig({
  base: './',
  server: {
    host: true, port: 5173, open: true,
    // 开发时把 /api 代理到 Node 存储服务器(前端代码统一用相对路径 /api/...)。
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: { target: 'es2021', sourcemap: false },
});
