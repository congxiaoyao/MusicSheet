// Step 4 验证:编辑 → 落盘(3 秒防抖) → 磁盘有该小节内容。
// 启动 server + vite,驱动浏览器编辑一个音,等待落盘,直接读磁盘文件验证。
// 用法: 先 `npm run dev`(两个服务都起),再 `node scripts/verify-persist.mjs`
import { launch } from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const VITE_URL = process.argv[2] || 'http://localhost:5173';
const ROOT = path.resolve(import.meta.dirname, '..');
const STORE = path.join(ROOT, 'store', 'pieces');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// 清空 store,确保从干净状态开始
fs.rmSync(STORE, { recursive: true, force: true });

const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1100,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900 });
const consoleErrors = [];
page.on('console', m => { if (m.type()==='error' && !/Failed to load resource|favicon|404|net::ERR/i.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: '+e.message));

console.log('═══ Step 4: 编辑 → 落盘 验证 ═══');
console.log('加载页面(等 initFromServer 自动建默认曲谱)...');
await page.goto(VITE_URL, { waitUntil: 'networkidle0' });
await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
await new Promise(r => setTimeout(r, 1500));  // 等 initFromServer 完成

// 验证1:store 里应有 1 个曲谱目录
const pieceDirs = fs.existsSync(STORE) ? fs.readdirSync(STORE).filter(d => fs.statSync(path.join(STORE, d)).isDirectory()) : [];
check('服务端自动建了 1 个曲谱', pieceDirs.length === 1, `实际 ${pieceDirs.length} 个`);
const PID = pieceDirs[0];
const pieceDir = path.join(STORE, PID);
const meta0 = JSON.parse(fs.readFileSync(path.join(pieceDir, 'manifest.json'), 'utf8'));
check('默认曲谱 4 小节', meta0.totalMeasures === 4, `totalMeasures=${meta0.totalMeasures}`);

// 验证2:页面无 console 错误
check('页面无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

// 在编辑区点一个音(八分 → 点第一卡 30%,40% 位置,放一个音)
console.log('\n编辑:点一个音(八分时值)...');
await page.keyboard.press('4'); // 八分
await new Promise(r => setTimeout(r, 100));
await page.evaluate(() => {
  const h = document.querySelectorAll('.svg-host')[0];
  if (!h) return;
  const r = h.getBoundingClientRect();
  const x = r.left + r.width * 0.3, y = r.top + r.height * 0.4;
  const f = (t) => h.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, bubbles: true }));
  f('mousedown'); f('mouseup'); f('click');
});
await new Promise(r => setTimeout(r, 300));

// 验证3:此时磁盘 m0001.json 应仍为空(3 秒防抖还没到)
const m1before = JSON.parse(fs.readFileSync(path.join(pieceDir, 'm0001.json'), 'utf8'));
check('编辑后未到 3 秒 → 磁盘 m0001 仍空(防抖)', m1before.treble.length === 0, `treble 有 ${m1before.treble.length} 音`);

// 验证4:等 3.5 秒,磁盘 m0001.json 应有 1 个音
console.log('等 3.5 秒(防抖落盘)...');
await new Promise(r => setTimeout(r, 3500));
const m1after = JSON.parse(fs.readFileSync(path.join(pieceDir, 'm0001.json'), 'utf8'));
check('3 秒后磁盘 m0001 有 1 个音(局部落盘)', m1after.treble.length === 1, `treble 有 ${m1after.treble.length} 音`);
check('落盘音的 midi 合法', m1after.treble.length === 1 && typeof m1after.treble[0].midi === 'number', JSON.stringify(m1after.treble[0]));

// 验证5:其它小节(m0002~m0004)仍为空
const others = [2, 3, 4].map(n => {
  const m = JSON.parse(fs.readFileSync(path.join(pieceDir, `m${String(n).padStart(4, '0')}.json`), 'utf8'));
  return m.treble.length + m.bass.length;
});
check('其它小节(m0002~4)仍为 0 音(局部,未动)', others.every(x => x === 0), JSON.stringify(others));

// 验证6:刷新页面 → 数据从服务端恢复(跨会话持久化)
console.log('\n刷新页面,验证持久化恢复...');
await page.reload({ waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1500));
const noteCountAfterReload = await page.evaluate(() => {
  // data-idx 同时出现在五线谱符头和简谱元素上(一个音两处),去重统计独立 idx。
  const idxs = new Set();
  document.querySelectorAll('.svg-host [data-idx]').forEach(el => idxs.add(el.getAttribute('data-idx')));
  return idxs.size;
});
check('刷新后编辑区恢复 1 个音', noteCountAfterReload === 1, `恢复 ${noteCountAfterReload} 个独立音符 idx`);

await browser.close();

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
