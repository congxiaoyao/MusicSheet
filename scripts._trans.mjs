import { launch } from 'puppeteer-core';
const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1300,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 900 });
await page.goto('http://localhost:5173/library-demo.html', { waitUntil: 'networkidle0' });
await page.evaluate(() => { window.confirm = () => true; });
await new Promise(r => setTimeout(r, 2500));
await page.evaluate(() => [...document.querySelectorAll('.score-card:not(.new-card)')][0]?.click());
await new Promise(r => setTimeout(r, 1500));
const cur = () => page.evaluate(() => document.querySelectorAll('.ms-blk:not(.ms-leave)').length);
while (await cur() > 1) { await page.evaluate(() => { const b=[...document.querySelectorAll('.ms-blk')].pop(); b.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); b.querySelector('.ms-del')?.click(); }); await new Promise(r=>setTimeout(r,70)); }
while (await cur() < 8) { await page.evaluate(() => document.querySelector('.ms-add')?.click()); await new Promise(r=>setTimeout(r,50)); }
await new Promise(r=>setTimeout(r,400));
await page.evaluate(() => window.__ms.setSelection(2, 2));
await new Promise(r => setTimeout(r, 600));
// 不用真实拖拽,直接模拟:apply(false,override) 然后 apply(true),看 transition
// 先用 setSelection 到一个状态,然后手动触发拖拽覆盖再释放
// 简化:直接调组件内部不行。用真实拖拽但密集采样 transform 值(读 style.transform 而非 rect)
const gripR = await page.$('.ms-grip-r');
const gBox = await gripR.boundingBox();
const t6 = await page.evaluate(() => { const b=document.querySelector('.ms-blk[data-idx="6"]'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; });
await page.mouse.move(gBox.x+gBox.width/2, gBox.y+gBox.height/2);
await page.mouse.down();
await page.mouse.move(t6.x, gBox.y+gBox.height/2);
await new Promise(r=>setTimeout(r,300));
const before = await page.evaluate(() => { const s=document.querySelector('.ms-sel'); return { tx: s.style.transform, w: s.style.width, trans: s.style.transition }; });
console.log('拖拽中 sel:', JSON.stringify(before));
await page.mouse.up();
// 抬手后读 style(非 rect),看 transform/width/transition 字符串变化
for (const ms of [0,16,40,80,160,300]) {
  await new Promise(r=>setTimeout(r, ms===0?1:ms-(arguments_?.last||0)));
  const d = await page.evaluate(() => { const s=document.querySelector('.ms-sel'); return { tx: s.style.transform, w: s.style.width, trans: s.style.transition.slice(0,15), rect: Math.round(s.getBoundingClientRect().right) }; });
  console.log(`~${ms}ms: tx=${d.tx} w=${d.w} trans="${d.trans}" rectR=${d.rect}`);
}
await browser.close();
