// MusicSheet 整曲存储服务器 —— 轻量 Node LAN 服务器(无框架,vanilla http)。
//
// 用途:跨设备共享曲谱(笔记本编辑 / pad·电视查看)。绑定 0.0.0.0,局域网任一设备
// 访问 http://<笔记本IP>:<port>。曲谱按小节存盘,支持单小节局部覆写(硬指标)。
//
// 存储(store/pieces/<id>/):
//   manifest.json  { id,title,key,time,totalMeasures,viewMode,updatedAt }
//   m0001.json     { treble:[...], bass:[...] }   ← 每小节一文件
//   m0002.json ...
//
// 端点:
//   GET    /api/pieces                 列所有曲谱 meta
//   POST   /api/pieces                 建新曲谱  body: {title,key,time,totalMeasures,viewMode}
//   GET    /api/pieces/:id             读整曲 Score
//   PUT    /api/pieces/:id/meta        改 meta(改 time/totalMeasures 时重建/截断小节)
//   PUT    /api/pieces/:id/measures/:n 单小节局部覆写  body: {treble,bass}   ← 核心
//   DELETE /api/pieces/:id             删整曲
//   GET    /api/pieces/:id/export      导出整曲打包(.mscore 文本)
//   POST   /api/pieces/:id/import      整曲打包导入  body: .mscore 文本
//   GET    /api/lan-ip                 列本机局域网 IP(供 UI 展示访问地址)
//
// 复用 src/core/serialize.ts 的校验(Note/Key/Time/Measure/Meta/Score 验证),
// 保证落盘数据合法。Node 23 原生 type-stripping 直接 import .ts。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  validateMeasure, validateMeta, validateScore,
} from './validate.mjs';

// 小节文件名(m{4位}.json,零填充便于目录排序)。与 src/core/serialize.ts 的 measureFileName 同源。
function measureFileName(measureIndex0Based) {
  return 'm' + String(measureIndex0Based + 1).padStart(4, '0') + '.json';
}
function emptyMeasure() { return { treble: [], bass: [] }; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'store');
const PIECES_DIR = path.join(STORE_DIR, 'pieces');
const DIST_DIR = path.join(ROOT, 'dist');
const PORT = parseInt(process.env.PORT || '4173', 10);
const HOST = '0.0.0.0';

// 确保存储目录存在
fs.mkdirSync(PIECES_DIR, { recursive: true });

// ── 工具 ──────────────────────────────────────────────────

/** 原子写:先写临时文件再 rename,防半写损坏。 */
function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** 读取 JSON 并解析,文件不存在返回 null。 */
function readJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 生成曲谱 id:时间戳 + 随机后缀,保证目录名唯一且可排序。 */
function newId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `p-${ts}-${rnd}`;
}

/** 读取某曲谱的 manifest.json(不存在返回 null)。 */
function readManifest(pieceId) {
  return readJson(path.join(PIECES_DIR, pieceId, 'manifest.json'));
}

/** 读整曲 Score = manifest + 所有小节文件(缺失小节补空)。 */
function readScore(pieceId) {
  const meta = readManifest(pieceId);
  if (!meta) return null;
  const measures = [];
  for (let i = 0; i < meta.totalMeasures; i++) {
    const file = path.join(PIECES_DIR, pieceId, measureFileName(i));
    let m = null;
    try {
      const text = fs.readFileSync(file, 'utf8');
      m = validateMeasure(JSON.parse(text), i);
    } catch {
      m = emptyMeasure();
    }
    measures.push(m);
  }
  return { meta, measures };
}

/** 列出所有曲谱的 meta(按 updatedAt 降序)。目录不存在(被清空)时返回空列表。 */
function listMetas() {
  if (!fs.existsSync(PIECES_DIR)) {
    fs.mkdirSync(PIECES_DIR, { recursive: true });
    return [];
  }
  const entries = fs.readdirSync(PIECES_DIR, { withFileTypes: true });
  const metas = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = readManifest(e.name);
    if (m) metas.push(m);
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return metas;
}

/** 读取请求体(文本)。 */
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 发 JSON 响应。 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/** 发错误(中文 message)。 */
function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** MIME 类型(静态托管 dist 用)。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── 请求路由 ──────────────────────────────────────────────

/** 处理 /api/* 路由。返回 true 表示已处理。 */
async function handleApi(req, res, method, urlPath, query) {
  if (!urlPath.startsWith('/api/')) return false;

  // GET /api/lan-ip
  if (method === 'GET' && urlPath === '/api/lan-ip') {
    const ips = getLanIps();
    sendJson(res, 200, { ips, port: PORT });
    return true;
  }

  // GET /api/pieces
  if (method === 'GET' && urlPath === '/api/pieces') {
    sendJson(res, 200, { pieces: listMetas() });
    return true;
  }

  // POST /api/pieces
  if (method === 'POST' && urlPath === '/api/pieces') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendError(res, 400, '请求体不是有效 JSON'), true; }
    try {
      const id = newId();
      const now = Date.now();
      // 构造完整 meta(补默认值 + 校验通过 deserializeMeta)
      const metaRaw = {
        id,
        title: typeof body.title === 'string' ? body.title : '未命名',
        key: body.key || { name: 'C', tonic: 0, sharps: [], flats: [] },
        time: body.time || { num: 4, den: 4 },
        totalMeasures: typeof body.totalMeasures === 'number' ? body.totalMeasures : 4,
        viewMode: body.viewMode || 'treble',
        updatedAt: now,
      };
      const meta = validateMeta(metaRaw);
      const pieceDir = path.join(PIECES_DIR, id);
      atomicWrite(path.join(pieceDir, 'manifest.json'), JSON.stringify(meta, null, 2));
      // 初始化所有小节为空
      for (let i = 0; i < meta.totalMeasures; i++) {
        atomicWrite(path.join(pieceDir, measureFileName(i)), JSON.stringify(emptyMeasure()));
      }
      sendJson(res, 201, meta);
    } catch (err) {
      sendError(res, 400, '建曲谱失败: ' + err.message);
    }
    return true;
  }

  // 子路由:/api/pieces/:id/...
  const m = urlPath.match(/^\/api\/pieces\/([^/]+)(\/.*)?$/);
  if (!m) {
    sendError(res, 404, '未知 API: ' + urlPath);
    return true;
  }
  const id = decodeURIComponent(m[1]);
  const sub = m[2] || '';

  // 确认曲谱存在
  const manifest = readManifest(id);
  if (!manifest) {
    sendError(res, 404, '曲谱不存在: ' + id);
    return true;
  }

  // GET /api/pieces/:id
  if (method === 'GET' && sub === '') {
    const score = readScore(id);
    if (!score) return sendError(res, 500, '读取曲谱失败'), true;
    sendJson(res, 200, score);
    return true;
  }

  // DELETE /api/pieces/:id
  if (method === 'DELETE' && sub === '') {
    try { fs.rmSync(path.join(PIECES_DIR, id), { recursive: true, force: true }); }
    catch (err) { return sendError(res, 500, '删除失败: ' + err.message), true; }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // PUT /api/pieces/:id/meta
  if (method === 'PUT' && sub === '/meta') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendError(res, 400, '请求体不是有效 JSON'), true; }
    try {
      // 合并:保留 id,允许改 title/key/time/totalMeasures/viewMode,刷新 updatedAt
      const merged = {
        ...manifest,
        title: typeof body.title === 'string' ? body.title : manifest.title,
        key: body.key || manifest.key,
        time: body.time || manifest.time,
        totalMeasures: typeof body.totalMeasures === 'number' ? body.totalMeasures : manifest.totalMeasures,
        viewMode: body.viewMode || manifest.viewMode,
        updatedAt: Date.now(),
      };
      const newMeta = validateMeta(merged);
      const pieceDir = path.join(PIECES_DIR, id);
      const oldTotal = manifest.totalMeasures;
      const newTotal = newMeta.totalMeasures;
      // 扩容:补空小节文件
      if (newTotal > oldTotal) {
        for (let i = oldTotal; i < newTotal; i++) {
          atomicWrite(path.join(pieceDir, measureFileName(i)), JSON.stringify(emptyMeasure()));
        }
      }
      // 截断:删多余小节文件
      if (newTotal < oldTotal) {
        for (let i = newTotal; i < oldTotal; i++) {
          try { fs.unlinkSync(path.join(pieceDir, measureFileName(i))); } catch { /* ignore */ }
        }
      }
      atomicWrite(path.join(pieceDir, 'manifest.json'), JSON.stringify(newMeta, null, 2));
      sendJson(res, 200, newMeta);
    } catch (err) {
      sendError(res, 400, '改 meta 失败: ' + err.message);
    }
    return true;
  }

  // PUT /api/pieces/:id/measures/:n  ← 单小节局部覆写(硬指标)
  const mm = sub.match(/^\/measures\/(\d+)$/);
  if (method === 'PUT' && mm) {
    const n = parseInt(mm[1], 10);   // 0-based
    if (n < 0 || n >= manifest.totalMeasures) {
      sendError(res, 400, `小节序号越界: ${n}(共 ${manifest.totalMeasures} 小节)`);
      return true;
    }
    let bodyText;
    try { bodyText = await readBody(req); }
    catch (err) { return sendError(res, 400, '读取请求体失败: ' + err.message), true; }
    try {
      const m = validateMeasure(JSON.parse(bodyText), n);   // 校验 Note 结构
      atomicWrite(path.join(PIECES_DIR, id, measureFileName(n)), JSON.stringify(m));
      // 更新 manifest.updatedAt(改小节也算更新)
      const updatedMeta = { ...manifest, updatedAt: Date.now() };
      atomicWrite(path.join(PIECES_DIR, id, 'manifest.json'), JSON.stringify(updatedMeta, null, 2));
      sendJson(res, 200, { ok: true, updatedAt: updatedMeta.updatedAt });
    } catch (err) {
      sendError(res, 400, '写小节失败: ' + err.message);
    }
    return true;
  }

  // GET /api/pieces/:id/export  → 整曲打包文本(.mscore)
  //  格式与 src/core/serialize.ts 的 serializeScore 一致:
  //  { format:'musicsheet-score', version:1, exportedAt:<ms>, score:{meta,measures} }
  if (method === 'GET' && sub === '/export') {
    const score = readScore(id);
    if (!score) return sendError(res, 500, '读取曲谱失败'), true;
    const file = {
      format: 'musicsheet-score', version: 1, exportedAt: Date.now(),
      score: { meta: score.meta, measures: score.measures },
    };
    const text = JSON.stringify(file, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(score.meta.title || id)}.mscore"`,
      'Cache-Control': 'no-store',
    });
    res.end(text);
    return true;
  }

  // POST /api/pieces/:id/import  ← 整曲打包导入(覆盖该曲谱)
  if (method === 'POST' && sub === '/import') {
    let bodyText;
    try { bodyText = await readBody(req); }
    catch (err) { return sendError(res, 400, '读取请求体失败: ' + err.message), true; }
    try {
      const file = JSON.parse(bodyText);
      if (!file || file.format !== 'musicsheet-score') {
        throw new Error('不是 MusicSheet 整曲文件(musicsheet-score)');
      }
      if (file.version !== 1) throw new Error(`不支持的整曲版本 v${file.version}`);
      const { meta, measures } = validateScore(file.score);
      // 保留当前 id 与目录,只覆盖内容(导入到既有曲谱)
      const newMeta = { ...meta, id, updatedAt: Date.now() };
      const pieceDir = path.join(PIECES_DIR, id);
      // 先清旧小节文件,再按新 totalMeasures 重写
      const oldFiles = fs.readdirSync(pieceDir).filter(f => /^m\d+\.json$/.test(f));
      for (const f of oldFiles) { try { fs.unlinkSync(path.join(pieceDir, f)); } catch { /* ignore */ } }
      atomicWrite(path.join(pieceDir, 'manifest.json'), JSON.stringify(newMeta, null, 2));
      for (let i = 0; i < newMeta.totalMeasures; i++) {
        atomicWrite(path.join(pieceDir, measureFileName(i)), JSON.stringify(measures[i]));
      }
      sendJson(res, 200, newMeta);
    } catch (err) {
      sendError(res, 400, '导入失败: ' + err.message);
    }
    return true;
  }

  sendError(res, 404, '未知 API: ' + method + ' ' + urlPath);
  return true;
}

/** 静态托管 dist/(生产:打包后单进程既服务 API 又服务前端)。 */
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // SPA 回退:无扩展名且非文件 → index.html
  let filePath = path.join(DIST_DIR, rel);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // 尝试加 .html
    if (!path.extname(rel)) {
      filePath = path.join(DIST_DIR, rel + '.html');
      if (!fs.existsSync(filePath)) filePath = path.join(DIST_DIR, 'index.html');
    }
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

/** 获取本机局域网 IPv4 地址(排除内回环)。 */
function getLanIps() {
  const ifs = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
    }
  }
  return ips;
}

// ── 启动 ──────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS 预检(局域网跨设备访问需要)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = urlObj.pathname;
  const method = req.method;
  try {
    const handled = await handleApi(req, res, method, urlPath, urlObj.searchParams);
    if (!handled) serveStatic(req, res, urlPath);
  } catch (err) {
    console.error('[server] 未捕获错误:', err);
    if (!res.headersSent) sendError(res, 500, '服务器内部错误: ' + err.message);
  }
});

server.listen(PORT, HOST, () => {
  const ips = getLanIps();
  console.log('═════════════════════════════════════════════');
  console.log('  MusicSheet 整曲存储服务器已启动');
  console.log('═════════════════════════════════════════════');
  console.log(`  本机访问:    http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`  局域网访问:  http://${ip}:${PORT}   ← pad/电视 用这个`);
  }
  if (ips.length === 0) console.log('  (未检测到局域网 IP,仅本机可访问)');
  console.log(`  存储目录:    ${PIECES_DIR}`);
  console.log(`  静态目录:    ${DIST_DIR}${fs.existsSync(DIST_DIR) ? '' : ' (未构建,开发时由 Vite 提供)'}`);
  console.log('═════════════════════════════════════════════');
});
