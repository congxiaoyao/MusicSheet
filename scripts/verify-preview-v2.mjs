// 预览播放头 v2 验证:停止态 seek 跟随音(问题1+4)、播放头顶满(问题2)、radio 刷新(问题3)、吸附对称
import { launch } from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:5174';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1100,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900 });
const consoleErrors = [];
page.on('console', m => { if (m.type()==='error' && !/Failed to load resource|favicon|404/i.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: '+e.message));
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
await new Promise(r=>setTimeout(r,400));

async function tapCard(i,a,b){ await page.evaluate((i,a,b)=>{const h=document.querySelectorAll('.svg-host')[i];if(!h)return;const r=h.getBoundingClientRect();const x=r.left+r.width*a,y=r.top+r.height*b;const f=(t)=>h.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,bubbles:true}));f('mousedown');f('mouseup');f('click');},i,a,b); await new Promise(r=>setTimeout(r,120)); }
async function clickView(t){ await page.evaluate((t)=>{[...document.querySelectorAll('.view-btn')].find(b=>b.textContent.includes(t))?.click();},t); await new Promise(r=>setTimeout(r,160)); }
async function pressDur(k){ await page.keyboard.press(k); await new Promise(r=>setTimeout(r,80)); }
async function clickClear(){ await page.evaluate(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('清'))?.click();}); await new Promise(r=>setTimeout(r,160)); }

// 准备场景A: treble 2八分 + bass 1四分
await clickView('双谱');
await pressDur('4'); // 八分
await tapCard(0,0.3,0.4); await tapCard(0,0.35,0.4);
await page.evaluate(()=>{const h=document.querySelectorAll('.svg-host')[1];if(!h)return;const r=h.getBoundingClientRect();const f=(t)=>h.dispatchEvent(new MouseEvent(t,{clientX:r.left+r.width*0.5,clientY:r.top+r.height*0.55,bubbles:true}));f('mousedown');f('mouseup');f('click');});
await new Promise(r=>setTimeout(r,100));
await pressDur('3'); // 四分 bass
await tapCard(1,0.5,0.55);
await clickView('预览');
await new Promise(r=>setTimeout(r,250));

// ── 验证1(问题1+4):停止态 seek 后播放头跟随真实音符位置(不跳到52%线性位) ──
// 场景A:点击 0.25(最近音 treble idx1,noteX≈0.169 比例)。若跟随音符,phLeft≈17%而非52%
const snapA = await page.evaluate(async () => {
  const host = document.querySelector('.preview-host');
  const r = host.getBoundingClientRect();
  const x = r.left + r.width * 0.25;
  host.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:r.top+10,bubbles:true}));
  host.dispatchEvent(new MouseEvent('mouseup',{clientX:x,clientY:r.top+10,bubbles:true}));
  await new Promise(res=>setTimeout(res,90));
  const ph = host.querySelector('.pb-playhead');
  return { phLeft: parseFloat(ph?.style.left||'-1') };
});
// treble idx1 noteX≈0.169 → leftPct 应在 ~16-18%(±3),绝不应是 ~52%
check('问题1+4:停止态 seek 跟随音(非52%线性位)', snapA.phLeft > 10 && snapA.phLeft < 28,
  `场景A 点击0.25 → phLeft=${snapA.phLeft}% (应≈17%,不该≈52%)`);

// ── 验证2(问题2):播放头顶到淡灰色区域两端(top≈0, height≈100) ──
const fullH = await page.evaluate(() => {
  const ph = document.querySelector('.pb-playhead');
  return { top: parseFloat(ph?.style.top||'-1'), height: parseFloat(ph?.style.height||'-1') };
});
check('问题2:播放头顶到两端(top≈0,height≈100)', Math.abs(fullH.top)<2 && Math.abs(fullH.height-100)<2,
  `top=${fullH.top}% height=${fullH.height}%`);

// ── 验证3(问题3):radio 点击后 active 刷新 ──
const radioTest = await page.evaluate(async () => {
  const btns = [...document.querySelectorAll('.preview-bar .seg-btn')];
  const jianpuBtn = btns.find(b=>b.textContent.includes('简谱'));
  // 点简谱
  jianpuBtn?.click();
  await new Promise(res=>setTimeout(res,160));
  // render 后重新读 radio
  const btns2 = [...document.querySelectorAll('.preview-bar .seg-btn')];
  return {
    jianpuActive: btns2.find(b=>b.textContent.includes('简谱'))?.classList.contains('active'),
    bothActive: btns2.find(b=>b.textContent.includes('两者'))?.classList.contains('active'),
    staffActive: btns2.find(b=>b.textContent.includes('五线谱'))?.classList.contains('active'),
  };
});
check('问题3:点"简谱"后其 active 刷新', radioTest.jianpuActive === true && radioTest.bothActive === false,
  `简谱=${radioTest.jianpuActive} 两者=${radioTest.bothActive}`);

// 切回两者,准备场景B
await page.evaluate(()=>{[...document.querySelectorAll('.preview-bar .seg-btn')].find(b=>b.textContent.includes('两者'))?.click();});
await new Promise(r=>setTimeout(r,160));

// ── 验证4(问题4对称):场景B treble 1四分 + bass 2八分,停止态 seek 同样跟随 ──
await clickView('双谱');
await clickClear();
await pressDur('3'); // 四分 treble
await tapCard(0,0.3,0.4);
await page.evaluate(()=>{const h=document.querySelectorAll('.svg-host')[1];if(!h)return;const r=h.getBoundingClientRect();const f=(t)=>h.dispatchEvent(new MouseEvent(t,{clientX:r.left+r.width*0.5,clientY:r.top+r.height*0.55,bubbles:true}));f('mousedown');f('mouseup');f('click');});
await new Promise(r=>setTimeout(r,100));
await pressDur('4'); // 八分 bass
await tapCard(1,0.5,0.55); await tapCard(1,0.55,0.55);
await clickView('预览');
await new Promise(r=>setTimeout(r,250));

const snapB = await page.evaluate(async () => {
  const host = document.querySelector('.preview-host');
  const r = host.getBoundingClientRect();
  const x = r.left + r.width * 0.25;
  host.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:r.top+10,bubbles:true}));
  host.dispatchEvent(new MouseEvent('mouseup',{clientX:x,clientY:r.top+10,bubbles:true}));
  await new Promise(res=>setTimeout(res,90));
  const ph = host.querySelector('.pb-playhead');
  return { phLeft: parseFloat(ph?.style.left||'-1') };
});
// 场景B 点击0.25,最近音 bass idx1(noteX≈0.169)或 treble idx0(0.14),应≈16%左右,非52%
check('问题4对称:场景B停止态 seek 跟随音', snapB.phLeft > 10 && snapB.phLeft < 28,
  `场景B 点击0.25 → phLeft=${snapB.phLeft}% (应≈17%,不该≈52%)`);

// ── 验证5(问题1完整):编辑→预览→编辑→预览 后 seek 仍准 ──
const leakSeek = await page.evaluate(async () => {
  const clickView = (t) => [...document.querySelectorAll('.view-btn')].find(b=>b.textContent.includes(t))?.click();
  for (let i=0;i<3;i++){ clickView('双谱'); await new Promise(r=>setTimeout(r,140)); clickView('预览'); await new Promise(r=>setTimeout(r,140)); }
  // 现在预览模式,点击 0.25,看 phLeft
  const host = document.querySelector('.preview-host');
  const r = host.getBoundingClientRect();
  const x = r.left + r.width * 0.25;
  host.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:r.top+10,bubbles:true}));
  host.dispatchEvent(new MouseEvent('mouseup',{clientX:x,clientY:r.top+10,bubbles:true}));
  await new Promise(res=>setTimeout(res,90));
  const ph = host.querySelector('.pb-playhead');
  return { phLeft: parseFloat(ph?.style.left||'-1') };
});
check('问题1:3轮编辑↔预览后 seek 仍准(跟随音)', leakSeek.phLeft > 10 && leakSeek.phLeft < 28,
  `3轮切换后 点击0.25 → phLeft=${leakSeek.phLeft}% (应≈17%)`);

// ── 验证6:无运行时错误 ──
check('运行时无 console/page 错误', consoleErrors.length===0, consoleErrors.slice(0,3).join(' | '));

await browser.close();
const failed = results.filter(r=>!r.ok).length;
console.log(`\n${failed===0?'✅ 全部通过':'❌ '+failed+' 项失败'} (${results.filter(r=>r.ok).length}/${results.length})`);
process.exit(failed===0?0:1);
