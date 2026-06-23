// 数据层验证:编辑区动态高度(扩展/删除回缩/和弦/hover/边界)
// 用法: npx tsx scripts/verify-dynamic-height.mjs
import { createPiece, appendNote } from '../src/core/model.ts';
import { computeLayout } from '../src/render/layout.ts';
import { resolvePitch } from '../src/core/theory.ts';

const CK = { name: 'C', tonic: 0, sharps: [], flats: [] };
const T44 = { num: 4, den: 4 };

let pass = 0, fail = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 得 ${JSON.stringify(got)} / 期 ${JSON.stringify(expect)}`);
  ok ? pass++ : fail++;
}
// 中音区默认值(无扩展):height=249.5,staffTop=75,jianpuTop=155.5
// 默认 jianpuTop=155.5 已预留 C4(中央C)下加线空间,故空谱→C4 不上缩跳动。
function lay(piece, hoverMidi) {
  return computeLayout(piece, 940, 'quarter', undefined, undefined, hoverMidi);
}
function stepY(step, l) { return l.bottomLineY - step * l.staffSpace / 2; }

console.log('═══ A. 扩展(基本) ═══');
const pMid = createPiece(); pMid.time = T44; pMid.key = CK; pMid.measureCount = 1;
appendNote(pMid, { midi: 60, duration: 'quarter', dotted: false, accidental: null });
appendNote(pMid, { midi: 72, duration: 'quarter', dotted: false, accidental: null });
const lMid = lay(pMid);
check('A1 中音区 staffTop=75', lMid.staffTop, 75);
check('A1 中音区 viewBoxYOffset=0', lMid.viewBoxYOffset, 0);
// C4(step-2)下加线 y+PAD=155.5 = 默认基准,简谱位置不变(不触发下移);E5 在五线谱内不触发顶部
check('A1 C4下加线 jianpuTop=155.5(=默认基准)', lMid.jianpuTop, 155.5);

const pHigh = createPiece(); pHigh.time = T44; pHigh.key = CK; pHigh.measureCount = 1;
appendNote(pHigh, { midi: 108, duration: 'quarter', dotted: false, accidental: null }); // C8
const lHigh = lay(pHigh);
const c8Step = resolvePitch(108, 'treble', CK, null).step;
const c8Y = stepY(c8Step, lHigh);
check('A2 C8 viewBoxYOffset>0(顶部扩展)', lHigh.viewBoxYOffset > 0, true);
check('A2 C8 符头 y + viewBoxYOffset > 0(不被裁)', c8Y + lHigh.viewBoxYOffset > 0, true);

const pLow = createPiece(); pLow.time = T44; pLow.key = CK; pLow.measureCount = 1;
appendNote(pLow, { midi: 21, duration: 'quarter', dotted: false, accidental: null }); // A0
const lLow = lay(pLow);
const a0Step = resolvePitch(21, 'treble', CK, null).step;
check('A3 A0 jianpuTop>155.5(简谱下移)', lLow.jianpuTop > 155.5, true);
check('A3 A0 height>249.5(底部扩展)', lLow.height > 249.5, true);

const pBoth = createPiece(); pBoth.time = T44; pBoth.key = CK; pBoth.measureCount = 1;
appendNote(pBoth, { midi: 108, duration: 'quarter', dotted: false, accidental: null });
appendNote(pBoth, { midi: 21, duration: 'quarter', dotted: false, accidental: null });
const lBoth = lay(pBoth);
check('A4 两端 viewBoxYOffset>0', lBoth.viewBoxYOffset > 0, true);
check('A4 两端 jianpuTop>155.5', lBoth.jianpuTop > 155.5, true);
check('A4 两端 height 显著>259', lBoth.height > 300, true);

console.log('\n═══ B. 删除回缩(核心边界) ═══');
// B1: [C8] → 删 C8 → 回 249.5
const pB1 = createPiece(); pB1.time = T44; pB1.key = CK; pB1.measureCount = 1;
appendNote(pB1, { midi: 108, duration: 'quarter', dotted: false, accidental: null });
const lB1a = lay(pB1);
pB1.notes.pop();  // 删 C8
const lB1b = lay(pB1);
check('B1 [C8]扩展→删C8 height 回 249.5', lB1b.height, 249.5);
check('B1 删C8 viewBoxYOffset 回 0', lB1b.viewBoxYOffset, 0);

// B2: [A0] → 删 A0 → 回 249.5
const pB2 = createPiece(); pB2.time = T44; pB2.key = CK; pB2.measureCount = 1;
appendNote(pB2, { midi: 21, duration: 'quarter', dotted: false, accidental: null });
pB2.notes.pop();
const lB2 = lay(pB2);
check('B2 [A0]→删A0 height 回 249.5', lB2.height, 249.5);
check('B2 删A0 jianpuTop 回 155.5', lB2.jianpuTop, 155.5);

// B3: [C8, A0] → 删 C8 → 顶部回缩、底部仍扩展
const pB3 = createPiece(); pB3.time = T44; pB3.key = CK; pB3.measureCount = 1;
appendNote(pB3, { midi: 108, duration: 'quarter', dotted: false, accidental: null });
appendNote(pB3, { midi: 21, duration: 'quarter', dotted: false, accidental: null });
const lB3a = lay(pB3);
pB3.notes.shift();  // 删 C8
const lB3b = lay(pB3);
check('B3 [C8,A0]删C8 顶部回缩(viewBoxYOffset=0)', lB3b.viewBoxYOffset, 0);
check('B3 [C8,A0]删C8 底部仍扩展(jianpuTop>155.5)', lB3b.jianpuTop > 155.5, true);

// B4: [C8, A0] → 删 A0 → 底部回缩、顶部仍扩展
const pB4 = createPiece(); pB4.time = T44; pB4.key = CK; pB4.measureCount = 1;
appendNote(pB4, { midi: 108, duration: 'quarter', dotted: false, accidental: null });
appendNote(pB4, { midi: 21, duration: 'quarter', dotted: false, accidental: null });
pB4.notes.pop();  // 删 A0
const lB4 = lay(pB4);
check('B4 [C8,A0]删A0 顶部仍扩展(viewBoxYOffset>0)', lB4.viewBoxYOffset > 0, true);
check('B4 [C8,A0]删A0 底部回缩(jianpuTop=155.5)', lB4.jianpuTop, 155.5);

// B5: [C8] → 删C8 空谱
const pB5 = createPiece(); pB5.time = T44; pB5.key = CK; pB5.measureCount = 1;
appendNote(pB5, { midi: 108, duration: 'quarter', dotted: false, accidental: null });
pB5.notes.pop();
const lB5 = lay(pB5);
check('B5 空谱 height=249.5', lB5.height, 249.5);
check('B5 空谱 viewBoxYOffset=0', lB5.viewBoxYOffset, 0);
check('B5 空谱 jianpuTop=155.5', lB5.jianpuTop, 155.5);

// B6: [C8, C4] → 删 C8 → 按中音 C4 重算(C4 下加线 y+PAD=155.5 = 默认基准,简谱位置=默认)
const pB6 = createPiece(); pB6.time = T44; pB6.key = CK; pB6.measureCount = 1;
appendNote(pB6, { midi: 108, duration: 'quarter', dotted: false, accidental: null });
appendNote(pB6, { midi: 60, duration: 'quarter', dotted: false, accidental: null });
pB6.notes.shift();  // 删 C8
const lB6 = lay(pB6);
check('B6 [C8,C4]删C8 顶部回缩 viewBoxYOffset=0', lB6.viewBoxYOffset, 0);
check('B6 C4下加线 jianpuTop=155.5(=默认基准)', lB6.jianpuTop, 155.5);

console.log('\n═══ C. 和弦删除 ═══');
// C1: 和弦 [C4, E5, C8] → 删 C8 → 按 E5 重算
const pC1 = createPiece(); pC1.time = T44; pC1.key = CK; pC1.measureCount = 1;
appendNote(pC1, { midi: 60, duration: 'quarter', dotted: false, accidental: null, chordId: 'g1' });
appendNote(pC1, { midi: 76, duration: 'quarter', dotted: false, accidental: null, chordId: 'g1' }); // E5
appendNote(pC1, { midi: 108, duration: 'quarter', dotted: false, accidental: null, chordId: 'g1' }); // C8
const lC1a = lay(pC1);
pC1.notes.pop();  // 删 C8,剩 C4 E5
const lC1b = lay(pC1);
check('C1 [C4,E5,C8]删C8 顶部回缩(viewBoxYOffset=0,E5不触发)', lC1b.viewBoxYOffset, 0);

// C2: 和弦 [A0, C4, E5] → 删 A0 → 按 C4/E5 重算(C4 下加线 y+PAD=155.5 = 默认基准)
const pC2 = createPiece(); pC2.time = T44; pC2.key = CK; pC2.measureCount = 1;
appendNote(pC2, { midi: 21, duration: 'quarter', dotted: false, accidental: null, chordId: 'g2' }); // A0
appendNote(pC2, { midi: 60, duration: 'quarter', dotted: false, accidental: null, chordId: 'g2' });
appendNote(pC2, { midi: 76, duration: 'quarter', dotted: false, accidental: null, chordId: 'g2' });
pC2.notes.shift();  // 删 A0
const lC2 = lay(pC2);
check('C2 [A0,C4,E5]删A0 jianpuTop=155.5(=默认基准)', lC2.jianpuTop, 155.5);

// C3: 和弦全极端 [A0, C8] → 删 A0 → 按 C8 顶部仍扩展,底部回缩
const pC3 = createPiece(); pC3.time = T44; pC3.key = CK; pC3.measureCount = 1;
appendNote(pC3, { midi: 21, duration: 'quarter', dotted: false, accidental: null, chordId: 'g3' });
appendNote(pC3, { midi: 108, duration: 'quarter', dotted: false, accidental: null, chordId: 'g3' });
pC3.notes.shift();  // 删 A0
const lC3 = lay(pC3);
check('C3 [A0,C8]删A0 顶部仍扩展', lC3.viewBoxYOffset > 0, true);
check('C3 底部回缩 jianpuTop=155.5', lC3.jianpuTop, 155.5);

console.log('\n═══ D. hover 交互 ═══');
// D1: 空谱 + hover C8 → 顶部扩展
const pD1 = createPiece(); pD1.time = T44; pD1.key = CK; pD1.measureCount = 1;
const lD1 = lay(pD1, 108);
check('D1 空谱+hover C8 viewBoxYOffset>0', lD1.viewBoxYOffset > 0, true);
// D2: [C4] + hover A0 → 底部扩展
const pD2 = createPiece(); pD2.time = T44; pD2.key = CK; pD2.measureCount = 1;
appendNote(pD2, { midi: 60, duration: 'quarter', dotted: false, accidental: null });
const lD2 = lay(pD2, 21);
check('D2 [C4]+hover A0 jianpuTop>155.5', lD2.jianpuTop > 155.5, true);
// D3: hover 移除 → 按 notes 重算(C4 下加线 y+PAD=155.5 = 默认基准)
const lD3 = lay(pD2, undefined);
check('D3 hover移除 jianpuTop=155.5(=默认基准)', lD3.jianpuTop, 155.5);

console.log('\n═══ E. 边界临界值 ═══');
// E1: 最高音恰好 y_top = 0 附近(临界不扩展或刚扩展)。用 A5(step10)
const pE1 = createPiece(); pE1.time = T44; pE1.key = CK; pE1.measureCount = 1;
appendNote(pE1, { midi: 81, duration: 'quarter', dotted: false, accidental: null }); // A5 step10
const lE1 = lay(pE1);
// A5 y = 121 - 10*5.75 = 63.5, headHalf≈13.4, 63.5-13.4-23 = 27 > 0 → 不扩展
check('E1 A5(step10)不触发扩展 viewBoxYOffset=0', lE1.viewBoxYOffset, 0);

// E3: 极高音(C8)多次,viewBoxYOffset 有限(不无限大)
const pE3 = createPiece(); pE3.time = T44; pE3.key = CK; pE3.measureCount = 1;
appendNote(pE3, { midi: 108, duration: 'quarter', dotted: false, accidental: null });
const lE3 = lay(pE3);
check('E3 C8 viewBoxYOffset 合理(<100)', lE3.viewBoxYOffset < 100 && lE3.viewBoxYOffset > 0, true);

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`} (通过 ${pass}/${pass + fail})`);
if (fail > 0) process.exit(1);
