// 临时调试:日志接收服务(独立端口 4174,不干扰主 server 4173)
// 接收前端 __msLogSave() POST 的日志,落盘到项目根 ms-log.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4174;
const OUT = path.join(process.cwd(), 'ms-log.json');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && req.url === '/ms-log') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
        const n = Array.isArray(data) ? data.length : '?';
        console.log(`[log-sink] 收到 ${n} 条日志,已写入 ${OUT}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: n }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log(`[log-sink] 监听 http://localhost:${PORT}`));
