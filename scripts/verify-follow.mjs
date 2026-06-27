// 验证播放头跟随:场景A(treble密)和场景B(bass密)都能跳动,不僵住
import { launch } from 'puppeteer-core';
const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1100,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900 });
await page.goto('http://localhost:5174', { waitUntil: 'networkidle0' });
await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
await new Promise(r=>setTimeout(r,400));

async function tapCard(i,a,b){ await page.evaluate((i,a,b)=>{const h=document.querySelectorAll('.svg-host')[i];if(!h)return;const r=h.getBoundingClientRect();const x=r.left+r.width*a,y=r.top+r.height*b;const f=(t)=>h.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true}));f('mousedown');f('mouseup');f('click');},i,a,b); await new Promise(r=>setTimeout(r,120)); }
async function clickView(t){ await page.evaluate((t)=>{[...document.querySelectorAll('.view-btn')].find(b=>b.textContent.includes(t))?.click();},t); await new Promise(r=>setTimeout(r,160)); }
async function pressDur(k){ await page.keyboard.press(k); await new Promise(r=>setTimeout(r,80)); }
async function clickClear(){ await page.evaluate(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('清'))?.click();}); await new Promise(r=>setTimeout(r,160)); }

// seek 到不同 beat(通过点击不同 x),收集播放头 left 集合,判断是否"跳动"(有多个不同值)
async function collectPhLeft(clicks) {
  const out = [];
  for (const cp of clicks) {
    const r = await page.evaluate(async (c) => {
      const host = document.querySelector('.preview-host');
      const hr = host.getBoundingClientRect();
      const x = hr.left + hr.width * c;
      host.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:hr.top+10,bubbles:true}));
      host.dispatchEvent(new MouseEvent('mouseup',{clientX:x,clientY:hr.top+10,bubbles:true}));
      await new Promise(res=>setTimeout(res,70));
      return parseFloat(host.querySelector('.pb-playhead')?.style.left||'-1');
    }, cp);
    out.push(+r.toFixed(1));
  }
  return out;
}

// ── 场景A: treble 2八分 + bass 1四分 ──
await clickView('双谱'); await clickClear();
await pressDur('4'); // 八分
await tapCard(0,0.3,0.4); await tapCard(0,0.35,0.4);
await page.evaluate(()=>{const h=document.querySelectorAll('.svg-host')[1];if(!h)return;const r=h.getBoundingClientRect();const f=(t)=>h.dispatchEvent(new MouseEvent(t,{clientX:r.left+r.width*0.5,clientY:r.top+r.height*0.55,bubbles:true}));f('mousedown');f('mouseup');f('click');});
await new Promise(r=>setTimeout(r,100));
await pressDur('3'); await tapCard(1,0.5,0.55); // bass 四分
await clickView('预览'); await new Promise(r=>setTimeout(r,250));
const phA = await collectPhLeft([0.10, 0.13, 0.15, 0.17, 0.20]);
const uniqA = [...new Set(phA)];
console.log('场景A(treble密) phLeft:', JSON.stringify(phA), '唯一值数:', uniqA.length);

// ── 场景B: treble 1四分 + bass 2八分(之前僵住的) ──
await clickView('双谱'); await clickClear();
await pressDur('3'); await tapCard(0,0.3,0.4); // treble 四分
await page.evaluate(()=>{const h=document.querySelectorAll('.svg-host')[1];if(!h)return;const r=h.getBoundingClientRect();const f=(t)=>h.dispatchEvent(new MouseEvent(t,{clientX:r.left+r.width*0.5,clientY:r.top+r.height*0.55,bubbles:true}));f('mousedown');f('mouseup');f('click');});
await new Promise(r=>setTimeout(r,100));
await pressDur('4'); await tapCard(1,0.5,0.55); await tapCard(1,0.55,0.55); // bass 2八分
await clickView('预览'); await new Promise(r=>setTimeout(r,250));
const phB = await collectPhLeft([0.10, 0.13, 0.15, 0.17, 0.20]);
const uniqB = [...new Set(phB)];
console.log('场景B(bass密) phLeft:', JSON.stringify(phB), '唯一值数:', uniqB.length);

// 判定:两组场景播放头都应"跳动"(唯一值数>=2),不僵在单一位置
const passA = uniqA.length >= 2;
const passB = uniqB.length >= 2;
console.log(`\n场景A ${passA?'✅跳动':'❌僵住'} | 场景B ${passB?'✅跳动(已修复)':'❌僵住'}`);
console.log(passA && passB ? '\n✅ 通过' : '\n❌ 失败');
await browser.close();
process.exit(passA && passB ? 0 : 1);
