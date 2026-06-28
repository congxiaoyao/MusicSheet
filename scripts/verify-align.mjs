// 验证排版改造:符头锚拍位起点后,场景B四分与八分1 noteX 对齐(重合),播放头不两侧跳
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

async function readNoteX() {
  return await page.evaluate(() => {
    const host = document.querySelector('.preview-host');
    const svg = host.querySelector('svg');
    const svgR = svg.getBoundingClientRect();
    const get = (sel) => {
      const m = {};
      host.querySelectorAll(sel+' [data-idx]').forEach(el=>{const i=+el.getAttribute('data-idx');if(m[i]===undefined){const e=el.getBoundingClientRect();m[i]=+(e.left+e.width/2-svgR.left).toFixed(2);}});
      return m;
    };
    return { tXs: get('.grand-treble'), bXs: get('.grand-bass') };
  });
}

async function probe(clickRatio) {
  return await page.evaluate(async (cp) => {
    const host = document.querySelector('.preview-host');
    const hr = host.getBoundingClientRect();
    const x = hr.left + hr.width * cp;
    host.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:hr.top+10,bubbles:true}));
    host.dispatchEvent(new MouseEvent('mouseup',{clientX:x,clientY:hr.top+10,bubbles:true}));
    await new Promise(res=>setTimeout(res,70));
    return parseFloat(host.querySelector('.pb-playhead')?.style.left||'-1');
  }, clickRatio);
}

let pass=0, fail=0;
function check(name, cond, detail){ console.log('  ' + (cond?'PASS':'FAIL') + ' ' + name + (detail?' - '+detail:'')); cond?pass++:fail++; }

// 场景B: treble[四分] + bass[八分,八分]
console.log('=== 场景B: treble四分 + bass 2八分 ===');
await setup(['3'], ['4','4']);
const g = await readNoteX();
console.log('  treble四分=' + g.tXs[0] + ', bass八分1=' + g.bXs[0] + ', bass八分2=' + g.bXs[1]);
const diffB = Math.abs(g.tXs[0] - g.bXs[0]);
check('排版:四分与八分1符头对齐(同beat起点)', diffB < 1.5, '差=' + diffB.toFixed(2) + 'px');
check('排版:八分2在八分1右侧', g.bXs[1] > g.bXs[0], '八分2=' + g.bXs[1] + '>八分1=' + g.bXs[0]);

const ph1 = await probe(0.08);
const ph2 = await probe(0.18);
console.log('  播放头: beat前半=' + ph1 + '%, beat后半=' + ph2 + '%');
check('播放头:跟随八分跳动', Math.abs(ph1 - ph2) > 1, '前半' + ph1 + '% 后半' + ph2 + '%');

// 场景A对称: treble[八分,八分] + bass[四分]
console.log('=== 场景A: treble 2八分 + bass四分(对称) ===');
await setup(['4','4'], ['3']);
const g2 = await readNoteX();
console.log('  treble八分1=' + g2.tXs[0] + ', 八分2=' + g2.tXs[1] + ', bass四分=' + g2.bXs[0]);
const diffA = Math.abs(g2.tXs[0] - g2.bXs[0]);
check('排版:八分1与四分符头对齐', diffA < 1.5, '差=' + diffA.toFixed(2) + 'px');

// 编辑模式回归:空谱待输入位(svg内坐标)与首音对齐
console.log('=== 编辑模式:空谱待输入位回归 ===');
await clickView('双谱'); await clickClear();
// 空谱:待输入位中心(svg内坐标)
const emptySlot = await page.evaluate(() => {
  const host = document.querySelector('.svg-host:not(.inactive)') || document.querySelector('.svg-host');
  const slot = host.querySelector('.next-slot');
  const svg = host.querySelector('svg');
  if (!slot || !svg) return null;
  const svgR = svg.getBoundingClientRect();
  const r = slot.getBoundingClientRect();
  return r.left + r.width/2 - svgR.left;
});
await pressDur('3'); await tapCard(0, 0.3, 0.4);
const firstNote = await page.evaluate(() => {
  const host = document.querySelector('.svg-host:not(.inactive)') || document.querySelector('.svg-host');
  const svg = host.querySelector('svg');
  const svgR = svg.getBoundingClientRect();
  const el = host.querySelector('[data-idx="0"]');
  if (!el) return null;
  const e = el.getBoundingClientRect();
  return e.left + e.width/2 - svgR.left;
});
console.log('  空谱待输入位(svg内)=' + (emptySlot?emptySlot.toFixed(1):'null') + ', 首音中心(svg内)=' + (firstNote?firstNote.toFixed(1):'null'));
const diffSlot = (emptySlot && firstNote) ? Math.abs(emptySlot - firstNote) : null;
check('回归:空谱待输入位与首音对齐', diffSlot !== null && diffSlot < 3, '差=' + (diffSlot!==null?diffSlot.toFixed(1):'?') + 'px');

await browser.close();
console.log('\n' + (fail===0?'PASS all':'FAIL '+fail) + ' (' + pass + '/' + (pass+fail) + ')');
process.exit(fail===0?0:1);
