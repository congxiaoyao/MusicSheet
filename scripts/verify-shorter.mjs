// 验证播放头跟随更短的音:场景B跟bass八分,场景A跟treble八分,同值场景跟treble
import { launch } from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:5173';
const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1100,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900 });
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
await new Promise(r=>setTimeout(r,400));

async function tapCard(i,a,b){ await page.evaluate((i,a,b)=>{const h=document.querySelectorAll('.svg-host')[i];if(!h)return;const r=h.getBoundingClientRect();const x=r.left+r.width*a,y=r.top+r.height*b;const f=(t)=>h.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true}));f('mousedown');f('mouseup');f('click');},i,a,b); await new Promise(r=>setTimeout(r,120)); }
async function clickView(t){ await page.evaluate((t)=>{[...document.querySelectorAll('.view-btn')].find(b=>b.textContent.includes(t))?.click();},t); await new Promise(r=>setTimeout(r,160)); }
async function pressDur(k){ await page.keyboard.press(k); await new Promise(r=>setTimeout(r,80)); }
async function clickClear(){ await page.evaluate(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('清'))?.click();}); await new Promise(r=>setTimeout(r,160)); }

async function setup(trebleNotes, bassNotes) {
  await clickView('双谱'); await clickClear();
  for (const d of trebleNotes) { await pressDur(d); await tapCard(0, 0.3, 0.4); }
  await page.evaluate(()=>{const h=document.querySelectorAll('.svg-host')[1];if(!h)return;const r=h.getBoundingClientRect();const f=(t)=>h.dispatchEvent(new MouseEvent(t,{clientX:r.left+r.width*0.5,clientY:r.top+r.height*0.55,bubbles:true}));f('mousedown');f('mouseup');f('click');});
  await new Promise(r=>setTimeout(r,100));
  for (const d of bassNotes) { await pressDur(d); await tapCard(1, 0.5, 0.55); }
  await clickView('预览'); await new Promise(r=>setTimeout(r,250));
}

// 读两组音符 noteX(svg内部px) + 播放头 left
async function probe(clickRatio) {
  return await page.evaluate(async (cp) => {
    const host = document.querySelector('.preview-host');
    const hr = host.getBoundingClientRect();
    const x = hr.left + hr.width * cp;
    host.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:hr.top+10,bubbles:true}));
    host.dispatchEvent(new MouseEvent('mouseup',{clientX:x,clientY:hr.top+10,bubbles:true}));
    await new Promise(res=>setTimeout(res,70));
    const ph = host.querySelector('.pb-playhead');
    const svg = host.querySelector('svg');
    const svgR = svg.getBoundingClientRect();
    const get = (sel) => {
      const m = {};
      host.querySelectorAll(sel+' [data-idx]').forEach(el=>{const i=+el.getAttribute('data-idx');if(m[i]===undefined){const e=el.getBoundingClientRect();m[i]=+(e.left+e.width/2-svgR.left).toFixed(1);}});
      return m;
    };
    return { phLeft: parseFloat(ph?.style.left||'-1'), tXs: get('.grand-treble'), bXs: get('.grand-bass') };
  }, clickRatio);
}

let pass = 0, fail = 0;
function check(name, cond, detail) { console.log(`  ${cond?'✅':'❌'} ${name}${detail?' — '+detail:''}`); cond?pass++:fail++; }

// ── 场景B: treble[四分] + bass[八分,八分] ──
console.log('=== 场景B: treble四分 + bass 2八分 ===');
await setup(['3'], ['4','4']);
// beat 0.0-0.5 区间:点 0.08(吸附到 bass八分1,noteX=114.2)
const b1 = await probe(0.08);
// beat 0.5-1.0 区间:点 0.18(吸附到 bass八分2,noteX=171.6)
const b2 = await probe(0.18);
console.log(`  noteX: treble四分=${b1.tXs[0]}, bass八分1=${b1.bXs[0]}, bass八分2=${b1.bXs[1]}`);
console.log(`  beat前半 seek → phLeft=${b1.phLeft}%  beat后半 seek → phLeft=${b2.phLeft}%`);
// 前半应≈bass八分1位置(114.2→约11%),后半应≈bass八分2位置(171.6→约16.5%),不能停在四分(142.9→约13.8%)
check('场景B:前半跟bass八分1(非四分)', b1.phLeft < 12.5, `phLeft=${b1.phLeft}% (八分1≈11%,四分≈13.8%)`);
check('场景B:后半跟bass八分2', b2.phLeft > 15, `phLeft=${b2.phLeft}% (八分2≈16.5%)`);

// ── 场景A: treble[八分,八分] + bass[四分](对称) ──
console.log('\n=== 场景A: treble 2八分 + bass四分(对称) ===');
await setup(['4','4'], ['3']);
const a1 = await probe(0.08);
const a2 = await probe(0.18);
console.log(`  noteX: treble八分1=${a1.tXs[0]}, treble八分2=${a1.tXs[1]}, bass四分=${a1.bXs[0]}`);
console.log(`  beat前半 seek → phLeft=${a1.phLeft}%  beat后半 seek → phLeft=${a2.phLeft}%`);
check('场景A:前半跟treble八分1', a1.phLeft < 12.5, `phLeft=${a1.phLeft}%`);
check('场景A:后半跟treble八分2', a2.phLeft > 15, `phLeft=${a2.phLeft}%`);

// ── 场景C: 两组同值(都是四分)→ 跟treble ──
console.log('\n=== 场景C: treble四分 + bass四分(同值) ===');
await setup(['3'], ['3']);
const c1 = await probe(0.08);
const c2 = await probe(0.12);
console.log(`  noteX: treble四分=${c1.tXs[0]}, bass四分=${c1.bXs[0]}`);
console.log(`  seek → phLeft=${c1.phLeft}%`);
// 同值应跟treble。两个音noteX不同(142.9 vs 不同),应停在treble位置
check('场景C:同值跟treble', Math.abs(c1.phLeft - c2.phLeft) < 0.5, `两次seek phLeft=${c1.phLeft}/${c2.phLeft}% (应相同,跟定treble)`);

await browser.close();
console.log(`\n${fail===0?'✅ 全部通过':'❌ '+fail+'项失败'} (${pass}/${pass+fail})`);
process.exit(fail===0?0:1);
