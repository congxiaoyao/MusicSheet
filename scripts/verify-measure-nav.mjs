// Step 5 验证:小节书签导航 + 加小节 + 切曲谱。
// 场景:默认 4 小节曲谱 → 点书签「3」→ 编辑 → 验证音落进 m0003.json(而非 m0001),m0001/m0002 仍空。
//       → 加小节到 6 → 验证 totalMeasures=6 且书签条出现「6」。→ 新建曲谱 → 验证切换。
// 用法: 先起 server(4173)+vite(5176),再 `node scripts/verify-measure-nav.mjs http://localhost:5176`
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

const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1100,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900 });
const consoleErrors = [];
page.on('console', m => { if (m.type()==='error' && !/Failed to load resource|favicon|404|net::ERR/i.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: '+e.message));

console.log('═══ Step 5: 小节书签导航 验证 ═══');
await page.goto(VITE_URL, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1500));

const pieceDirs = fs.readdirSync(STORE).filter(d => fs.statSync(path.join(STORE, d)).isDirectory());
check('默认建了 1 曲谱', pieceDirs.length === 1, `${pieceDirs.length} 个`);
const PID = pieceDirs[0];
const PDIR = path.join(STORE, PID);
let meta = JSON.parse(fs.readFileSync(path.join(PDIR, 'manifest.json'), 'utf8'));
check('默认 4 小节', meta.totalMeasures === 4, `totalMeasures=${meta.totalMeasures}`);

// 验证1:书签条应有 4 个小节号 + 1 个「+」= 5 个按钮
const bookmarkCount = await page.evaluate(() => document.querySelectorAll('.pb-bookmarks .pb-bookmark:not(.pb-bookmark-add)').length);
check('书签条 4 个小节号(默认4小节)', bookmarkCount === 4, `实际 ${bookmarkCount}`);

// 点书签「3」(第3小节,0-based=2)
console.log('\n点书签「3」...');
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.pb-bookmark')].find(b => b.textContent.trim() === '3');
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 400));

// 验证2:书签「1」「2」不再 active,「3」active(编辑区起始=第3小节)
const activeBookmark = await page.evaluate(() => document.querySelector('.pb-bookmark.active')?.textContent?.trim());
check('点「3」后 active=3', activeBookmark === '3', `active=${activeBookmark}`);

// 编辑:八分 → 点编辑区放一个音
await page.keyboard.press('4'); await new Promise(r => setTimeout(r, 100));
await page.evaluate(() => {
  const h = document.querySelectorAll('.svg-host')[0];
  if (!h) return;
  const r = h.getBoundingClientRect();
  const f = (t) => h.dispatchEvent(new MouseEvent(t, { clientX: r.left + r.width*0.3, clientY: r.top + r.height*0.4, bubbles: true }));
  f('mousedown'); f('mouseup'); f('click');
});
await new Promise(r => setTimeout(r, 300));

// 等 3 秒防抖落盘
console.log('等 3.2 秒落盘...');
await new Promise(r => setTimeout(r, 3200));

// 验证3:磁盘 m0003.json 有 1 音,m0001/m0002 仍空(关键:导航后音进了正确小节)
const m1 = JSON.parse(fs.readFileSync(path.join(PDIR, 'm0001.json'), 'utf8'));
const m2 = JSON.parse(fs.readFileSync(path.join(PDIR, 'm0002.json'), 'utf8'));
const m3 = JSON.parse(fs.readFileSync(path.join(PDIR, 'm0003.json'), 'utf8'));
check('导航到第3小节编辑 → 音落进 m0003', m3.treble.length === 1, `m0003.treble=${m3.treble.length}`);
check('m0001 仍空(未误改)', m1.treble.length === 0, `m0001.treble=${m1.treble.length}`);
check('m0002 仍空(未误改)', m2.treble.length === 0, `m0002.treble=${m2.treble.length}`);

// 点「+」加小节两次 → 6 小节
console.log('\n点「+」加小节(2次)...');
await page.evaluate(() => {
  const add = document.querySelector('.pb-bookmark-add');
  if (add) add.click();
});
await new Promise(r => setTimeout(r, 400));
await page.evaluate(() => {
  const add = document.querySelector('.pb-bookmark-add');
  if (add) add.click();
});
await new Promise(r => setTimeout(r, 400));
meta = JSON.parse(fs.readFileSync(path.join(PDIR, 'manifest.json'), 'utf8'));
check('加 2 小节后 totalMeasures=6', meta.totalMeasures === 6, `totalMeasures=${meta.totalMeasures}`);
const bookmarkCount6 = await page.evaluate(() => document.querySelectorAll('.pb-bookmarks .pb-bookmark:not(.pb-bookmark-add)').length);
check('书签条现 6 个小节号', bookmarkCount6 === 6, `实际 ${bookmarkCount6}`);
check('磁盘 m0005/m0006 文件存在', fs.existsSync(path.join(PDIR,'m0005.json')) && fs.existsSync(path.join(PDIR,'m0006.json')), '');

// 新建曲谱
console.log('\n新建曲谱...');
await page.evaluate(() => {
  // 拦截 prompt,返回标题
  window.prompt = () => '第二首';
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新建'));
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 1500));
const pieceDirs2 = fs.readdirSync(STORE).filter(d => fs.statSync(path.join(STORE, d)).isDirectory());
check('新建后 2 个曲谱', pieceDirs2.length === 2, `${pieceDirs2.length} 个`);
const selectVal = await page.evaluate(() => document.querySelector('.pb-select')?.value);
const selectText = await page.evaluate(() => document.querySelector('.pb-select option:checked')?.textContent);
check('下拉选中「第二首」', selectText === '第二首', `选中=${selectText}`);

check('页面无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0,3).join(' | '));

await browser.close();
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
