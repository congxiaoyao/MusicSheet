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

// 测1:拖右把手,选框右缘应跟手(=鼠标x)。用 pointer 事件逐帧读 selRight
const gripR = await page.$('.ms-grip-r');
const gBox = await gripR.boundingBox();
const t5 = await page.evaluate(() => { const b=document.querySelector('.ms-blk[data-idx="5"]'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; });
await page.mouse.move(gBox.x+gBox.width/2, gBox.y+gBox.height/2);
await page.mouse.down();
const trace=[];
for (let i=1;i<=6;i++){
  const mx = gBox.x+gBox.width/2 + (t5.x-(gBox.x+gBox.width/2))*(i/6);
  await page.mouse.move(mx, gBox.y+gBox.height/2);
  await new Promise(r=>setTimeout(r,40));
  const d = await page.evaluate(() => { const w=document.querySelector('.ms-wrap').getBoundingClientRect(); const s=document.querySelector('.ms-sel').getBoundingClientRect(); const b4=document.querySelector('.ms-blk[data-idx="4"]').getBoundingClientRect(); return { selR: Math.round(s.right-w.left), b4cx: Math.round(b4.left+b4.width/2-w.left), b4inside: document.querySelector('.ms-blk[data-idx="4"]').classList.contains('inside') }; });
  trace.push({mx:Math.round(mx), ...d});
}
await page.mouse.up();
console.log('拖右把手(选框右缘应≈鼠标x跟手, idx4越过中心被吸入):');
trace.forEach(t=>console.log(`  mx视口=${t.mx} selR=${t.selR} idx4cx=${t.b4cx} inside=${t.b4inside}`));
await browser.close();
