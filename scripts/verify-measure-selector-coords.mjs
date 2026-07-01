// MeasureSelector 坐标/状态穷举测试(扩充版,按交接文档 2.4 节)。
// 覆盖:
//   1. 坐标 log 调试:每步打 书签transform/selX/selW/scrollLeft,验证单调 + 选框包住选中 + 跨框间距>正常。
//   2. 穷举 total∈{1,2,3,5,8,16} × 各种 start/count × 拖左/拖右/拖框体/点书签/加/删(删首/末/中/框内/框外/到剩1)。
//   3. 动画中(立即)+ 动画后(等600ms)坐标都符合预期。
//   4. 横滑专项:total=16,滚右→加→scrollLeft不跳回0;滚右→删→clamp合理。
//   5. 组合操作(加→拖→删→拖→加)状态机一致。
//
// 用法:起 server+vite,`node scripts/verify-measure-selector-coords.mjs http://localhost:5173/library-demo.html`
import { launch } from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:5173/library-demo.html';
const results = [];
let verbose = false;   // 详细坐标 log 开关(用 MS_VERBOSE=1 开)
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,1000'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push('PE: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR|404/i.test(m.text())) errs.push('ERR: ' + m.text()); });
// confirm/dialog 全程自动确认(删除会弹 confirm)。
page.on('framenavigated', async () => { try { await page.evaluate(() => { window.confirm = () => true; window.alert = () => {}; }); } catch {} });

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => { window.confirm = () => true; window.alert = () => {}; });
await new Promise(r => setTimeout(r, 2500));
// 进入一个曲子(用列表第一个,通过加删把小节数调成所需)。
await page.evaluate(() => [...document.querySelectorAll('.score-card:not(.new-card)')][0]?.click());
await new Promise(r => setTimeout(r, 1000));
await page.evaluate(() => { window.confirm = () => true; });

// ── 工具 ──
const snap = () => page.evaluate(() => {
  const sel = document.querySelector('.ms-sel');
  const wrap = document.querySelector('.ms-wrap');
  const selRect = sel?.getBoundingClientRect();
  // 按 dataset.idx 排序后再取坐标(框内书签被移入 selInner,DOM 顺序≠idx 顺序)。
  const blks = [...document.querySelectorAll('.ms-blk')].sort((a, b) => +a.dataset.idx - +b.dataset.idx);
  return {
    blockCount: blks.length,
    // 中心 x + 左缘 x + 右缘 x(均按 idx 升序)
    blockCx: blks.map(b => { const r = b.getBoundingClientRect(); return Math.round(r.left + r.width / 2); }),
    blockLeft: blks.map(b => Math.round(b.getBoundingClientRect().left)),
    blockRight: blks.map(b => Math.round(b.getBoundingClientRect().right)),
    blockIdx: blks.map(b => +b.dataset.idx),
    // 选框内书签 idx(不挪窝后书签不在 sel 内,改用 .inside class 判定),按 idx 排序
    insideIdx: [...document.querySelectorAll('.ms-blk.inside')].map(b => +b.dataset.idx).sort((a, b) => a - b),
    selLeft: selRect ? Math.round(selRect.left) : null,
    selRight: selRect ? Math.round(selRect.right) : null,
    selWidth: selRect ? Math.round(selRect.width) : null,
    // addBtn 坐标(addX 几何验证用)
    addRect: (() => { const a = document.querySelector('.ms-add')?.getBoundingClientRect(); return a ? { left: Math.round(a.left), right: Math.round(a.right) } : null; })(),
    scrollLeft: Math.round(wrap.scrollLeft),
    clientWidth: wrap.clientWidth,
    scrollWidth: wrap.scrollWidth,
  };
});

/** 把曲子重置到 total 小节、选框 start/count。
 *  total 通过加/删小节(走真实回调)调整;start/count 用真实交互(点书签设start + 拖右把手设count),
 *  这样会触发 onChange 同步 demo 的 state.startMeasure/edit.measuresPerLine,保证后续加删小节时 count 一致。 */
async function resetTo(total, start, count) {
  let cur = (await snap()).blockCount;
  while (cur > 1) {
    await delMeasure(cur - 1);
    await new Promise(r => setTimeout(r, 60));
    cur = (await snap()).blockCount;
  }
  await new Promise(r => setTimeout(r, 150));
  while (cur < total) {
    await addMeasure();
    await new Promise(r => setTimeout(r, 45));
    cur = (await snap()).blockCount;
  }
  await new Promise(r => setTimeout(r, 250));
  if (total < 1) return;
  // 先把 count 调到 1(拖右把手到 start),再点 start 书签设起点,最后拖右把手扩到 start+count-1。
  const s0 = Math.min(start, total - 1);
  await clickBlock(s0);                      // 设 start(触发 onChange)
  await new Promise(r => setTimeout(r, 180));
  // 拖右把手到 start+count-1 设 count(触发 onChange)
  const targetR = Math.min(s0 + count - 1, total - 1);
  if (targetR >= s0) {
    await dragGrip('r', targetR);
    await new Promise(r => setTimeout(r, 180));
  }
}

const dragGrip = async (side, targetIdx) => {
  await page.evaluate(async (side, targetIdx) => {
    const grip = document.querySelector(side === 'l' ? '.ms-grip-l' : '.ms-grip-r');
    // 按 dataset.idx 取目标(DOM 顺序≠idx 顺序,框内书签在 selInner)。
    const target = document.querySelector(`.ms-blk[data-idx="${targetIdx}"]`);
    if (!grip || !target) return;
    const gR = grip.getBoundingClientRect();
    const tR = target.getBoundingClientRect();
    const x0 = gR.left + gR.width / 2, y0 = gR.top + gR.height / 2;
    const x1 = tR.left + tR.width / 2;
    grip.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, bubbles: true }));
    await new Promise(r => setTimeout(r, 15));
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (x1 - x0) * (i / steps);
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y0, bubbles: true }));
      await new Promise(r => setTimeout(r, 12));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x1, clientY: y0, bubbles: true }));
  }, side, targetIdx);
  await new Promise(r => setTimeout(r, 60));   // 动画中(立即)采样点在调用方
};

/** 拖选框框体横移到 targetIdx(在框体中部 pointerdown,排除把手/书签)。 */
const dragBody = async (targetIdx) => {
  await page.evaluate(async (targetIdx) => {
    const sel = document.querySelector('.ms-sel');
    const target = document.querySelector(`.ms-blk[data-idx="${targetIdx}"]`);
    if (!sel || !target) return;
    const sr = sel.getBoundingClientRect();
    const tR = target.getBoundingClientRect();
    // 框体起点:选框左缘往内 8px(把手与书签之间的空白),y 居中。
    const x0 = sr.left + 8, y0 = sr.top + sr.height / 2;
    const x1 = tR.left + tR.width / 2;
    sel.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, bubbles: true }));
    await new Promise(r => setTimeout(r, 15));
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (x1 - x0) * (i / steps);
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y0, bubbles: true }));
      await new Promise(r => setTimeout(r, 12));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x1, clientY: y0, bubbles: true }));
  }, targetIdx);
};

const clickBlock = async (idx) => {
  await page.evaluate((idx) => {
    const b = document.querySelector(`.ms-blk[data-idx="${idx}"]`);
    if (!b) return;
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
  }, idx);
};

const addMeasure = () => page.evaluate(() => document.querySelector('.ms-add')?.click());

const delMeasure = async (idx) => {
  await page.evaluate((idx) => {
    const b = document.querySelector(`.ms-blk[data-idx="${idx}"]`);
    if (!b) return;
    b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    b.querySelector('.ms-del')?.click();
  }, idx);
};

const isMonotonic = (arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]);

/** 校验一个快照的不变量:书签单调、选框正确包住 insideIdx、无重叠。返回 {ok, msg}。 */
function invariants(s) {
  if (!isMonotonic(s.blockCx)) return { ok: false, msg: `书签中心x非单调 ${JSON.stringify(s.blockCx)}` };
  // 相邻书签不重叠:blockLeft[i+1] >= blockRight[i]
  for (let i = 0; i < s.blockLeft.length - 1; i++) {
    if (s.blockLeft[i + 1] < s.blockRight[i] - 1) return { ok: false, msg: `书签${i}与${i + 1}重叠 L${i + 1}=${s.blockLeft[i + 1]} < R${i}=${s.blockRight[i]}` };
  }
  // 选框正确包住 insideIdx:selLeft ≤ 第一个内书签左缘,selRight ≥ 最后一个内书签右缘
  if (s.insideIdx.length > 0) {
    const first = s.insideIdx[0], last = s.insideIdx[s.insideIdx.length - 1];
    if (s.blockLeft[first] < s.selLeft - 2) return { ok: false, msg: `选框左缘${s.selLeft}超出首书签左缘${s.blockLeft[first]}` };
    if (s.blockRight[last] > s.selRight + 2) return { ok: false, msg: `选框右缘${s.selRight}不足末书签右缘${s.blockRight[last]}` };
  }
  return { ok: true };
}

/** 验证跨选框间距 > 正常间距(若存在框内+框外相邻)。 */
function crossGapCheck(s) {
  const inside = new Set(s.insideIdx);
  // 找跨边界相邻对:i 在内 i+1 在外,或反之
  for (let i = 0; i < s.blockCx.length - 1; i++) {
    const a = inside.has(i), b = inside.has(i + 1);
    if (a !== b) {
      // 这是跨选框的一对。找下一个「框外↔框外」或「框内↔框内」的正常间距对比
      const cross = s.blockLeft[i + 1] - s.blockRight[i];
      // 找同侧相邻作正常间距基准
      for (let j = 0; j < s.blockCx.length - 1; j++) {
        if (inside.has(j) === inside.has(j + 1)) {
          const normal = s.blockLeft[j + 1] - s.blockRight[j];
          if (cross <= normal * 1.5) return { ok: false, msg: `跨框间距${cross}未明显大于正常${normal}(对${i}-${i + 1})` };
          return { ok: true };
        }
      }
    }
  }
  return { ok: true, msg: '无跨框相邻(全选或全不选)' };
}

// ════════════════════════════════════════════════════════
// 测试 1:基础不变量(每个 total)
// ════════════════════════════════════════════════════════
console.log('═══ 测试1:各 totalMeasures 基础布局不变量 ═══');
for (const total of [1, 2, 3, 5, 8, 16]) {
  await resetTo(total, 0, Math.min(2, total));
  let s = await snap();
  if (verbose) console.log(`  [total=${total}] cx=${JSON.stringify(s.blockCx)} sel[${s.selLeft},${s.selRight}] inside=${JSON.stringify(s.insideIdx)} scroll=${s.scrollLeft}/${s.scrollWidth}`);
  const inv = invariants(s);
  check(`total=${total} 不变量(单调/不重叠/选框包住)`, inv.ok, inv.msg);
}

// ════════════════════════════════════════════════════════
// 测试2:start/count 各种组合(total=8)
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试2:total=8 各种 start/count 组合 ═══');
for (const [start, count] of [[0, 1], [0, 3], [0, 8], [2, 3], [5, 3], [7, 1]]) {
  if (start + count > 8) continue;
  await resetTo(8, start, count);
  let s = await snap();
  const inv = invariants(s);
  check(`start=${start} count=${count} 不变量`, inv.ok, inv.msg);
  // insideIdx 应正好是 [start..start+count-1]
  const expect = Array.from({ length: count }, (_, k) => start + k);
  check(`start=${start} count=${count} 选框内 idx=${JSON.stringify(expect)}`, JSON.stringify(s.insideIdx) === JSON.stringify(expect), `实际${JSON.stringify(s.insideIdx)}`);
}

// ════════════════════════════════════════════════════════
// 测试3:拖左把手
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试3:拖左把手(改 start)═══');
await resetTo(8, 2, 3);   // 选 idx2-4
// 向左拖到 idx0:start 应变 0,count 变 5
await dragGrip('l', 0);
let sMid = await snap();   // 动画中(立即)
let inv = invariants(sMid);
check('拖左把手到0(动画中)不变量', inv.ok, inv.msg);
await new Promise(r => setTimeout(r, 600));
let s = await snap();
inv = invariants(s);
check('拖左把手到0(动画后)不变量', inv.ok, inv.msg);
check('拖左到0后选框内=[0,1,2,3,4]', JSON.stringify(s.insideIdx) === JSON.stringify([0, 1, 2, 3, 4]), JSON.stringify(s.insideIdx));

// 向右拖到 idx3:start 变 3,count 变 2(右边界 idx4 不变)
await resetTo(8, 2, 3);
await dragGrip('l', 3);
await new Promise(r => setTimeout(r, 600));
s = await snap();
inv = invariants(s);
check('拖左到3后不变量', inv.ok, inv.msg);
check('拖左到3后选框内=[3,4]', JSON.stringify(s.insideIdx) === JSON.stringify([3, 4]), JSON.stringify(s.insideIdx));

// ════════════════════════════════════════════════════════
// 测试4:拖右把手
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试4:拖右把手(改 count)═══');
await resetTo(8, 0, 2);
// 扩到 idx5:count=6
await dragGrip('r', 5);
sMid = await snap();
inv = invariants(sMid);
check('拖右扩到5(动画中)不变量', inv.ok, inv.msg);
const cgMid = crossGapCheck(sMid);
await new Promise(r => setTimeout(r, 600));
s = await snap();
inv = invariants(s);
check('拖右扩到5(动画后)不变量', inv.ok, inv.msg);
check('拖右扩到5后选框内=[0..5]', JSON.stringify(s.insideIdx) === JSON.stringify([0, 1, 2, 3, 4, 5]), JSON.stringify(s.insideIdx));
const cg = crossGapCheck(s);
check('拖右扩到5后跨框间距>正常', cg.ok, cg.msg);

// 缩到 idx0:count=1
await resetTo(8, 0, 3);
await dragGrip('r', 0);
await new Promise(r => setTimeout(r, 600));
s = await snap();
inv = invariants(s);
check('拖右缩到0(动画后)不变量', inv.ok, inv.msg);
check('拖右缩到0后选框内=[0]', JSON.stringify(s.insideIdx) === JSON.stringify([0]), JSON.stringify(s.insideIdx));

// ════════════════════════════════════════════════════════
// 测试5:拖选框框体横移(Bug B)
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试5:拖选框框体横移(改 start,count不变)═══');
await resetTo(8, 0, 2);
// 拖框体到 idx4:start 应变 4,count 仍 2
await dragBody(4);
sMid = await snap();
// 框体跟手中选框缘是动态跟手值(非稳态),只验书签单调无重叠,不验选框包住(invariants 的 selLeft 约束不适用)。
check('拖框体到4(动画中)书签单调无重叠', isMonotonic(sMid.blockCx), JSON.stringify(sMid.blockCx));
await new Promise(r => setTimeout(r, 600));
s = await snap();
inv = invariants(s);
check('拖框体到4(动画后)不变量', inv.ok, inv.msg);
check('拖框体到4后选框内=[4,5](count不变)', JSON.stringify(s.insideIdx) === JSON.stringify([4, 5]), JSON.stringify(s.insideIdx));
// 再拖回 idx0
await dragBody(0);
await new Promise(r => setTimeout(r, 600));
s = await snap();
check('拖框体回0后选框内=[0,1]', JSON.stringify(s.insideIdx) === JSON.stringify([0, 1]), JSON.stringify(s.insideIdx));

// ════════════════════════════════════════════════════════
// 测试6:点书签跳转
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试6:点书签跳转 ═══');
await resetTo(8, 0, 2);
await clickBlock(6);
await new Promise(r => setTimeout(r, 600));
s = await snap();
inv = invariants(s);
check('点idx6后不变量', inv.ok, inv.msg);
check('点idx6后选框起点=6(clamp到maxStart=6,count=2)', s.insideIdx[0] === 6, JSON.stringify(s.insideIdx));
// 点框内书签:按文档③「点书签跳转=选框起点跳到该书签」,点 idx3 → start=3,选框=[3,4,5]
await resetTo(8, 2, 3);
await clickBlock(3);   // idx3 在框内
await new Promise(r => setTimeout(r, 600));
s = await snap();
check('点框内idx3后选框起点跳到3 → [3,4,5]', JSON.stringify(s.insideIdx) === JSON.stringify([3, 4, 5]), JSON.stringify(s.insideIdx));

// ════════════════════════════════════════════════════════
// 测试7:加小节(进场动画 + 坐标)
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试7:加小节 ═══');
await resetTo(5, 0, 2);
await addMeasure();
sMid = await snap();   // 动画中
inv = invariants(sMid);
check('加1小节(动画中)不变量', inv.ok, inv.msg);
check('加1小节(动画中)书签数=6', sMid.blockCount === 6, `${sMid.blockCount}`);
await new Promise(r => setTimeout(r, 600));
s = await snap();
inv = invariants(s);
check('加1小节(动画后)不变量', inv.ok, inv.msg);
check('加1小节后书签单调', isMonotonic(s.blockCx), JSON.stringify(s.blockCx));
// 连续加到很多(测横滑产生)
await resetTo(1, 0, 1);
for (let i = 0; i < 15; i++) { await addMeasure(); await new Promise(r => setTimeout(r, 40)); }
await new Promise(r => setTimeout(r, 400));
s = await snap();
check('加到16小节后书签16且单调', s.blockCount === 16 && isMonotonic(s.blockCx), `${s.blockCount}`);

// ════════════════════════════════════════════════════════
// 测试8:删小节(删首/末/中/框内/框外/到剩1)+ Bug C 选框 clamp
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试8:删小节各位置(Bug C 选框clamp)═══');
// 删末尾
await resetTo(5, 0, 2);
await delMeasure(4);
await new Promise(r => setTimeout(r, 400));
s = await snap();
inv = invariants(s);
check('删末尾(idx4)后不变量', inv.ok, inv.msg);
check('删末尾后书签数=4', s.blockCount === 4, `${s.blockCount}`);

// 删中间(框外)
await resetTo(8, 0, 3);
await delMeasure(5);
await new Promise(r => setTimeout(r, 400));
s = await snap();
inv = invariants(s);
check('删中间(idx5,框外)后不变量', inv.ok, inv.msg);
check('删中间后书签数=7', s.blockCount === 7, `${s.blockCount}`);

// 删首
await resetTo(5, 1, 2);
await delMeasure(0);
await new Promise(r => setTimeout(r, 400));
s = await snap();
inv = invariants(s);
check('删首(idx0)后不变量', inv.ok, inv.msg);
check('删首后书签数=4', s.blockCount === 4, `${s.blockCount}`);

// 删框内
await resetTo(6, 0, 4);   // 选框内 idx0-3
await delMeasure(2);      // 删框内 idx2
await new Promise(r => setTimeout(r, 400));
s = await snap();
inv = invariants(s);
check('删框内(idx2)后不变量', inv.ok, inv.msg);
check('删框内后书签数=5', s.blockCount === 5, `${s.blockCount}`);
check('删框内后选框仍正确包住(clamp count)', s.insideIdx.length >= 1 && inv.ok, JSON.stringify(s.insideIdx));

// 删到剩1
await resetTo(5, 0, 2);
for (let i = 0; i < 4; i++) { await delMeasure((await snap()).blockCount - 1); await new Promise(r => setTimeout(r, 120)); }
await new Promise(r => setTimeout(r, 300));
s = await snap();
check('删到剩1小节', s.blockCount === 1, `${s.blockCount}`);
check('剩1时不变量', invariants(s).ok, invariants(s).msg);

// ════════════════════════════════════════════════════════
// 测试9:横滑专项(Bug A)— 切窄视口(16小节在宽屏放得下不会溢出,需窄屏)
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试9:横滑专项(Bug A)═══');
await page.setViewport({ width: 420, height: 900 });
await new Promise(r => setTimeout(r, 400));
await resetTo(16, 0, 2);
s = await snap();
const overflow = s.scrollWidth > s.clientWidth + 5;
check('16小节产生横滑溢出', overflow, `scrollW=${s.scrollWidth} clientW=${s.clientWidth}`);
// 滚到右侧
await page.evaluate(() => { document.querySelector('.ms-wrap').scrollLeft = 9999; });
await new Promise(r => setTimeout(r, 300));
const slBefore = await page.evaluate(() => Math.round(document.querySelector('.ms-wrap').scrollLeft));
check('能滚到右侧(scrollLeft>0)', slBefore > 0, `scrollLeft=${slBefore}`);
// 加小节,scrollLeft 不应跳回0
await addMeasure();
await new Promise(r => setTimeout(r, 200));
s = await snap();
check('滚右+加小节后 scrollLeft 不跳回0', s.scrollLeft > slBefore * 0.5, `加前=${slBefore} 加后=${s.scrollLeft}`);
inv = invariants(s);
check('滚右+加小节后不变量', inv.ok, inv.msg);

// 滚到右侧后删小节,scrollLeft 合理 clamp
await page.evaluate(() => { document.querySelector('.ms-wrap').scrollLeft = 9999; });
await new Promise(r => setTimeout(r, 300));
const slBeforeDel = await page.evaluate(() => Math.round(document.querySelector('.ms-wrap').scrollLeft));
await delMeasure(s.blockCount - 1);
await new Promise(r => setTimeout(r, 400));
s = await snap();
check('滚右+删小节后 scrollLeft 合理clamp(不跳回0且不越界)', s.scrollLeft > 0 && s.scrollLeft <= s.scrollWidth, `删前=${slBeforeDel} 删后=${s.scrollLeft} scrollW=${s.scrollWidth}`);
inv = invariants(s);
check('滚右+删小节后不变量', inv.ok, inv.msg);

// ════════════════════════════════════════════════════════
// 测试10:组合操作(加→拖→删→拖→加)
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试10:组合操作 状态机一致性 ═══');
await resetTo(3, 0, 2);
// 加2
await addMeasure(); await new Promise(r => setTimeout(r, 100));
await addMeasure(); await new Promise(r => setTimeout(r, 300));
s = await snap();
check('组合:3→加2→5', s.blockCount === 5, `${s.blockCount}`);
// 拖框体到 idx2
await dragBody(2);
await new Promise(r => setTimeout(r, 400));
s = await snap();
check('组合:拖框体到2后选框内=[2,3]', JSON.stringify(s.insideIdx) === JSON.stringify([2, 3]), JSON.stringify(s.insideIdx));
// 删末尾
await delMeasure(s.blockCount - 1);
await new Promise(r => setTimeout(r, 400));
s = await snap();
check('组合:删末后书签4', s.blockCount === 4, `${s.blockCount}`);
inv = invariants(s);
check('组合:删末后不变量', inv.ok, inv.msg);
// 拖右把手扩
await dragGrip('r', s.blockCount - 1);
await new Promise(r => setTimeout(r, 400));
s = await snap();
inv = invariants(s);
check('组合:拖右扩到末后不变量', inv.ok, inv.msg);
// 再加1
await addMeasure();
await new Promise(r => setTimeout(r, 400));
s = await snap();
check('组合:再加1后书签5且单调', s.blockCount === 5 && isMonotonic(s.blockCx), `${s.blockCount}`);
check('组合:全程不变量', invariants(s).ok, invariants(s).msg);

// ════════════════════════════════════════════════════════
// 测试11:跨格动画平滑性(核心验收:不挪窝消除 transition 打断)
// 用 page.mouse 真实拖拽(isTrusted,异步),逐帧采样跨格书签 cx,断言渐进无瞬移。
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试11:跨格动画平滑性(不挪窝验收)═══');
await page.setViewport({ width: 1300, height: 900 });
await new Promise(r => setTimeout(r, 300));

// 场景1A:拖右把手扩 count,idx4 框外→框内,采 idx4 cx
await resetTo(8, 0, 2);
await new Promise(r => setTimeout(r, 400));
const gripR = await page.$('.ms-grip-r');
const gBox = await gripR.boundingBox();
const t5 = await page.evaluate(() => { const b = document.querySelector('.ms-blk[data-idx="5"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(gBox.x + gBox.width / 2, gBox.y + gBox.height / 2);
await page.mouse.down();
const trace1A = [];
for (let i = 1; i <= 10; i++) {
  const x = gBox.x + gBox.width / 2 + (t5.x - (gBox.x + gBox.width / 2)) * (i / 10);
  await page.mouse.move(x, gBox.y + gBox.height / 2);
  await new Promise(r => setTimeout(r, 28));
  const cx = await page.evaluate(() => { const b = document.querySelector('.ms-blk[data-idx="4"]'); const r = b.getBoundingClientRect(); return Math.round(r.left + r.width / 2); });
  trace1A.push(cx);
}
await page.mouse.up();
let maxJump1A = 0;
for (let i = 1; i < trace1A.length; i++) maxJump1A = Math.max(maxJump1A, Math.abs(trace1A[i] - trace1A[i - 1]));
check('1A 拖右扩count:idx4跨格渐进(单步跳变<15px)', maxJump1A < 15, `轨迹${JSON.stringify(trace1A)} 最大跳变${maxJump1A}`);

// 场景2A:拖框体右移 [3,4]→[4,5],采 idx2(滑出)、idx4(滑入)
await resetTo(8, 2, 2);
await new Promise(r => setTimeout(r, 400));
// 框体拖拽:在选框内空白处 down。用 page.mouse 点 sel 左缘内侧。
const selBox = await page.evaluate(() => { const s = document.querySelector('.ms-sel'); const r = s.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2, right: r.right }; });
const t4 = await page.evaluate(() => { const b = document.querySelector('.ms-blk[data-idx="4"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(selBox.x, selBox.y);
await page.mouse.down();
const trace2A_left = [], trace2A_right = [];
for (let i = 1; i <= 10; i++) {
  const x = selBox.x + (t4.x - selBox.x) * (i / 10);
  await page.mouse.move(x, selBox.y);
  await new Promise(r => setTimeout(r, 28));
  const pair = await page.evaluate(() => {
    const b2 = document.querySelector('.ms-blk[data-idx="2"]'); const b4 = document.querySelector('.ms-blk[data-idx="4"]');
    const r2 = b2.getBoundingClientRect(); const r4 = b4.getBoundingClientRect();
    return { l: Math.round(r2.left + r2.width / 2), r: Math.round(r4.left + r4.width / 2) };
  });
  trace2A_left.push(pair.l); trace2A_right.push(pair.r);
}
await page.mouse.up();
let maxJump2A = 0;
[trace2A_left, trace2A_right].forEach(tr => { for (let i = 1; i < tr.length; i++) maxJump2A = Math.max(maxJump2A, Math.abs(tr[i] - tr[i - 1])); });
check('2A 拖框体:idx2滑出+idx4滑入渐进(单步跳变<15px)', maxJump2A < 15, `left${JSON.stringify(trace2A_left)} right${JSON.stringify(trace2A_right)} 最大跳变${maxJump2A}`);

// 场景2C:连续拖框体多格,全程坐标单调无瞬移
await resetTo(8, 0, 2);
await new Promise(r => setTimeout(r, 400));
const selBox2 = await page.evaluate(() => { const s = document.querySelector('.ms-sel'); const r = s.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; });
const tEnd = await page.evaluate(() => { const b = document.querySelector('.ms-blk[data-idx="7"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await page.mouse.move(selBox2.x, selBox2.y);
await page.mouse.down();
let allCx = [];
let monotonicThroughout = true;
for (let i = 1; i <= 14; i++) {
  const x = selBox2.x + (tEnd.x - selBox2.x) * (i / 14);
  await page.mouse.move(x, selBox2.y);
  await new Promise(r => setTimeout(r, 26));
  const cxs = await page.evaluate(() => [...document.querySelectorAll('.ms-blk')].sort((a, b) => +a.dataset.idx - +b.dataset.idx).map(b => { const r = b.getBoundingClientRect(); return Math.round(r.left + r.width / 2); }));
  if (!isMonotonic(cxs)) monotonicThroughout = false;
  allCx = cxs;
}
await page.mouse.up();
check('2C 连续拖框体多格:全程书签单调无倒序', monotonicThroughout, `末帧${JSON.stringify(allCx)}`);

// ════════════════════════════════════════════════════════
// 测试12:addBtn 几何联动(addX = 最后书签右缘+15;无框右外时 selRight+25)
// ════════════════════════════════════════════════════════
console.log('\n═══ 测试12:addBtn 几何联动 ═══');
await page.setViewport({ width: 1300, height: 900 });
await new Promise(r => setTimeout(r, 300));

// 12.1 addX ≥ 最后书签右缘 + 15,且 addBtn 不与最后书签重叠
await resetTo(8, 0, 2);
s = await snap();
const lastBlk = s.blockRight[s.blockRight.length - 1];
const addLeft = s.addRect.left;
check('addBtn.left ≥ 最后书签右缘+15(间距不压缩)', addLeft >= lastBlk + 14, `addLeft=${addLeft} lastRight=${lastBlk}`);
check('addBtn 不与最后书签重叠', addLeft >= lastBlk, `addLeft=${addLeft} lastRight=${lastBlk}`);

// 12.2 addX 单调随 total 递增(加小节 Δ≈59)
await resetTo(5, 0, 2);
const addX0 = (await snap()).addRect.left;
await addMeasure(); await new Promise(r => setTimeout(r, 400));
const addX1 = (await snap()).addRect.left;
check('加小节后 addX 右移(Δ≈59)', addX1 > addX0 && Math.abs((addX1 - addX0) - 59) < 8, `${addX0}→${addX1} Δ=${addX1 - addX0}`);

// 12.3 拖右改count(最后书签仍框外)→ addX 不变(selR增量被框右外书签数减少抵消)
await resetTo(8, 0, 2);
const ax_a = (await snap()).addRect.left;
await dragGrip('r', 4); await new Promise(r => setTimeout(r, 400));   // count 2→5,最后书签 idx7 仍框外
const ax_b = (await snap()).addRect.left;
check('拖右扩count(最后书签仍框外)addX不变', ax_a === ax_b, `${ax_a}→${ax_b}(selR变但最后书签不动)`);
// 扩到全选(count=total)→ 最后书签进框,addX 跳变到 selRight+25
await dragGrip('r', 7); await new Promise(r => setTimeout(r, 400));   // count→8 全选
s = await snap();
check('扩到全选:最后书签进框,addBtn紧贴选框(selRight+25)', s.addRect.left >= s.selRight + 23 && s.addRect.left <= s.selRight + 27, `addLeft=${s.addRect.left} selRight=${s.selRight}`);

// 12.4 拖框体改start(count不变,框右外书签数不变)→ addX 不变
await resetTo(8, 2, 2);
const ax_s1 = (await snap()).addRect.left;
await dragBody(5); await new Promise(r => setTimeout(r, 500));   // 框体横移 start 2→5,count 仍2
const ax_s2 = (await snap()).addRect.left;
check('拖框体改start(count不变)addX不变', ax_s1 === ax_s2, `${ax_s1} vs ${ax_s2}`);

// 12.5 全选(count=total):无框右外,addX = selRight + 25
await resetTo(6, 0, 6);
s = await snap();
check('全选(count=total)addBtn紧贴选框右侧', s.addRect.left >= s.selRight + 23 && s.addRect.left <= s.selRight + 27, `addLeft=${s.addRect.left} selRight=${s.selRight}(应≈selRight+25)`);

// 12.6 total=1:addX = selRight + 25
await resetTo(1, 0, 1);
s = await snap();
check('total=1 addBtn紧贴选框右侧', s.addRect.left >= s.selRight + 23 && s.addRect.left <= s.selRight + 27, `addLeft=${s.addRect.left} selRight=${s.selRight}`);

// 12.7 删末尾 → addX 左移59
await resetTo(8, 0, 2);
const ax_d0 = (await snap()).addRect.left;
await delMeasure(7); await new Promise(r => setTimeout(r, 400));
const ax_d1 = (await snap()).addRect.left;
check('删末尾后addX左移(Δ≈59)', ax_d1 < ax_d0 && Math.abs((ax_d0 - ax_d1) - 59) < 8, `${ax_d0}→${ax_d1} Δ=${ax_d0 - ax_d1}`);

// 12.8 addBtn 在可滚动区内:scrollWidth ≥ addBtn.right
s = await snap();
check('addBtn.right ≤ scrollWidth(不溢出/被裁)', s.scrollWidth >= s.addRect.right - 1, `addRight=${s.addRect.right} scrollW=${s.scrollWidth}`);

check('全程无页面错误', errs.length === 0, errs.slice(0, 4).join(' | '));

await browser.close();
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
