// 端到端像素验证:编辑区高度动画 — 五线谱 staff lines 动画前后屏幕位置一致(dev=0)
// 方法:
//   1) 启动 vite dev server(puppeteer 连接)
//   2) 打开首页,等字体+首帧 render
//   3) 点击五线谱放一个中音(触发首帧 init 锚定),截图 A(动画前 staff 屏幕位置)
//   4) 读取 staff 屏幕 y(精确,app 内部锚定的同一量)
//   5) 点击五线谱上方很高的位置(放高音 → 触发顶部扩展动画)
//   6) 等动画完成(120ms + 余量),读取 staff 屏幕 y → dev = |y_after - y_before|
//   7) 截图 B(动画后),pngjs 对比五线谱局部区域像素差异
//   8) 同理验证低音扩展(简谱下移)、删除回缩
//
// 用法: node scripts/verify-height-anim-pixels.mjs
// (需先确保 google-chrome 可用;脚本自动启动/关闭 dev server)
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PORT = 5199;   // 避免和 5173 冲突
const URL = `http://localhost:${PORT}/`;
const TOL = 1;        // staff 屏幕位置容差(px)。动画机制应让 dev=0,给 1px 抗锯齿/亚像素余量。

// svg 元素五线谱 bottomLineY 的屏幕 y(= app.measureStaffYScreen 同款公式)
async function staffScreenY(page) {
  return await page.evaluate(() => {
    const svg = document.querySelector('.svg-host svg');
    if (!svg) return null;
    const sr = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return Math.round(sr.top + (121 - vb.y) * sr.height / vb.height);
  });
}

// 5 条 staff 横线(SVG 内部坐标:75, 86.5, 98, 109.5, 121;staffSpace=11.5)→ 屏幕 y 数组。
// 逐条对比这 5 条线,比单点 bottomLineY 更全面,且不受新符头/加线干扰(线本身位置固定)。
const STAFF_LINE_Y_SVG = [75, 86.5, 98, 109.5, 121];
async function staffLinesScreenY(page) {
  return await page.evaluate((ys) => {
    const svg = document.querySelector('.svg-host svg');
    if (!svg) return null;
    const sr = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return ys.map(y => Math.round(sr.top + (y - vb.y) * sr.height / vb.height));
  }, STAFF_LINE_Y_SVG);
}

// 对比两组 staff 线屏幕 y,返回最大偏差
function staffLinesMaxDev(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  return Math.max(...a.map((y, i) => Math.abs(y - b[i])));
}

// svg 内某 SVG-y 坐标 → 屏幕{ x: 中心, y } 用于模拟点击
async function svgYToScreen(page, svgY, svgX) {
  return await page.evaluate((y, x) => {
    const svg = document.querySelector('.svg-host svg');
    const host = document.querySelector('.svg-host');
    if (!svg || !host) return null;
    const sr = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const screenY = sr.top + (y - vb.y) * sr.height / vb.height;
    const screenX = sr.left + (x - vb.x || 0) * sr.width / vb.width;
    return { x: Math.round(screenX), y: Math.round(screenY) };
  }, svgY, svgX ?? 700);   // 默认点击靠右的待输入位
}

// 读取 layout 关键量(供日志 + 点击坐标换算)
async function readLayout(page) {
  return await page.evaluate(() => {
    const svg = document.querySelector('.svg-host svg');
    if (!svg) return null;
    const vb = svg.viewBox.baseVal;
    const host = document.querySelector('.svg-host');
    return {
      height: parseFloat(host.style.height) || 0,
      vbY: vb.y, vbH: vb.height, vbW: vb.width,
      svgRect: (() => { const r = svg.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
    };
  });
}

// 点击 svg 内指定 svgY(模拟用户放音:mousedown 记音高 + click 追加)
async function clickAtSvgY(page, svgY, svgX) {
  const pt = await svgYToScreen(page, svgY, svgX);
  if (!pt) throw new Error('无法换算点击坐标');
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await sleep(20);
  await page.mouse.up();
  await sleep(60);   // 等 click 事件 + render(rAF)
}

// 截取五线谱局部区域 PNG(以 staff 屏幕 y 为中心上下各取一段),返回 buffer
async function clipStaffRegion(page, staffY, halfH = 40) {
  const vY = Math.max(0, staffY - halfH);
  return await page.screenshot({ clip: { x: 200, y: vY, width: 700, height: halfH * 2 } });
}

// 比较 staff 区域两图:返回差异像素数 + 是否基本一致
function diffStaffPngs(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  // 尺寸可能因 scroll 微调不同,按最小公共尺寸比
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let diff = 0;
  let darkA = 0, darkB = 0;   // staff 线像素(深色)计数,验证线还在
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (a.width * y + x) << 2;
      const j = (b.width * y + x) << 2;
      const la = (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3;
      const lb = (b.data[j] + b.data[j + 1] + b.data[j + 2]) / 3;
      if (la < 120) darkA++;
      if (lb < 120) darkB++;
      if (Math.abs(la - lb) > 40) diff++;
    }
  }
  return { diff, total: w * h, darkA, darkB, pct: (diff / (w * h)) * 100 };
}

// ── 主流程 ──
let viteProc;
let browser;
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  cond ? passed++ : failed++;
}

try {
  // 1. 启动 dev server
  console.log('启动 vite dev server...');
  viteProc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: process.cwd(), stdio: 'pipe', shell: true,
  });
  // 等 server 就绪(轮询 URL)
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const res = await fetch(URL);
      if (res.ok) { ready = true; break; }
    } catch {}
  }
  if (!ready) throw new Error('dev server 未就绪');
  console.log('dev server 就绪:', URL);

  // 2. 启动浏览器
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  // 等字体 + 首帧 render
  await page.evaluate(() => document.fonts.ready);
  await sleep(400);

  // 确认 svgHost 存在
  const hasSvg = await page.evaluate(() => !!document.querySelector('.svg-host svg'));
  if (!hasSvg) throw new Error('svgHost svg 未渲染');

  // ═══ 场景 1:加高音(C8 附近)→ 五线谱屏幕不动 ═══
  console.log('\n═══ 场景 1:加高音(顶部扩展) ═══');
  // 先放一个中音 C4(step=-2,y=121-(-2)*5.75=132.5)让首帧 init 锚定
  const c4Y = 121 - (-2) * 5.75;  // =132.5
  await clickAtSvgY(page, c4Y, 300);
  await sleep(150);
  const y0 = await staffScreenY(page);
  const lines0 = await staffLinesScreenY(page);
  check('S1.0 初始 staff 屏幕位置可读', y0 !== null, `y=${y0} 5线=${JSON.stringify(lines0)}`);

  // 截图 A(动画前 staff 区域,宽 700 用于像素交叉验证)
  const pngA = await clipStaffRegion(page, y0, 60);
  fs.writeFileSync('tmp-staff-before-high.png', pngA);

  // 放高音:C8 step=18,y=121-18*5.75=17.5(在默认 viewBox 内,svgY=17.5 顶部附近)
  // 注:首帧后 viewBox 可能还没扩展,点击 y=17.5 会被 clickYToMidi 解析为高音 → 触发顶部扩展动画
  const c8Y = 121 - 18 * 5.75;  // 17.5
  await clickAtSvgY(page, c8Y, 400);
  await sleep(220);   // 等 120ms 动画 + 余量
  const y1 = await staffScreenY(page);
  const lines1 = await staffLinesScreenY(page);
  const dev1 = Math.abs(y1 - y0);
  check('S1.1 加高音后 staff(bottomLine)屏幕位置不变(dev≤1)', dev1 <= TOL, `y0=${y0} y1=${y1} dev=${dev1}`);
  const linesDev1 = staffLinesMaxDev(lines0, lines1);
  check('S1.2 加高音后 5 条 staff 线屏幕位置全不变(dev≤1)', linesDev1 <= TOL,
    `dev=${linesDev1} 前=${JSON.stringify(lines0)} 后=${JSON.stringify(lines1)}`);

  // 截图 B + 像素交叉验证(注意:高音 C8 符头+加线本身会出现在 staff 上方区域,
  // 故全区域差异会>3% 是预期内——主验证已由 S1.2 的 5 线逐条对比覆盖。这里只确认 staff 线仍存在)
  const pngB = await clipStaffRegion(page, y1, 60);
  fs.writeFileSync('tmp-staff-after-high.png', pngB);
  const d1 = diffStaffPngs(pngA, pngB);
  check('S1.3 staff 线仍存在(深色像素>0)', d1.darkB > 0 && d1.darkA > 0, `差异 ${d1.pct.toFixed(2)}%(含新增高音符头,预期偏高)`);

  const lay1 = await readLayout(page);
  console.log('    layout after high:', JSON.stringify(lay1));

  // ═══ 场景 2:加低音(A0 附近)→ 简谱下移,五线谱仍不动 ═══
  console.log('\n═══ 场景 2:加低音(底部扩展,简谱下移) ═══');
  const y0b = await staffScreenY(page);
  const lines0b = await staffLinesScreenY(page);
  const pngA2 = await clipStaffRegion(page, y0b, 60);
  // A0 step=-10,y=121-(-10)*5.75=178.5(五线谱下方,触发低音加线+简谱下移)
  const a0Y = 121 - (-10) * 5.75;  // 178.5
  await clickAtSvgY(page, a0Y, 500);
  await sleep(220);
  const y2 = await staffScreenY(page);
  const lines2 = await staffLinesScreenY(page);
  const dev2 = Math.abs(y2 - y0b);
  check('S2.1 加低音后 staff 屏幕位置不变(dev≤1)', dev2 <= TOL, `y0=${y0b} y2=${y2} dev=${dev2}`);
  check('S2.2 加低音后 5 条 staff 线屏幕位置全不变(dev≤1)', staffLinesMaxDev(lines0b, lines2) <= TOL,
    `dev=${staffLinesMaxDev(lines0b, lines2)}`);
  const pngB2 = await clipStaffRegion(page, y2, 60);
  const d2 = diffStaffPngs(pngA2, pngB2);
  check('S2.3 staff 区域像素基本一致(<3%,低音符头在下方不污染 staff 区)', d2.pct < 3, `差异 ${d2.pct.toFixed(2)}%`);
  const lay2 = await readLayout(page);
  console.log('    layout after low:', JSON.stringify(lay2));
  check('S2.4 加低音后高度增大', lay2.height > lay1.height, `H ${lay1.height}→${lay2.height}`);

  // ═══ 场景 3:删除回缩(Backspace)→ 五线谱仍不动 ═══
  console.log('\n═══ 场景 3:删除回缩 ═══');
  const y0c = await staffScreenY(page);
  const lines0c = await staffLinesScreenY(page);
  await page.keyboard.press('Backspace');
  await sleep(220);
  const y3 = await staffScreenY(page);
  const lines3 = await staffLinesScreenY(page);
  const dev3 = Math.abs(y3 - y0c);
  check('S3.1 删除后 staff 屏幕位置不变(dev≤1)', dev3 <= TOL, `y0=${y0c} y3=${y3} dev=${dev3}`);
  check('S3.2 删除后 5 条 staff 线屏幕位置全不变(dev≤1)', staffLinesMaxDev(lines0c, lines3) <= TOL,
    `dev=${staffLinesMaxDev(lines0c, lines3)}`);

  // ═══ 场景 4:hover 不触发动画/不跳动 ═══
  console.log('\n═══ 场景 4:hover(无高度变化)不跳动 ═══');
  const y0d = await staffScreenY(page);
  const lines0d = await staffLinesScreenY(page);
  // 在五线谱上方来回移动鼠标(高音区但不点击,只 hover 预览)
  await page.mouse.move(800, y0d - 30);
  await sleep(80);
  await page.mouse.move(820, y0d - 50);
  await sleep(150);
  const y4 = await staffScreenY(page);
  const lines4 = await staffLinesScreenY(page);
  const dev4 = Math.abs(y4 - y0d);
  check('S4.1 hover 后 staff 屏幕位置不变(dev≤1)', dev4 <= TOL, `y0=${y0d} y4=${y4} dev=${dev4}`);
  check('S4.2 hover 后 5 条 staff 线屏幕位置全不变(dev≤1)', staffLinesMaxDev(lines0d, lines4) <= TOL,
    `dev=${staffLinesMaxDev(lines0d, lines4)}`);

  // ═══ 场景 5:连续快速操作(加高音→立即加低音)不闪 ═══
  console.log('\n═══ 场景 5:连续操作(动画中打断) ═══');
  const y0e = await staffScreenY(page);
  const lines0e = await staffLinesScreenY(page);
  await clickAtSvgY(page, c8Y, 600);   // 加高音
  await sleep(30);                      // 动画进行中(未完成)
  await clickAtSvgY(page, a0Y, 650);   // 立即加低音,打断前一个动画
  await sleep(280);                     // 等最终稳定
  const y5 = await staffScreenY(page);
  const lines5 = await staffLinesScreenY(page);
  const dev5 = Math.abs(y5 - y0e);
  check('S5.1 连续操作后 staff 屏幕位置不变(dev≤2,允许多次打断稍宽松)', dev5 <= 2, `y0=${y0e} y5=${y5} dev=${dev5}`);
  check('S5.2 连续操作后 5 条 staff 线屏幕位置全不变(dev≤2)', staffLinesMaxDev(lines0e, lines5) <= 2,
    `dev=${staffLinesMaxDev(lines0e, lines5)}`);

  // ═══ 场景 6:增删音动画(JS rAF opacity 驱动验证) ═══
  console.log('\n═══ 场景 6:增删音过渡动画 ═══');
  // 6.1 新音淡入:点击放音,动画期间末尾音 opacity 应 <1(高频采样取最小,捕获起始低值帧)
  await clickAtSvgY(page, c4Y, 300);
  let minOp = 1;
  for (let i = 0; i < 10; i++) {
    await sleep(6);
    const op = await page.evaluate(() => {
      const els = document.querySelectorAll('[data-idx]');
      if (!els.length) return 1;
      const maxIdx = Math.max(...Array.from(els).map(e => parseInt(e.getAttribute('data-idx'))));
      const e = document.querySelector(`[data-idx="${maxIdx}"]`);
      return e ? parseFloat(getComputedStyle(e).opacity) : 1;
    });
    if (op < minOp) minOp = op;
  }
  check('S6.1 新音淡入期间 opacity<0.95(JS rAF 生效,证明在过渡而非恒定1)', minOp < 0.95, `动画中最小 opacity=${minOp.toFixed(3)}`);
  await sleep(250);   // 等动画结束 + 清理
  const opResidue = await page.evaluate(() => {
    const els = document.querySelectorAll('[data-idx]');
    if (!els.length) return 'no-elem';
    const maxIdx = Math.max(...Array.from(els).map(e => parseInt(e.getAttribute('data-idx'))));
    const e = document.querySelector(`[data-idx="${maxIdx}"]`);
    return e ? e.style.opacity : 'no-elem';
  });
  check('S6.2 新音淡入完成后无 inline opacity 残留', opResidue === '', `残留="${opResidue}"`);
  // 末尾音元素存在
  const lastIdx = await page.evaluate(() => {
    const els = document.querySelectorAll('[data-idx]');
    if (!els.length) return -1;
    return Math.max(...Array.from(els).map(e => parseInt(e.getAttribute('data-idx'))));
  });
  check('S6.3 末尾音元素存在(data-idx 末值>0)', lastIdx > 0, `lastIdx=${lastIdx}`);

  // 6.2 删除残影:按 Backspace 后,瞬间应出现 .fade-ghost,250ms 后被移除
  await page.keyboard.press('Backspace');
  await sleep(40);    // 残影刚挂上
  const ghostDuring = await page.evaluate(() => document.querySelectorAll('.fade-ghost').length);
  await sleep(250);   // 等淡出 + 移除
  const ghostAfter = await page.evaluate(() => document.querySelectorAll('.fade-ghost').length);
  check('S6.4 删除时残影层出现', ghostDuring >= 1, `删除瞬间 .fade-ghost=${ghostDuring}`);
  check('S6.5 删除淡出后残影层移除', ghostAfter === 0, `淡出后 .fade-ghost=${ghostAfter}`);

  // 6.3 指示器平移:放音后指示器 slide 到新位,动画结束后无 transform/animation 残留
  const slotBefore = await page.evaluate(() => {
    const s = document.querySelector('.next-slot');
    return s ? { x: Math.round(s.getBoundingClientRect().left), tf: s.style.transform, anim: s.style.animation } : null;
  });
  await clickAtSvgY(page, c4Y, 400);
  await sleep(250);
  const slotClean = await page.evaluate(() => {
    const s = document.querySelector('.next-slot');
    if (!s) return { exists: false };
    return { exists: true, transform: s.style.transform, animation: s.style.animation };
  });
  check('S6.6 指示器存在', slotClean.exists, '');
  check('S6.7 指示器平移结束后无 transform/animation 残留',
    slotClean.exists && !slotClean.transform && !slotClean.animation,
    `transform="${slotClean.transform}" animation="${slotClean.animation}"`);

  // ═══ 场景 7:tie 连音线淡入 + 和弦尾音淡入 ═══
  console.log('\n═══ 场景 7:tie 与和弦动画 ═══');
  // 重新加载获得干净上下文(前面场景累积状态不可控)
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(400);
  // 7.1 tie:放两个 C4,按 t 复制(tieRepeat),验证新 tie 弧线出现且随新音淡入
  await clickAtSvgY(page, c4Y, 350);
  await sleep(250);
  await clickAtSvgY(page, c4Y, 450);
  await sleep(250);
  await page.keyboard.press('t');   // tieRepeat
  await sleep(250);
  const tieState = await page.evaluate(() => ({
    tieCount: document.querySelectorAll('.tie-elem').length,
    // tie 随新音 JS opacity 淡入,结束后 inline opacity 应清空
    opResidue: Array.from(document.querySelectorAll('.tie-elem')).filter(e => e.style.opacity !== '').length,
  }));
  check('S7.1 tie 后产生弧线', tieState.tieCount >= 1, `tie弧线=${tieState.tieCount}`);
  check('S7.2 tie 淡入完成后无 inline opacity 残留', tieState.opResidue === 0, `残留=${tieState.opResidue}`);

  // 7.2 和弦:开和弦(c) + 放一个音 + 高音声部,验证尾音淡入后无残留
  await page.keyboard.press('c');
  await sleep(150);
  await clickAtSvgY(page, c4Y, 550);
  await sleep(250);
  // 高音声部(step=8 顶线,y=121-8*5.75=75)
  const topY = 121 - 8 * 5.75;
  await clickAtSvgY(page, topY, 550);
  await sleep(250);
  const chordResidue = await page.evaluate(() => {
    // 和弦尾音 JS opacity 淡入,结束后 inline opacity 应清空
    const idx = document.querySelectorAll('[data-idx]').length - 1;
    return Array.from(document.querySelectorAll(`[data-idx="${idx}"]`)).filter(e => e.style.opacity !== '').length;
  });
  check('S7.3 和弦尾音淡入完成后无 inline opacity 残留', chordResidue === 0, `残留=${chordResidue}`);
  // 关和弦
  await page.keyboard.press('c');
  await sleep(150);

  // 7.3 删和弦尾音:残影出现并淡出
  const ghostBefore = await page.evaluate(() => document.querySelectorAll('.fade-ghost').length);
  await page.keyboard.press('Backspace');
  await sleep(40);
  const ghostMid = await page.evaluate(() => document.querySelectorAll('.fade-ghost').length);
  await sleep(250);
  const ghostEnd = await page.evaluate(() => document.querySelectorAll('.fade-ghost').length);
  check('S7.4 删和弦尾音时残影出现', ghostMid >= 1 && ghostBefore === 0, `前=${ghostBefore} 中=${ghostMid}`);
  check('S7.5 删和弦尾音残影淡出后移除', ghostEnd === 0, `后=${ghostEnd}`);

  // ═══ 场景 8:连梁整组刷新 + 删除极端音无残影(避免与高度动画露馅) ═══
  console.log('\n═══ 场景 8:连梁刷新 + 删极端音 ═══');
  // 重新加载页面获得干净状态(前面场景的和弦/tie 状态会影响连梁判定,这里要纯单音八分序列)
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(400);
  await page.keyboard.press('4');   // eighth 时值
  await sleep(150);
  // 放 4 个八分音符形成 2 个连梁组(每拍 2 个八分)
  for (const x of [350, 410, 470, 530]) {
    await clickAtSvgY(page, c4Y, x);
    await sleep(230);
  }
  // 验证连梁组 class 存在(4 个八分 → 2 组,梁 polygon 带 beam-grp class)
  const beamDiag = await page.evaluate(() => ({
    beams: document.querySelectorAll('[class*="beam-grp-"]').length,
    noteElems: document.querySelectorAll('.note-elem').length,
    headXs: Array.from(document.querySelectorAll('text.note-elem')).slice(0, 6).map(h => parseFloat(h.getAttribute('x')).toFixed(0)),
  }));
  check('S8.1 八分音符形成连梁组(梁 polygon 带 beam-grp class)', beamDiag.beams >= 1, `梁元素=${beamDiag.beams} 音符元素=${beamDiag.noteElems} headXs=${beamDiag.headXs.join(',')}`);

  // S8.1b 连梁组刷新:整组(含老音符)参与透明变化。
  // reload 获得干净状态,放1个八分(独立 flag),再放第2个(与第1个形成连梁组),
  // 此时 idx0 从 flag 变连梁,采样 idx0 opacity 应 <1(整组刷新,老音符参与)
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(400);
  await page.keyboard.press('4'); await sleep(150);
  await clickAtSvgY(page, c4Y, 350);
  await sleep(300);   // 第1个八分(独立)
  await clickAtSvgY(page, c4Y, 420);   // 第2个,与第1个形成连梁组
  let oldMinOp = 1;
  for (let i = 0; i < 8; i++) {
    await sleep(8);
    const op = await page.evaluate(() => {
      const e = document.querySelector('[data-idx="0"]');
      return e ? parseFloat(getComputedStyle(e).opacity) : 1;
    });
    if (op < oldMinOp) oldMinOp = op;
  }
  check('S8.1b 连梁组形成时老音符(idx0)参与透明变化(opacity<0.95)', oldMinOp < 0.95, `idx0 最小opacity=${oldMinOp.toFixed(3)}`);

  // 再加一个八分(加入已有连梁组),验证整组梁淡入后无残留(连梁 polygon 随新音 JS opacity 淡入)
  await clickAtSvgY(page, c4Y, 650);
  await sleep(250);
  const beamResidue = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="beam-grp-"]')).filter(e => e.style.opacity !== '').length;
  });
  check('S8.2 新音加入连梁组后整组梁淡入完成无 inline opacity 残留', beamResidue === 0, `残留=${beamResidue}`);

  // 8.3 删普通音(高度不变):残影应出现
  const ghostNormalBefore = await page.evaluate(() => document.querySelectorAll('.fade-ghost').length);
  await page.keyboard.press('Backspace');
  await sleep(40);
  const ghostNormalMid = await page.evaluate(() => document.querySelectorAll('.fade-ghost').length);
  await sleep(250);
  check('S8.3 删普通音(高度不变)残影出现', ghostNormalMid >= 1 && ghostNormalBefore === 0, `前=${ghostNormalBefore} 中=${ghostNormalMid}`);

  // 8.4 删极端高音(触发高度回缩):此时不应出现残影(避免与 heightTick 露馅)
  // 先放一个高音 C8(触发顶部扩展),再删它(高度回缩)
  await clickAtSvgY(page, c8Y, 670);
  await sleep(250);
  // 切回 quarter 避免连梁干扰
  await page.keyboard.press('3'); await sleep(100);
  // 现在删 C8:高度回缩,应走 heightTick 路径,残影被跳过
  const staffBefore = await staffScreenY(page);
  await page.keyboard.press('Backspace');
  await sleep(40);
  const ghostHighMid = await page.evaluate(() => document.querySelectorAll('.fade-ghost').length);
  await sleep(250);
  const staffAfter = await staffScreenY(page);
  check('S8.4 删极端音(高度回缩)时不出现残影(避免露馅)', ghostHighMid === 0, `残影=${ghostHighMid}`);
  check('S8.5 删极端音后五线谱不动(dev≤1)', Math.abs(staffAfter - staffBefore) <= 1, `dev=${Math.abs(staffAfter - staffBefore)}`);

  console.log(`\n${failed === 0 ? '✅ 像素验证全部通过' : `❌ ${failed} 项失败`} (通过 ${passed}/${passed + failed})`);
} catch (err) {
  console.error('脚本异常:', err.message);
  console.error(err.stack);
  failed++;
} finally {
  // 清理临时截图(保留失败的以便排查)
  if (failed === 0) {
    for (const f of ['tmp-staff-before-high.png', 'tmp-staff-after-high.png']) {
      try { fs.unlinkSync(f); } catch {}
    }
  } else {
    console.log('(保留 tmp-staff-*.png 供排查)');
  }
  if (browser) await browser.close().catch(() => {});
  if (viteProc) viteProc.kill('SIGTERM');
}
process.exit(failed === 0 ? 0 : 1);
