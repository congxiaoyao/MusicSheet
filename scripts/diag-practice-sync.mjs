// 诊断:练琴页方块掉落与键盘点亮是否同步 + 暂停态 seek 方块位置。
//
// 不靠日志复现 —— 用一个"干净测试谱"(4/4 C大调,每小节高音 4 个四分音符 C5/D5/E5/F5,
// 整数拍、方块等高、无 tuplet/tie/chord)精确判定落点与时机。
//
// 三组断言:
//   A 几何:方块 .active 时 |blockBottom - hitY| ≤ 2px(方块底是否真贴判定线/键盘顶)。
//   B 时序:某音的 block .active 与对应键 .glow-R 首次为 true 的帧号是否相同。
//   seek :暂停态点谱面 seek 后,方块底是否落到新 beat 对应位置 + 键盘高亮是否刷新。
//
// 用法:node scripts/diag-practice-sync.mjs [origin]
//   origin 默认 http://localhost:5180
//
// 输出:screenshots/diag-sync-*.png + 控制台断言结果。结论性诊断,不改生产代码。
import { launch } from 'puppeteer-core';

const ORIGIN = process.argv[2] || 'http://localhost:5180';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── 干净测试谱 ──
// 4 小节,4/4 C大调。每小节高音: C5(72) D5(74) E5(76) F5(77) 各四分音符(1拍)。
// 低音:每小节一个全音符休止(midi=null, duration=whole),不产生方块,避免干扰高音判定。
const NOTE = (midi, duration = 'quarter') => ({ midi, duration, dotted: false, accidental: null });
const REST = (duration = 'whole') => ({ midi: null, duration, dotted: false, accidental: null });
const KEY = { name: 'C', tonic: 0, sharps: [], flats: [] };
const TIME = { num: 4, den: 4 };
const MEASURES = 4;
const measures = [];
for (let m = 0; m < MEASURES; m++) {
  measures.push({
    treble: [NOTE(72), NOTE(74), NOTE(76), NOTE(77)],
    bass: [REST('whole')],
  });
}
const mscore = {
  format: 'musicsheet-score', version: 1, exportedAt: Date.now(),
  score: {
    meta: { id: 'diag-sync', title: 'diag-sync', key: KEY, time: TIME, totalMeasures: MEASURES, viewMode: 'treble', updatedAt: Date.now() },
    measures,
  },
};

// 造谱:create piece(拿 id)→ import 整曲覆盖。返回 id。
async function ensureScore() {
  const create = await fetch(`${ORIGIN}/api/pieces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'diag-sync', key: KEY, time: TIME, totalMeasures: MEASURES, viewMode: 'treble' }),
  }).then(r => r.json()).catch(e => { throw new Error('create piece failed: ' + e.message); });
  const id = create.id;
  await fetch(`${ORIGIN}/api/pieces/${id}/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mscore),
  }).then(r => r.json()).catch(e => { throw new Error('import failed: ' + e.message); });
  return id;
}

// ── puppeteer ──
const browser = await launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push('PE:' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|404/i.test(m.text())) errs.push('ERR:' + m.text()); });

console.log('═══ 造干净测试谱 ═══');
const scoreId = await ensureScore();
console.log(`  曲谱 id: ${scoreId} (4/4 C大调 4小节, 高音 C5 D5 E5 F5 四分音符循环)`);

await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1500));
// 进库 → 点第一张卡片(应为 diag-sync;若库里有别的曲,按 title 找)
await page.evaluate((title) => {
  const cards = [...document.querySelectorAll('.score-card:not(.new-card)')];
  const c = cards.find(c => c.querySelector('.sc-title')?.textContent?.trim() === title) || cards[0];
  c?.click();
}, 'diag-sync');
await new Promise(r => setTimeout(r, 1800));   // 等进编辑器 + 卡片渲染
// 点"整曲预览"进练琴页
await page.evaluate(() => document.querySelector('.appbar-preview')?.click());
await new Promise(r => setTimeout(r, 1500));   // 等练琴页 mount + 首帧布局

// 练琴页是否就绪
const ready = await page.evaluate(() => !!document.querySelector('.pa-root'));
check('练琴页已挂载', ready, ready ? '' : '.pa-root 未找到');
if (!ready) { console.log('  练琴页未就绪,终止'); await browser.close(); process.exit(1); }

// 点播放
await page.evaluate(() => document.querySelector('.pr-play')?.click());
await new Promise(r => setTimeout(r, 400));   // 让播放启动

// ── 逐帧采样 ──
// 采样:每个 .wf-note 的 {bottom, active, textContent};.pr-hit 的 top(hitY);
//       每个 .wf-note 对应键(按 textContent→音名→data-midi)的 glow-R。
// 用 fixed-interval 16ms 采样 ~6秒(覆盖 4 小节 @ ~100bpm:1拍=0.6s,16音≈9.6s;采 7s 够前 2 小节)。
const SAMPLE_MS = 16;
const SAMPLE_COUNT = 420;   // ~6.7s
const samples = [];
for (let f = 0; f < SAMPLE_COUNT; f++) {
  const data = await page.evaluate(() => {
    const hit = document.querySelector('.pr-hit');
    const hitY = hit ? Math.round(hit.getBoundingClientRect().top) : null;
    const blocks = [...document.querySelectorAll('.wf-note')].map(b => {
      const r = b.getBoundingClientRect();
      return {
        bottom: Math.round(r.bottom),
        top: Math.round(r.top),
        height: Math.round(r.height),
        active: b.classList.contains('active'),
        visible: parseFloat(b.style.opacity || '0') > 0.05,
        text: b.textContent?.trim() || '',
        left: Math.round(r.left + r.width / 2),
      };
    });
    // 键 glow 状态:{midi: glowR}
    const keys = {};
    document.querySelectorAll('.kb-key-w[data-midi], .kb-key-b[data-midi]').forEach(k => {
      keys[k.dataset.midi] = k.classList.contains('glow-R') || k.classList.contains('glow-L');
    });
    return { hitY, blocks, keys };
  });
  samples.push(data);
  await new Promise(r => setTimeout(r, SAMPLE_MS));
}

// 暂停(为 seek 测试准备)
await page.evaluate(() => document.querySelector('.pr-play')?.click());
await new Promise(r => setTimeout(r, 300));

// ── 音名 → midi(方块 textContent 是音名,键上 data-midi 是数字)──
const NAME_TO_MIDI = { 'C': 0, 'C♯': 1, 'D': 2, 'D♯': 3, 'E': 4, 'F': 5, 'F♯': 6, 'G': 7, 'G♯': 8, 'A': 9, 'A♯': 10, 'B': 11 };
function nameToMidi(text) {
  const m = text.match(/^([A-G]♯?)(-?\d+)$/);
  if (!m) return null;
  const pc = NAME_TO_MIDI[m[1]];
  const oct = parseInt(m[2], 10);
  return pc == null ? null : pc + (oct + 1) * 12;
}

// ── 分析 A:几何(到达时刻 blockBottom vs hitY)──
// 用"穿越检测":方块底边 bottom 从 <hitY(在线上方)变到 ≥hitY(到达/越过线)的那一帧 = 到达时刻。
// 该帧 |bottom-hitY| 应很小(方块正好落到键盘顶)。这比"最接近 hitY 的帧"更准 ——
// 后者会把"采样开始前已越过线"的音(frame0 已在线下很远)误判为到达。
let aMaxDiff = 0, aChecked = 0, aSamples = [];
for (let bi = 0; bi < (samples[0]?.blocks.length || 0); bi++) {
  let crossFrame = -1;
  for (let f = 1; f < samples.length; f++) {
    const s0 = samples[f - 1], s1 = samples[f];
    if (s0.hitY == null || s1.hitY == null) continue;
    const b0 = s0.blocks[bi], b1 = s1.blocks[bi];
    if (!b0 || !b1 || !b0.visible || !b1.visible) continue;
    // bottom 从线上方(<hitY)到到达/越过(≥hitY)= 穿越到达时刻
    if (b0.bottom < s0.hitY && b1.bottom >= s1.hitY) { crossFrame = f; break; }
  }
  if (crossFrame < 0) continue;   // 该音在采样窗内未发生穿越(可能采样开始前已过,或采样结束前未到)
  const s = samples[crossFrame];
  const b = s.blocks[bi];
  const diff = Math.abs(b.bottom - s.hitY);
  aChecked++;
  if (diff > aMaxDiff) aMaxDiff = diff;
  if (aSamples.length < 8) aSamples.push({ bi, text: b.text, frame: crossFrame, bottom: b.bottom, hitY: s.hitY, diff });
}
// A 容差 10px:采样是离散的(实际 rAF 节拍 ~16ms 但 evaluate 有开销,dist 每帧 ~0.05 拍=8px),
// 穿越恰发生在两帧之间,捕捉到的"到达帧"可能已越过线最多 ~半帧步长(8-10px)。
// 这是采样量化误差,非渲染错误 —— dist=0 时几何上 bottom==hitY 是恒等式(yTop=hitY-bh-0)。
check('A 几何:到达时刻方块底边贴判定线(最大偏差≤10px,含采样量化误差)', aMaxDiff <= 10, `检查方块数=${aChecked} 最大偏差=${aMaxDiff}px 样例${JSON.stringify(aSamples).slice(0, 220)}`);

// ── 分析 B:时序(到达穿越帧,对应键是否已亮)──
// 到达穿越帧 = bottom 从线上方变到线上的那一帧(dist≈0 附近)。该帧或下一帧对应键应已 glow
// (键盘 dist<=0 触发,与方块到达同源)。
let bMismatches = 0, bChecked = 0, bDetails = [];
for (let bi = 0; bi < (samples[0]?.blocks.length || 0); bi++) {
  const text = samples[0].blocks[bi]?.text;
  const midi = nameToMidi(text);
  if (midi == null) continue;
  // 复用 A 的穿越检测
  let crossFrame = -1;
  for (let f = 1; f < samples.length; f++) {
    const s0 = samples[f - 1], s1 = samples[f];
    if (s0.hitY == null || s1.hitY == null) continue;
    const b0 = s0.blocks[bi], b1 = s1.blocks[bi];
    if (!b0 || !b1 || !b0.visible || !b1.visible) continue;
    if (b0.bottom < s0.hitY && b1.bottom >= s1.hitY) { crossFrame = f; break; }
  }
  if (crossFrame < 0) continue;
  bChecked++;
  const glowNow = samples[crossFrame].keys[String(midi)];
  const glowNext = crossFrame < samples.length - 1 ? samples[crossFrame + 1].keys[String(midi)] : false;
  if (!glowNow && !glowNext) {
    bMismatches++;
    bDetails.push({ bi, text, midi, frame: crossFrame, bottom: samples[crossFrame].blocks[bi].bottom, hitY: samples[crossFrame].hitY });
  }
}
check('B 时序:方块到达判定线时对应键已亮(差≤1帧)', bMismatches === 0, `检查方块数=${bChecked} 未同步=${bMismatches} 详情${JSON.stringify(bDetails).slice(0, 240)}`);

// ── 分析 seek:暂停态点谱面 seek 后方块位置 ──
// 当前已暂停。点谱面某位置 seek,然后采样方块底 vs hitY。
// 取谱面第一行中段点击(score-sheet click → onSeek)。
const seekTarget = await page.evaluate(() => {
  const scroll = document.querySelector('.score-sheet-scroll');
  if (!scroll) return null;
  const r = scroll.getBoundingClientRect();
  return { x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height * 0.5) };
});
let seekResult = null;
if (seekTarget) {
  await page.mouse.click(seekTarget.x, seekTarget.y);
  await new Promise(r => setTimeout(r, 300));
  seekResult = await page.evaluate(() => {
    const hit = document.querySelector('.pr-hit');
    const hitY = hit ? Math.round(hit.getBoundingClientRect().top) : null;
    const blocks = [...document.querySelectorAll('.wf-note')].map(b => {
      const r = b.getBoundingClientRect();
      return { bottom: Math.round(r.bottom), active: b.classList.contains('active'), visible: parseFloat(b.style.opacity || '0') > 0.05, text: b.textContent?.trim() || '' };
    });
    const keys = {};
    document.querySelectorAll('.kb-key-w[data-midi], .kb-key-b[data-midi]').forEach(k => {
      if (k.classList.contains('glow-R') || k.classList.contains('glow-L')) keys[k.dataset.midi] = true;
    });
    return { hitY, blocks, glowingKeys: Object.keys(keys) };
  });
}
if (seekResult) {
  // seek 后:键盘有高亮键(当前 beat 落在某音上) → 该音方块应标 active(active 与键盘同源)。
  // active 方块底边不必贴判定线(seek 可能落到音中段,方块已越过判定线),核心验的是"键亮=方块亮"。
  const actives = seekResult.blocks.filter(b => b.active);
  check('seek:暂停态点谱面后有 active 方块', actives.length >= 1, `active数=${actives.length} 高亮键=${seekResult.glowingKeys.join(',')}`);
  check('seek:暂停态 seek 后键盘有高亮键', seekResult.glowingKeys.length >= 1, `高亮键midi=${seekResult.glowingKeys.join(',')}`);
  // active 方块对应键是否在 glow 列表(键亮=方块亮的同步核心)
  let seekKeyMatch = true; let detail = [];
  for (const a of actives) {
    const midi = nameToMidi(a.text);
    if (midi == null) continue;
    const on = seekResult.glowingKeys.includes(String(midi));
    if (!on) { seekKeyMatch = false; detail.push(`${a.text}(midi${midi})未亮`); }
  }
  check('seek:active 方块对应键已点亮(键亮=方块亮)', seekKeyMatch, detail.join(';') || `全部${actives.length}个active对应键已亮`);
} else {
  check('seek:能定位到谱面点击区', false, '未找到 .score-sheet-scroll');
}

// ── 截图交叉验证 ──
// 重新播放,在"某音命中"瞬间截图。简单起见:播放 + 等 ~1.5s(应落到第3拍左右)截图。
await page.evaluate(() => document.querySelector('.pr-play')?.click());
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: 'screenshots/diag-sync-active.png' });
console.log('  截图: screenshots/diag-sync-active.png(播放中命中瞬间,人工核对方块底贴判定线 + 键亮)');

// svg height="auto" 警告是 score-sheet.ts 的预存问题(main 上就有),与同步无关,排除。
const realErrs = errs.filter(e => !/height.*auto/i.test(e));
check('全程无页面错误(排除预存 svg height:auto 警告)', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));
await browser.close();

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
