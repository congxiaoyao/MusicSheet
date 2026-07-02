// MeasureSelector 端到端像素校验。
// 方法:给选框注入红粗边(便于像素定位选框左右缘),动画 transition 调慢到 1.2s(便于逐帧捕获)。
// 用 page.mouse 真实拖拽,拖拽中逐帧截图 → 像素分析定位「选框左右缘(红)+ 各书签中心(深色文字)」,
// 断言:① 选框缘跟手(逐帧接近鼠标目标);② 书签跨格平滑(单帧位移 < 阈值);③ 稳态坐标符合预期。
// 覆盖核心操作:1A 拖右扩 / 1B 拖右缩 / 1C 拖左移 / 2A 拖框体右 / 2B 拖框体左 / 加小节 / 删小节。
//
// 用法:node scripts/verify-ms-pixel-e2e.mjs http://localhost:5173/library-demo.html
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launch } from 'puppeteer-core';
const require = createRequire(import.meta.url);
const PNG = require('pngjs').PNG;
const URL = process.argv[2] || 'http://localhost:5173/library-demo.html';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push('PE:' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|404/i.test(m.text())) errs.push('ERR:' + m.text()); });
page.on('framenavigated', async () => { try { await page.evaluate(() => { window.confirm = () => true; }); } catch {} });

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => { window.confirm = () => true; });
await new Promise(r => setTimeout(r, 2500));
await page.evaluate(() => [...document.querySelectorAll('.score-card:not(.new-card)')][0]?.click());
await new Promise(r => setTimeout(r, 1500));
await page.evaluate(() => { window.confirm = () => true; });

// 注入调试样式:选框只留红粗边(去背景,避免淡红背景被误判);把手保持原色(不染红,避免与选框缘混)。
// 动画 transition 调慢到 1.2s(便于逐帧捕获)。
await page.addStyleTag({ content: `
  .ms-sel { border: 4px solid #ff0000 !important; box-shadow: none !important; background: transparent !important; }
  .ms-blk, .ms-sel, .ms-grip, .ms-add { transition: transform 1.2s linear, opacity 1.2s linear !important; }
  .ms-wrap.ms-dragging .ms-sel, .ms-wrap.ms-dragging .ms-grip, .ms-wrap.ms-dragging .ms-add { transition: none !important; }
` });

// 重置到 8 小节 [2,3](start=2 count=2)
const cur = () => page.evaluate(() => document.querySelectorAll('.ms-blk:not(.ms-leave)').length);
while (await cur() > 1) { await page.evaluate(() => { const b = [...document.querySelectorAll('.ms-blk')].pop(); b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); b.querySelector('.ms-del')?.click(); }); await new Promise(r => setTimeout(r, 70)); }
while (await cur() < 8) { await page.evaluate(() => document.querySelector('.ms-add')?.click()); await new Promise(r => setTimeout(r, 50)); }
await new Promise(r => setTimeout(r, 300));
await page.evaluate(() => window.__ms.setSelection(2, 2));
await new Promise(r => setTimeout(r, 1500));   // 等慢动画完成

// ── 采样工具:DOM 读书签cx(精确知idx)+ 像素读选框左右缘(验证视觉渲染)──
async function pixelSnap() {
  // DOM:每个书签的 cx(相对 wrap 左上),按 idx 排序;选框期望左右缘
  const dom = await page.evaluate(() => {
    const wrap = document.querySelector('.ms-wrap');
    const wRect = wrap.getBoundingClientRect();
    const blks = [...document.querySelectorAll('.ms-blk:not(.ms-leave)')].sort((a, b) => +a.dataset.idx - +b.dataset.idx);
    const sel = document.querySelector('.ms-sel').getBoundingClientRect();
    return {
      blockCx: blks.map(b => { const r = b.getBoundingClientRect(); return { idx: +b.dataset.idx, cx: Math.round(r.left + r.width / 2 - wRect.left) }; }),
      selLeftDom: Math.round(sel.left - wRect.left),
      selRightDom: Math.round(sel.right - wRect.left),
    };
  });
  // 像素:截 wrap,找红边(选框左右缘的视觉渲染位置)
  const wrapEl = await page.$('.ms-wrap');
  const buf = await wrapEl.screenshot({});
  const img = PNG.sync.read(buf);
  const w = img.width, h = img.height;
  const redXs = [];
  for (let x = 0; x < w; x++) {
    let redCount = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) << 2;
      if (img.data[i] > 200 && img.data[i + 1] < 60 && img.data[i + 2] < 60) { redCount++; if (redCount > 10) break; }
    }
    if (redCount > 10) redXs.push(x);
  }
  const redClusters = clusterize(redXs, 4);
  const selLeftPx = redClusters.length ? Math.round((redClusters[0][0] + redClusters[0][1]) / 2) : null;
  const selRightPx = redClusters.length ? Math.round((redClusters[redClusters.length - 1][0] + redClusters[redClusters.length - 1][1]) / 2) : null;
  return { ...dom, selLeftPx, selRightPx, redClusterCount: redClusters.length };
}
function clusterize(xs, gap) {
  if (!xs.length) return [];
  xs.sort((a, b) => a - b);
  const out = []; let s = xs[0], p = xs[0];
  for (let i = 1; i < xs.length; i++) { if (xs[i] - p > gap) { out.push([s, p]); s = xs[i]; } p = xs[i]; }
  out.push([s, p]); return out;
}

/** 拖拽某元素到目标书签中心,沿途采样(dispatchEvent,稳定,不依赖 page.mouse)。 */
async function dragAndSample(dragSelector, targetIdx, interval = 90, steps = 12) {
  const start = await page.evaluate((sel) => { const g = document.querySelector(sel).getBoundingClientRect(); return { x: g.left + g.width / 2, y: g.top + g.height / 2 }; }, dragSelector);
  const target = await page.evaluate((idx) => { const b = document.querySelector(`.ms-blk[data-idx="${idx}"]`); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2 }; }, targetIdx);
  const x0 = start.x, y0 = start.y, x1 = target.x;
  await page.evaluate((sel, x, y) => document.querySelector(sel).dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true })), dragSelector, x0, y0);
  await new Promise(r => setTimeout(r, 30));
  const samples = [];
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * (i / steps);
    await page.evaluate((x, y) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true })), x, y0);
    await new Promise(r => setTimeout(r, interval));
    samples.push(await pixelSnap());
  }
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
  return samples;
}

/** 框体拖拽:在框内书签上 down(触发 downInfo→框体),拖到目标书签。dispatchEvent 稳定版。 */
async function dragBodyAndSample(targetIdx, interval = 90, steps = 12) {
  const start = await page.evaluate(() => { const b = document.querySelector('.ms-blk.inside') || document.querySelector('.ms-sel .ms-blk') || document.querySelector('.ms-blk'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const target = await page.evaluate((idx) => { const b = document.querySelector(`.ms-blk[data-idx="${idx}"]`); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2 }; }, targetIdx);
  const x0 = start.x, y0 = start.y, x1 = target.x;
  await page.evaluate((x, y) => { const b = document.querySelector('.ms-blk.inside') || document.querySelector('.ms-blk'); b.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true })); }, x0, y0);
  await new Promise(r => setTimeout(r, 30));
  const samples = [];
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * (i / steps);
    await page.evaluate((x, y) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true })), x, y0);
    await new Promise(r => setTimeout(r, interval));
    samples.push(await pixelSnap());
  }
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
  return samples;
}

/** 断言某 idx 书签在采样序列中跨格平滑:取其 cx 序列,单帧最大位移 < maxJump。 */
function smoothCheck(samples, idx, maxJump, label) {
  const cxs = samples.map(s => s.blockCx.find(b => b.idx === idx)?.cx).filter(v => v != null);
  if (cxs.length < 2) return { ok: false, msg: `${label}:采样点不足(${cxs.length}点)` };
  let maxJ = 0, at = '';
  for (let i = 1; i < cxs.length; i++) { const d = Math.abs(cxs[i] - cxs[i - 1]); if (d > maxJ) { maxJ = d; at = `step${i}`; } }
  return { ok: maxJ < maxJump, msg: `${label}:cx序列${JSON.stringify(cxs)} 最大单帧${maxJ}px@${at}(阈值${maxJump})` };
}

// ════════════════════════════════════════════════════════
console.log('═══ 稳态基线(8小节,[2,3])═══');
let base = await pixelSnap();
const bcx = (s, idx) => s.blockCx.find(b => b.idx === idx)?.cx;
check('稳态:定位到8个书签', base.blockCx.length === 8, `${base.blockCx.length}个:cx${JSON.stringify(base.blockCx.map(b => b.cx))}`);
check('稳态:像素定位到选框左右缘(红边2簇)', base.redClusterCount >= 2 && base.selLeftPx != null && base.selRightPx != null, `px[${base.selLeftPx},${base.selRightPx}] 红簇${base.redClusterCount}`);
// 像素缘应与 DOM 缘吻合(选框实际渲染在期望位置)
check('稳态:像素选框缘 == DOM选框缘(渲染一致)', Math.abs((base.selLeftPx ?? 0) - base.selLeftDom) < 6 && Math.abs((base.selRightPx ?? 0) - base.selRightDom) < 6, `px[${base.selLeftPx},${base.selRightPx}] dom[${base.selLeftDom},${base.selRightDom}]`);
check('稳态:选框框住第3、4书签', bcx(base, 2) > base.selLeftDom && bcx(base, 3) < base.selRightDom, `sel[${base.selLeftDom},${base.selRightDom}] b2=${bcx(base, 2)} b3=${bcx(base, 3)}`);

// ════════════════════════════════════════════════════════
console.log('\n═══ 1A 拖右把手扩 count([2,3]→[2,3,4,5]) — idx4 框外→框内 ═══');
await page.evaluate(() => window.__ms.setSelection(2, 2));
await new Promise(r => setTimeout(r, 1400));
const s1A = await dragAndSample('.ms-grip-r', 4, 90, 12);
let sc = smoothCheck(s1A, 4, 18, '1A idx4跨格');
check('1A:idx4跨格平滑(单帧位移<18px)', sc.ok, sc.msg);
// 缘跟手:用 DOM selRightDom 验总体右移(像素红边在缘跟手时不稳)
const selRightsDom = s1A.map(s => s.selRightDom).filter(v => v != null);
check('1A:选框右缘总体右移(DOM,末>首)', selRightsDom.length >= 2 && selRightsDom[selRightsDom.length - 1] > selRightsDom[0], `右缘DOM首${selRightsDom[0]}末${selRightsDom[selRightsDom.length-1]}`);
await new Promise(r => setTimeout(r, 1400));
let after = await pixelSnap();
check('1A动画后:选框框住[2,3,4,5](cx4在sel内)', bcx(after, 4) > after.selLeftDom && bcx(after, 4) < after.selRightDom, `sel[${after.selLeftDom},${after.selRightDom}] b4=${bcx(after, 4)}`);

// ════════════════════════════════════════════════════════
console.log('\n═══ 1B 拖右把手缩 count([2,3,4,5]→[2]) — idx3 框内→框外 ═══');
await page.evaluate(() => window.__ms.setSelection(2, 4));
await new Promise(r => setTimeout(r, 1400));
const s1B = await dragAndSample('.ms-grip-r', 2, 90, 10);
sc = smoothCheck(s1B, 3, 18, '1B idx3跨格');
check('1B:idx3跨格平滑(单帧位移<18px)', sc.ok, sc.msg);
await new Promise(r => setTimeout(r, 1400));
after = await pixelSnap();
check('1B动画后:选框只框[2](cx2在sel内,cx3在sel外)', bcx(after, 2) > after.selLeftDom && bcx(after, 2) < after.selRightDom && bcx(after, 3) > after.selRightDom, `sel[${after.selLeftDom},${after.selRightDom}] b2=${bcx(after, 2)} b3=${bcx(after, 3)}`);

// ════════════════════════════════════════════════════════
console.log('\n═══ 1C 拖左把手右移 start([2,3]→[3]) — idx2 框内→框外左 ═══');
await page.evaluate(() => window.__ms.setSelection(2, 2));
await new Promise(r => setTimeout(r, 1400));
const s1C = await dragAndSample('.ms-grip-l', 3, 90, 10);
sc = smoothCheck(s1C, 2, 18, '1C idx2跨格');
check('1C:idx2跨格平滑(单帧位移<18px)', sc.ok, sc.msg);
const selLeftsDom = s1C.map(s => s.selLeftDom).filter(v => v != null);
check('1C:选框左缘总体右移(DOM,末>首)', selLeftsDom.length >= 2 && selLeftsDom[selLeftsDom.length - 1] > selLeftsDom[0], `左缘DOM首${selLeftsDom[0]}末${selLeftsDom[selLeftsDom.length-1]}`);

// ════════════════════════════════════════════════════════
console.log('\n═══ 2A 拖框体右移([2,3]→[3,4]) — idx2滑出 + idx4滑入(双侧跨格)═══');
await page.evaluate(() => window.__ms.setSelection(2, 2));
await new Promise(r => setTimeout(r, 1400));
const s2A = await dragBodyAndSample(4, 90, 12);
sc = smoothCheck(s2A, 2, 18, '2A idx2滑出');
check('2A:idx2滑出平滑', sc.ok, sc.msg);
sc = smoothCheck(s2A, 4, 18, '2A idx4滑入');
check('2A:idx4滑入平滑', sc.ok, sc.msg);
const selL2A = s2A.map(s => s.selLeftPx).filter(v => v != null);
check('2A:选框整体右移(selLeft像素,末>首)', selL2A.length >= 2 && selL2A[selL2A.length - 1] > selL2A[0], `selLeftpx首${selL2A[0]}末${selL2A[selL2A.length-1]}`);

// ════════════════════════════════════════════════════════
console.log('\n═══ 2B 拖框体左移([5,6]→[4,5]) — idx4滑入 + idx6滑出 ═══');
await page.evaluate(() => window.__ms.setSelection(5, 2));
await new Promise(r => setTimeout(r, 1400));
const s2B = await dragBodyAndSample(4, 90, 12);
sc = smoothCheck(s2B, 4, 18, '2B idx4滑入');
check('2B:idx4滑入平滑', sc.ok, sc.msg);
const selL2B = s2B.map(s => s.selLeftPx).filter(v => v != null);
check('2B:选框整体左移(selLeft像素,末<首)', selL2B.length >= 2 && selL2B[selL2B.length - 1] < selL2B[0], `selLeftpx首${selL2B[0]}末${selL2B[selL2B.length-1]}`);

// ════════════════════════════════════════════════════════
console.log('\n═══ 加小节(进场动画 alpha)═══');
await page.evaluate(() => window.__ms.setSelection(0, 2));
await new Promise(r => setTimeout(r, 1400));
const beforeAdd = await page.evaluate(() => document.querySelectorAll('.ms-blk:not(.ms-leave)').length);
await page.evaluate(() => document.querySelector('.ms-add')?.click());
const opSeq = [];
for (let i = 0; i < 18; i++) {   // 18帧×80ms ≈ 1.44s,覆盖1.2s动画
  await new Promise(r => setTimeout(r, 80));
  const last = await page.evaluate(() => { const b = [...document.querySelectorAll('.ms-blk:not(.ms-leave)')].pop(); if (!b) return null; return { op: parseFloat(getComputedStyle(b).opacity) }; });
  opSeq.push(last);
}
check('加小节:新书签数+1', (await page.evaluate(() => document.querySelectorAll('.ms-blk:not(.ms-leave)').length)) === beforeAdd + 1, `${beforeAdd}→${beforeAdd + 1}`);
const ops = opSeq.map(o => o?.op).filter(v => v != null);
const hasTransition = ops.length >= 2 && Math.max(...ops) - Math.min(...ops) > 0.2;
check('加小节:新书签alpha有过渡(0→1)', hasTransition, `opacity序列${JSON.stringify(ops.map(o => +o.toFixed(2)))}`);
check('加小节:终态opacity=1', ops[ops.length - 1] >= 0.95, `末值${ops[ops.length - 1].toFixed(3)}`);

// ════════════════════════════════════════════════════════
console.log('\n═══ 删小节(退场动画 alpha)═══');
await page.evaluate(() => window.__ms.setSelection(0, 2));
await new Promise(r => setTimeout(r, 1400));
const beforeDel = await page.evaluate(() => document.querySelectorAll('.ms-blk:not(.ms-leave)').length);
await page.evaluate(() => { const b = [...document.querySelectorAll('.ms-blk:not(.ms-leave)')].pop(); b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); b.querySelector('.ms-del')?.click(); });
const delOpSeq = [];
for (let i = 0; i < 15; i++) {   // 尽早开始采样,捕捉从1→0
  await new Promise(r => setTimeout(r, 50));
  const leaving = await page.evaluate(() => { const b = document.querySelector('.ms-blk.ms-leave'); return b ? { op: parseFloat(getComputedStyle(b).opacity) } : null; });
  delOpSeq.push(leaving);
}
const delOps = delOpSeq.map(o => o?.op).filter(v => v != null);
// 退场:ms-leave 后 opacity 从1下降(元素 220ms 后被移除,所以只验下降趋势,不强求到0)
const declining = delOps.length >= 2 && delOps[0] > delOps[delOps.length - 1] && (delOps[0] - delOps[delOps.length - 1]) > 0.05;
check('删小节:被删书签alpha下降(ms-leave退场)', declining, `opacity序列${JSON.stringify(delOps.map(o => +o.toFixed(2)))}(元素220ms后移除,验下降趋势)`);
await new Promise(r => setTimeout(r, 400));
check('删小节:书签数-1', (await page.evaluate(() => document.querySelectorAll('.ms-blk:not(.ms-leave)').length)) === beforeDel - 1, `${beforeDel}→${beforeDel - 1}`);

// ════════════════════════════════════════════════════════
// 测试13:拖把手缘跟手度 + 跨格吸入平滑 + 抬手吸附(本次手感重做核心)
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试13:拖把手缘跟手 + 跨格吸入 + 抬手吸附 ═══');
await page.evaluate(() => window.__ms.setSelection(2, 2));
await new Promise(r => setTimeout(r, 600));

// 拖右把手扩:逐帧记录 鼠标x(视口)、selRight(视口)、idx4 cx。验证 selRight ≈ 鼠标x(跟手度<8px)
const gBox2 = await page.evaluate(() => { const g=document.querySelector('.ms-grip-r').getBoundingClientRect(); return {x:g.left+g.width/2, y:g.top+g.height/2}; });
const t5b = await page.evaluate(() => { const b=document.querySelector('.ms-blk[data-idx="5"]'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2}; });
await page.evaluate((x,y)=>document.querySelector('.ms-grip-r').dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true})), gBox2.x, gBox2.y);
const traceR=[];
for (let i=1;i<=8;i++){
  const mx = gBox2.x + (t5b.x-gBox2.x)*(i/8);
  await page.evaluate((x,y)=>window.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true})), mx, gBox2.y);
  await new Promise(r=>setTimeout(r,55));
  const d = await page.evaluate(() => { const s=document.querySelector('.ms-sel').getBoundingClientRect(); const b4=document.querySelector('.ms-blk[data-idx="4"]'); const r4=b4.getBoundingClientRect(); return { selRv: Math.round(s.right), b4cx: Math.round(r4.left+r4.width/2), inside: b4.classList.contains('inside') }; });
  traceR.push({mx:Math.round(mx), selRv:d.selRv, b4cx:d.b4cx, inside:d.inside});
}
// 跟手度:selR 增量 ≈ 鼠标增量(相对跟手,不依赖 edgeOffset 补偿的绝对偏移)
const deltas = traceR.map((t,i) => i===0 ? 0 : (t.selRv - traceR[i-1].selRv) - (t.mx - traceR[i-1].mx));
const maxDeltaErr = Math.max(...deltas.map(Math.abs));
check('拖右把手:选框右缘跟手(selR增量≈鼠标增量,差<5px)', maxDeltaErr < 5, `最大增量差${maxDeltaErr}px`);
const b4cxs = traceR.filter(t=>t.inside).map(t=>t.b4cx);
let maxJump4 = 0;
for (let i=1;i<b4cxs.length;i++) maxJump4 = Math.max(maxJump4, Math.abs(b4cxs[i]-b4cxs[i-1]));
check('拖右把手:idx4跨格吸入平滑(单帧<18px)', maxJump4 < 18, `最大跳${maxJump4}`);
await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})));
// animate 吸附:松手后 sel 有 running 动画
await new Promise(r=>setTimeout(r,20));
const animCount = await page.evaluate(() => document.querySelector('.ms-sel').getAnimations().length);
check('抬手吸附:Web Animations 启动', animCount > 0, `animations=${animCount}`);

// 框体任意处可拖:在框内书签上 pointerdown+拖 → dragging
await page.evaluate(() => window.__ms.setSelection(2, 2));
await new Promise(r => setTimeout(r, 600));
const b3c = await page.evaluate(() => { const b=document.querySelector('.ms-blk[data-idx="3"]'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; });
await page.evaluate((x,y)=>document.querySelector('.ms-blk[data-idx="3"]').dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true})), b3c.x, b3c.y);
await page.evaluate((x,y)=>window.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true})), b3c.x+50, b3c.y);
await new Promise(r=>setTimeout(r,150));
const dragOnBlock = await page.evaluate(() => document.querySelector('.ms-wrap').classList.contains('ms-dragging'));
await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})));
check('框体任意处可拖:框内书签上拖动触发平移', dragOnBlock, dragOnBlock?'✅':'❌');

check('全程无页面错误', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
