// Step 7 验证:曲谱级导入/导出往返 + 删除曲谱。
// 场景:默认曲谱 → 编辑几个音 → 导出 .mscore(拦截下载) → 新建空曲谱 → 导入 .mscore → 验证恢复。
//       → 删除当前曲谱 → 验证列表减少。
// 用法: 起 server+vite,`node scripts/verify-io.mjs http://localhost:5176`
import { launch } from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const VITE_URL = process.argv[2] || 'http://localhost:5176';
const ROOT = path.resolve(import.meta.dirname, '..');
const STORE = path.join(ROOT, 'store', 'pieces');
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}
fs.rmSync(STORE, { recursive: true, force: true });

const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1200,1000'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 1000 });
const consoleErrors = [];
page.on('console', m => { if (m.type()==='error' && !/Failed to load resource|favicon|404|net::ERR/i.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: '+e.message));

console.log('═══ Step 7: 曲谱级导入/导出 + 删除 验证 ═══');
await page.goto(VITE_URL, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1500));

// 编辑几个音(八分 ×3)
await page.keyboard.press('4'); await new Promise(r => setTimeout(r, 100));
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => {
    const h = document.querySelectorAll('.svg-host')[0];
    if (!h) return;
    const r = h.getBoundingClientRect();
    const f = (t) => h.dispatchEvent(new MouseEvent(t, { clientX: r.left + r.width*0.3, clientY: r.top + r.height*0.4, bubbles: true }));
    f('mousedown'); f('mouseup'); f('click');
  });
  await new Promise(r => setTimeout(r, 200));
}
await new Promise(r => setTimeout(r, 100));

// 等 3.2 秒防抖落盘,确保导出前音符已写盘。
console.log('等 3.2 秒防抖落盘...');
await new Promise(r => setTimeout(r, 3200));

// 导出:直接用页面内 fetch 调 /api(同源,与导出按钮同一端点),避免下载拦截不可靠。
console.log('导出整曲(经 /api)...');
let exportedText = null;
exportedText = await page.evaluate(async () => {
  const sel = document.querySelector('.pb-select');
  const id = sel?.value;
  if (!id) return null;
  const r = await fetch('/api/pieces/' + id + '/export');
  return await r.text();
});
check('导出生成 .mscore 文本', typeof exportedText === 'string' && exportedText.includes('musicsheet-score'), `len=${exportedText?.length}`);
const exportedScore = JSON.parse(exportedText || '{}');
check('导出文本含 3 个音(第1小节)', exportedScore?.score?.measures?.[0]?.treble?.length === 3, `m1.treble=${exportedScore?.score?.measures?.[0]?.treble?.length}`);

// 新建空曲谱
console.log('新建空曲谱...');
await page.evaluate(() => { window.prompt = () => '导入目标'; [...document.querySelectorAll('button')].find(b => /新建/.test(b.textContent))?.click(); });
await new Promise(r => setTimeout(r, 1200));
const noteCountEmpty = await page.evaluate(() => new Set([...document.querySelectorAll('.svg-host [data-idx]')].map(el => el.getAttribute('data-idx'))).size);
check('新建空曲谱后编辑区无音', noteCountEmpty === 0, `${noteCountEmpty} 个`);

// 导入:用导出的文本,走 importScoreText。通过文件 input 不可行(headless),直接调内部方法
// 用一个变通:构造 File 对象触发 input change。这里直接在页面里手动触发 importScoreText 的等价路径:
// 通过拖拽 drop 事件(传一个 File)。
console.log('导入 .mscore(拖拽 File)...');
await page.evaluate(async (text) => {
  const file = new File([text], 'test.mscore', { type: 'application/json' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const app = document.querySelector('.app');
  const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  app.dispatchEvent(ev);
}, exportedText);
await new Promise(r => setTimeout(r, 1500));

// 验证:编辑区恢复 3 个音(导入的曲谱被加载)
const noteCountRestored = await page.evaluate(() => new Set([...document.querySelectorAll('.svg-host [data-idx]')].map(el => el.getAttribute('data-idx'))).size);
check('导入后编辑区恢复 3 个音', noteCountRestored === 3, `${noteCountRestored} 个`);

// 验证:现在有 3 个曲谱(默认1 + 新建1 + 导入1)
const pieceCount = await page.evaluate(() => document.querySelectorAll('.pb-select option').length);
check('曲谱列表现 3 个(默认+新建+导入)', pieceCount === 3, `${pieceCount} 个`);

// 删除当前曲谱(导入的那个)
console.log('删除当前曲谱...');
await page.evaluate(() => { window.confirm = () => true; [...document.querySelectorAll('button')].find(b => b.title === '删除当前曲谱')?.click(); });
await new Promise(r => setTimeout(r, 1000));
const pieceCountAfterDel = await page.evaluate(() => document.querySelectorAll('.pb-select option').length);
check('删除后曲谱列表 2 个', pieceCountAfterDel === 2, `${pieceCountAfterDel} 个`);

check('页面无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0,3).join(' | '));

await browser.close();
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
