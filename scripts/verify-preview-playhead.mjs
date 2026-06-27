// 预览播放头交互验证(puppeteer 浏览器端):吸附 seek / 监听器泄漏 / 不每帧重建 SVG / 播放头跟随 / 无运行时错误
// 用法: node scripts/verify-preview-playhead.mjs  (需先 npm run dev, 默认 http://localhost:5173)
import { launch } from 'puppeteer-core';

const URL = process.argv[2] || 'http://localhost:5174';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=1100,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });

// 收集控制台错误(过滤 favicon 等资源 404 噪音,只关注 JS 运行时错误)
const consoleErrors = [];
page.on('console', m => {
  if (m.type() === 'error' && !/Failed to load resource|favicon|404/i.test(m.text())) consoleErrors.push(m.text());
});
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
await new Promise(r => setTimeout(r, 400));

// 切到双谱(grand)模式,输入不对称音符:treble 2 个四分(占 2 拍),bass 1 个二分(占 2 拍)
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.view-btn')];
  btns.find(b => b.textContent.includes('双谱'))?.click();
});
await new Promise(r => setTimeout(r, 200));

// 用内部 App 直接塞音符(避开复杂的点击坐标输入):treble 2 四分,bass 1 二分
// 通过点击谱面输入较难精确定位,这里直接操作 app 实例的数据层 + 触发渲染
await page.evaluate(() => {
  // 应用挂在 window 上? 看看。若无,用键盘快捷键: 3=四分, 数字键输入需要先点谱面。
  // 退而用 click:点激活卡谱面中央多次。这里先检测是否有全局 app 暴露。
  return typeof window.app !== 'undefined' || !!document.querySelector('#app');
});

// 用快捷键输入(需要先点中谱面): 3=四分(默认),点击谱面落音
// 先获取 treble 卡和 bass 卡的位置
const cardsInfo = await page.evaluate(() => {
  const hosts = [...document.querySelectorAll('.svg-host')];
  return hosts.map((h, i) => {
    const r = h.getBoundingClientRect();
    return { idx: i, top: r.top, left: r.left, width: r.width, height: r.height, cls: h.className };
  });
});
console.log('cards:', JSON.stringify(cardsInfo, null, 2));

// treble 卡:点谱面中央偏上(高音区 G4=中央C上一线),落 2 个四分音
// 五线谱中线(B4)大约在卡顶部偏下一点。点 (left+宽度*0.3, top+高度*0.45) 落音
async function tapCard(idx, xRatio, yRatio) {
  await page.evaluate((i, xr, yr) => {
    const hosts = document.querySelectorAll('.svg-host');
    const h = hosts[i];
    if (!h) return;
    const r = h.getBoundingClientRect();
    const x = r.left + r.width * xr;
    const y = r.top + r.height * yr;
    // 模拟 mousedown → mouseup → click(匹配 bindCard 的落音逻辑)
    const fire = (type) => h.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
    fire('mousedown');
    fire('mouseup');
    fire('click');
  }, idx, xRatio, yRatio);
  await new Promise(r => setTimeout(r, 120));
}

// treble(索引0):落 2 个四分音(默认时值已是 quarter,工具栏默认)
await tapCard(0, 0.3, 0.45);
await tapCard(0, 0.4, 0.42);

// bass(索引1):先切激活(点一下),再改时值为二分(按 '2'),落 1 个二分音
await page.evaluate(() => {
  const hosts = document.querySelectorAll('.svg-host');
  const h = hosts[1]; if (!h) return;
  const r = h.getBoundingClientRect();
  const ev = (t) => h.dispatchEvent(new MouseEvent(t, { clientX: r.left + r.width*0.5, clientY: r.top + r.height*0.55, bubbles: true }));
  ev('mousedown'); ev('mouseup'); ev('click'); // 点 bass 卡切换激活(grand 模式点非激活卡只切换不落音)
});
await new Promise(r => setTimeout(r, 120));
await page.keyboard.press('2'); // 二分音符
await new Promise(r => setTimeout(r, 100));
await tapCard(1, 0.5, 0.55);

const noteCount = await page.evaluate(() => {
  // 读取状态栏文本了解音符数
  return document.querySelector('.status-text, [class*="status"]')?.textContent || '';
});
console.log('状态栏:', noteCount);

// 切到预览模式
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.view-btn')];
  btns.find(b => b.textContent.includes('预览'))?.click();
});
await new Promise(r => setTimeout(r, 300));

// ── 验证1:预览模式已渲染双谱表 ──
const previewSvg = await page.evaluate(() => {
  const host = document.querySelector('.preview-host');
  return {
    hasSvg: !!host?.querySelector('svg'),
    hasTrebleGroup: !!host?.querySelector('.grand-treble'),
    hasBassGroup: !!host?.querySelector('.grand-bass'),
    hasPlayheadLayer: !!host?.querySelector('.playhead-layer'),
  };
});
check('预览:双谱表已渲染', previewSvg.hasSvg && previewSvg.hasTrebleGroup && previewSvg.hasBassGroup, JSON.stringify(previewSvg));
check('预览:播放头层已挂载', previewSvg.hasPlayheadLayer);

// ── 验证2:点击吸附(点击不同位置,播放头落在音符上) ──
// 点预览区靠左位置
const snap = await page.evaluate(async () => {
  const host = document.querySelector('.preview-host');
  if (!host) return null;
  const r = host.getBoundingClientRect();
  const x = r.left + r.width * 0.22;
  const y = r.top + r.height * 0.5;
  const ev = (t) => host.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, bubbles: true }));
  ev('mousedown'); ev('mouseup');
  await new Promise(res => setTimeout(res, 80));
  const ph = host.querySelector('.pb-playhead');
  const layer = host.querySelector('.playhead-layer');
  return { phLeft: ph?.style.left, hasPh: !!ph, layerDisplay: layer?.style.display };
});
check('预览:点击后播放头出现', snap?.hasPh && snap?.layerDisplay !== 'none', JSON.stringify(snap));

// ── 验证3:监听器泄漏(反复进出预览模式 N 次,检查 window 监听器不暴增) ──
// 监听 window mousemove/mouseup 次数难以直接计数,改用行为:多次切换后拖拽 seek 不应崩溃
const leakTest = await page.evaluate(async () => {
  const clickView = (text) => {
    const b = [...document.querySelectorAll('.view-btn')].find(x => x.textContent.includes(text));
    b?.click();
  };
  // 来回切 6 次
  for (let i = 0; i < 6; i++) {
    clickView('双谱'); await new Promise(r => setTimeout(r, 120));
    clickView('预览'); await new Promise(r => setTimeout(r, 120));
  }
  // 现在在预览模式,拖拽 seek 测试不崩溃
  const host = document.querySelector('.preview-host');
  const r = host.getBoundingClientRect();
  const ev = (type, x) => host.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: r.top + 10, bubbles: true }));
  ev('mousedown', r.left + r.width * 0.3);
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width * 0.6, clientY: r.top + 10 }));
  window.dispatchEvent(new MouseEvent('mouseup', {}));
  await new Promise(res => setTimeout(res, 100));
  const ph = host.querySelector('.pb-playhead');
  return { moved: !!ph, left: ph?.style.left };
});
check('泄漏:6次切换后拖拽 seek 正常', leakTest?.moved, JSON.stringify(leakTest));

// ── 验证4:播放中 onTick 不每帧重建 SVG ──
// 修复前:updatePlayheadAndHighlight 每帧调 renderPreview() → innerHTML 重建 → SVG 节点更换
// 修复后:onTick 只切 class + 改播放头 style,SVG 节点保持。
// 注意:播放开始时 onStateChange('playing')→render() 会重建一次(合理),所以要先等状态稳定再标记。
const rebuildTest = await page.evaluate(async () => {
  const host = document.querySelector('.preview-host');
  if (!host) return null;
  // 点播放
  const playBtn = document.querySelector('.pb-tbtn.main');
  if (!playBtn?.textContent.includes('⏸')) playBtn?.click();
  // 等状态稳定(onStateChange 触发的一次性 render 完成)
  await new Promise(r => setTimeout(r, 250));
  // 标记当前 SVG 节点
  const svgBefore = host.querySelector('svg');
  if (!svgBefore) return { err: 'no svg after play' };
  svgBefore.setAttribute('data-mark', 'kept');
  // 让 onTick 跑若干帧(~300ms ≈ 18帧)
  await new Promise(r => setTimeout(r, 300));
  const svgAfter = host.querySelector('svg');
  const stillMarked = svgAfter?.getAttribute('data-mark') === 'kept';
  // 停止
  const stop = [...document.querySelectorAll('.pb-tbtn')].find(b => b.textContent.includes('⏹'));
  stop?.click();
  return { stillMarked };
});
check('性能:播放中 onTick 不重建 SVG', rebuildTest?.stillMarked, JSON.stringify(rebuildTest));

// ── 验证4b:点击吸附精确性 — 点击二分音符中间,播放头应落在最近音的中心 ──
// 场景:treble 2个四分(中心在 ~第1/3、~第2/3 处),bass 1个二分(中心在 ~第1/2 处)。
// 点击 50%(bass 二分音符正中)→ 距 bass 中心最近 → 播放头应吸附到 bass 音中心位置(非点击的50%)。
const snapPrecise = await page.evaluate(async () => {
  const host = document.querySelector('.preview-host');
  if (!host) return null;
  const svg = host.querySelector('svg');
  const svgR = svg.getBoundingClientRect();
  const hostR = host.getBoundingClientRect();
  // 读取预览区里 treble/bass 两组的 [data-idx] 元素,算各音符中心 x(svg 内部 px)
  const gather = (sel) => {
    const els = host.querySelectorAll(sel + ' [data-idx]');
    const xs = new Map();   // idx -> [x...](一个 idx 可能多个元素:符头/符干)
    els.forEach(el => {
      const idx = el.getAttribute('data-idx');
      // 用元素 transform 后的中心:读 bbox 较稳。但 SVG 元素 getBBox 是未变换的。
      // 改用 getBoundingClientRect 转 svg 内部坐标。
      const r = el.getBoundingClientRect();
      const cx = ((r.left + r.width / 2) - svgR.left) / svgR.width;
      if (!xs.has(idx)) xs.set(idx, cx);
    });
    return xs;
  };
  const tXs = gather('.grand-treble');
  const bXs = gather('.grand-bass');
  // 点击 50% 处
  const clickX = hostR.left + hostR.width * 0.5;
  const ev = (type) => host.dispatchEvent(new MouseEvent(type, { clientX: clickX, clientY: hostR.top + 10, bubbles: true }));
  ev('mousedown'); ev('mouseup');
  await new Promise(res => setTimeout(res, 100));
  const ph = host.querySelector('.pb-playhead');
  const phLeftPct = parseFloat(ph?.style.left || '-1');
  // 播放头中心(left + width/2)转 svg 内部比例
  const phWPct = parseFloat(ph?.style.width || '0');
  const phCenterRatio = phLeftPct / 100 + phWPct / 200;
  return { tXs: [...tXs.values()], bXs: [...bXs.values()], phCenterRatio, clickRatio: 0.5 };
});
if (snapPrecise) {
  // 播放头中心应贴近某个真实音符中心(容差 0.06),而不是停在点击的 0.5 线性点(吸附生效的标志)
  const allXs = [...(snapPrecise.tXs || []), ...(snapPrecise.bXs || [])];
  const minDist = allXs.length ? Math.min(...allXs.map(x => Math.abs(x - snapPrecise.phCenterRatio))) : 1;
  const onNote = minDist < 0.06;
  check('吸附:点击50%后播放头落在音符中心(非线性点)', onNote,
    `ph中心=${snapPrecise.phCenterRatio.toFixed(3)} 最近音距=${minDist.toFixed(3)}`);
}

// ── 验证4c:播放头跟随 — 当只有 bass 在响时,播放头不卡在 treble 旧位 ──
// 4拍场景:bass 二分占 0-2 拍;treble 两四分占 0-1、1-2 拍。两组都在 0-2 拍响。
// 关键:seek 到接近末尾(如 beat 1.9,两组都仍在响),播放头应在 treble 第2音/bass 音的共同 x 处,
// 不应残留。这里验证 seek 后播放头 left 合理(在谱面右半区,非卡在 0)。
const followTest = await page.evaluate(async () => {
  const host = document.querySelector('.preview-host');
  const r = host.getBoundingClientRect();
  // 点谱面 ~85% 处(接近尾部)
  const x = r.left + r.width * 0.85;
  const ev = (t) => host.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: r.top + 10, bubbles: true }));
  ev('mousedown'); ev('mouseup');
  await new Promise(res => setTimeout(res, 100));
  const ph = host.querySelector('.pb-playhead');
  return { left: parseFloat(ph?.style.left || '-1'), width: parseFloat(ph?.style.width || '0') };
});
check('跟随:seek 到尾部播放头落在右半区(非卡 0)', followTest?.left > 20,
  `left=${followTest?.left?.toFixed(1)}%`);

// ── 验证5:无运行时错误 ──
check('运行时无 console/page 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter(r => !r.ok).length;
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`} (${results.filter(r => r.ok).length}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
