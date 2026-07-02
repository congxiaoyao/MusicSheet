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
// 用户说"先选到2"——可能是 start=0,count=2([1,2])? 或 count=2 选到第2个?
// 试 start=2,count=1(选第3个=idx2)
await page.evaluate(() => window.__ms.setSelection(2, 1));
await new Promise(r=>setTimeout(r,500));
const snap = () => page.evaluate(() => { const w=document.querySelector('.ms-wrap').getBoundingClientRect(); const s=document.querySelector('.ms-sel').getBoundingClientRect(); const sb=document.querySelector('.ms-sel-border').getBoundingClientRect(); return {selL:Math.round(s.left-w.left),selR:Math.round(s.right-w.left),selW:Math.round(s.width),bL:Math.round(sb.left-w.left),bR:Math.round(sb.right-w.left)}; });
const init=await snap();
console.log('初始[start=2,count=1]: '+JSON.stringify(init));
const gl=await page.evaluate(()=>{const g=document.querySelector('.ms-grip-l').getBoundingClientRect();return{x:g.left+g.width/2,y:g.top+g.height/2};});
await page.evaluate((x,y)=>document.querySelector('.ms-grip-l').dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true})),gl.x,gl.y);
// 向左拖(扩大),拖到 idx1 和 idx0 中心之间(不越 idx0 中心)
const i1c=await page.evaluate(()=>{const b=document.querySelector('.ms-blk[data-idx="1"]');return b.getBoundingClientRect().left+22;});
const i0c=await page.evaluate(()=>{const b=document.querySelector('.ms-blk[data-idx="0"]');return b.getBoundingClientRect().left+22;});
console.log('idx0中心='+Math.round(i0c)+' idx1中心='+Math.round(i1c));
// 拖到 idx0 中心右侧(不越过)
const target=i0c+15;
await page.evaluate((x,y)=>window.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true})),target,gl.y);
await new Promise(r=>setTimeout(r,150));
console.log('拖中: '+JSON.stringify(await snap()));
await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})));
const t=[];
for(let i=0;i<16;i++){await new Promise(r=>setTimeout(r,12));t.push(await snap());}
console.log('松手selL: '+t.map(s=>s.selL).join(','));
console.log('松手selR: '+t.map(s=>s.selR).join(','));
console.log('松手selW: '+t.map(s=>s.selW).join(','));
for(let i=1;i<t.length;i++){if(Math.abs(t[i].selR-t[i-1].selR)>8)console.log('❌selR跳@'+i);if(Math.abs(t[i].selW-t[i-1].selW)>8)console.log('❌selW跳@'+i);}
console.log('完成');
await browser.close();
