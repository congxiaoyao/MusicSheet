// Step 6 验证:整曲预览弹窗 — 多行渲染 + 五线谱/简谱切换 + 点小节跳转。
// 场景:6 小节曲谱(每行4)→ 开预览 → 应有 2 行 → 切「简谱」→ 验证渲染 → 点第5小节区域 → 跳编辑区。
// 用法: 起 server+vite,`node scripts/verify-preview-modal.mjs http://localhost:5176`
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

console.log('═══ Step 6: 整曲预览弹窗 验证 ═══');
await page.goto(VITE_URL, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1500));

// 加小节到 6(默认4),让预览排成 2 行(每行4)
await page.evaluate(() => document.querySelector('.pb-bookmark-add')?.click());
await new Promise(r => setTimeout(r, 300));
await page.evaluate(() => document.querySelector('.pb-bookmark-add')?.click());
await new Promise(r => setTimeout(r, 400));
const totalM = await page.evaluate(() => document.querySelectorAll('.pb-bookmark:not(.pb-bookmark-add)').length);
check('加到 6 小节', totalM === 6, `${totalM}`);

// 开预览
console.log('开预览弹窗...');
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /预览整曲/.test(b.textContent))?.click());
await new Promise(r => setTimeout(r, 600));

// 验证1:弹窗打开
const overlayOpen = await page.evaluate(() => !!document.querySelector('.fs-modal-overlay.open'));
check('预览弹窗打开', overlayOpen, '');

// 验证2:SVG 渲染,应有 2 行 fs-line(6小节/每行4)
const lineCount = await page.evaluate(() => document.querySelectorAll('.fs-modal-body .fs-line').length);
check('6小节排成 2 行(每行4)', lineCount === 2, `实际 ${lineCount} 行`);

// 验证3:首行 data-line-start=0 count=4,末行 start=4 count=2
const lineData = await page.evaluate(() => {
  const lines = [...document.querySelectorAll('.fs-modal-body .fs-line')];
  return lines.map(l => ({ start: l.getAttribute('data-line-start'), count: l.getAttribute('data-line-count') }));
});
check('首行 start=0 count=4', lineData[0]?.start === '0' && lineData[0]?.count === '4', JSON.stringify(lineData[0]));
check('末行 start=4 count=2', lineData[1]?.start === '4' && lineData[1]?.count === '2', JSON.stringify(lineData[1]));

// 验证4:五线谱+简谱模式(默认 both)下应有 staff-group 和 jianpu-group
const hasStaff = await page.evaluate(() => !!document.querySelector('.fs-modal-body .staff-group'));
const hasJianpu = await page.evaluate(() => !!document.querySelector('.fs-modal-body .jianpu-group'));
check('默认 both 模式:有五线谱+简谱', hasStaff && hasJianpu, `staff=${hasStaff} jianpu=${hasJianpu}`);

// 切到「简谱」
console.log('切到「简谱」...');
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.fs-modal-radio .seg-btn')].find(b => b.textContent.trim() === '简谱');
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 500));
const staffAfterJianpu = await page.evaluate(() => !!document.querySelector('.fs-modal-body .staff-group'));
const jianpuAfterJianpu = await page.evaluate(() => !!document.querySelector('.fs-modal-body .jianpu-group'));
check('切「简谱」后:无五线谱有简谱', !staffAfterJianpu && jianpuAfterJianpu, `staff=${staffAfterJianpu} jianpu=${jianpuAfterJianpu}`);

// 切回 both,然后点末行(第5小节区域)→ 跳编辑区
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.fs-modal-radio .seg-btn')].find(b => b.textContent.trim() === '五线谱+简谱');
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 500));

// 点第5小节:末行(treble组)右半区。末行 start=4 count=2,点右半 → measure=5
console.log('点末行右半(第5小节区域)...');
await page.evaluate(() => {
  const body = document.querySelector('.fs-modal-body');
  const svg = body.querySelector('svg');
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  // 末行大约在 y 下半;x 取右半(contentRight 右侧)。点 y=75%,x=75%。
  const ev = new MouseEvent('click', { clientX: r.left + r.width * 0.75, clientY: r.top + r.height * 0.75, bubbles: true });
  body.dispatchEvent(ev);
});
await new Promise(r => setTimeout(r, 600));

// 验证5:弹窗关闭 + 编辑区跳到第5小节(active 书签=5)
const modalClosed = await page.evaluate(() => !document.querySelector('.fs-modal-overlay.open'));
check('点小节后弹窗关闭', modalClosed, '');
const activeBookmark = await page.evaluate(() => document.querySelector('.pb-bookmark.active')?.textContent?.trim());
check('编辑区跳到第5小节(active=5)', activeBookmark === '5', `active=${activeBookmark}`);

check('页面无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0,3).join(' | '));

await browser.close();
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
