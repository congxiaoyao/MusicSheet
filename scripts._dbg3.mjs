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
const gripR = await page.$('.ms-grip-r');
const gBox = await gripR.boundingBox();
const t6 = await page.evaluate(() => { const b=document.querySelector('.ms-blk[data-idx="6"]'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; });
await page.mouse.move(gBox.x+gBox.width/2, gBox.y+gBox.height/2);
await page.mouse.down();
await page.mouse.move(t6.x, gBox.y+gBox.height/2);
await new Promise(r=>setTimeout(r,200));
await page.mouse.up();
const seq=[];
for (const ms of [16,40,80,160]) {
  await new Promise(r=>setTimeout(r, ms-(seq.length?seq[seq.length-1].ms:0)));
  seq.push({ms, trans: await page.evaluate(() => document.querySelector('.ms-sel').style.transition.slice(0,12)), r: await page.evaluate(()=>Math.round(document.querySelector('.ms-sel').getBoundingClientRect().right))});
}
seq.forEach(s=>console.log(`+${s.ms}ms trans="${s.trans}" r=${s.r}`));
await browser.close();
