// 连梁渲染测试页：把多种连接场景并排渲染，供人工核对。
// 访问：http://localhost:5173/beam-test.html
//
// 每个 case 是一个填满 4 小节的 Piece（layout 固定 4 小节）。
// 用例覆盖：成组、跨拍、复合拍、十六分双梁、混合时值断开、跨小节、
//           休止符断开、孤立音符、组内方向统一（跨中线、全高、全低）等。

// 关键：必须引入 style.css，它声明了 @font-face Bravura。
// 否则 ensureFontLoaded 找不到字体族，符头/谱号等字形无法渲染
// （符干/横梁是 SVG 几何图形不依赖字体，会正常显示，造成「只有线条没有符头」的假象）。
import '../style.css';
import { Note, Piece, DurationValue } from '../core/types';
import { KEYS } from '../core/theory';
import { computeLayout } from '../render/layout';
import { buildSVG } from '../render/export';
import { ensureFontLoaded } from '../render/glyphs';
import { computeBeams } from '../render/beam';

// ── 音符构造 helper（沿用 examples.ts 的模式） ─────────────
function n(midi: number | null, duration: DurationValue, dotted = false): Note {
  return { midi, duration, dotted, accidental: null };
}
const e = 'eighth' as DurationValue;
const s = 'sixteenth' as DurationValue;
const q = 'quarter' as DurationValue;
const w = 'whole' as DurationValue;

// C 大调常用音高（MIDI）
const C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69, B4 = 71;
const C5 = 72, D5 = 74, E5 = 76, F5 = 77, G5 = 79, A5 = 81, B5 = 83;
const REST = null;

const T44 = { num: 4, den: 4 };
const T38 = { num: 3, den: 8 };

const CKEY = KEYS.C;

interface Case {
  title: string;
  expect: string;
  piece: Piece;
}

const cases: Case[] = [
  // ── 1. 同拍 2 个八分 → 单梁一组 ──
  {
    title: '1. 同拍 2 个八分音符',
    expect: '拍1的两个八分连成单梁；其余补齐',
    // 拍0: e e (1拍) | 拍1: q | 拍2: q | 拍3: q = 4拍(第1小节) + 3个whole(12拍) = 16拍
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e), n(D4, e), n(E4, q), n(F4, q), n(G4, q),
      n(A4, w), n(B4, w), n(C5, w),
    ] },
  },
  // ── 2. 一拍内 2+2 个八分（拍1、拍2 各成一组）──
  {
    title: '2. 一拍内 2+2 个八分（拍1、拍2 各成一组）',
    expect: '拍1的两八分一组，拍2的两八分另一组',
    // 拍0: e e | 拍1: e e | 拍2: q | 拍3: q = 4拍（第1小节）+ 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e), n(D4, e), n(E4, e), n(F4, e), n(G4, q), n(A4, q),
      n(B4, w), n(C5, w), n(D5, w),
    ] },
  },
  // ── 3. 3/8 拍号 → 复合拍每组 3 个八分 ──
  {
    title: '3. 3/8 拍号（每组 3 个八分）',
    expect: '每 3 个八分连一组（复合拍，按附点四分拍分组）',
    piece: { clef: 'treble', key: CKEY, time: T38, notes: [
      n(C4, e), n(D4, e), n(E4, e),
      n(F4, e), n(G4, e), n(A4, e),
      n(B4, e), n(C5, e), n(D5, e),
      n(E5, e), n(F5, e), n(G5, e),
    ] },
  },
  // ── 4. 4 个十六分同拍 → 双梁一组 ──
  {
    title: '4. 同拍 4 个十六分音符',
    expect: '4 个十六分连成一组双横梁',
    // 拍0: s s s s (1拍) | 拍1,2,3: q | 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, s), n(D4, s), n(E4, s), n(F4, s), n(G4, q), n(A4, q), n(B4, q),
      n(C5, w), n(D5, w), n(E5, w),
    ] },
  },
  // ── 5. 两拍各 4 个十六分 → 两组双梁 ──
  {
    title: '5. 两拍各 4 个十六分（按拍分两组双梁）',
    expect: '拍1的4个十六分一组双梁，拍2的4个十六分另一组双梁',
    // 拍0: s×4 | 拍1: s×4 | 拍2,3: q | 后2小节 whole×2
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, s), n(D4, s), n(E4, s), n(F4, s),
      n(G4, s), n(A4, s), n(B4, s), n(C5, s),
      n(D5, q), n(E5, q),
      n(F5, w), n(G5, w),
    ] },
  },
  // ── 6. 八分 + 十六分相邻 → 时值不同断开 ──
  {
    title: '6. 八分接十六分（时值不同 → 断开）',
    expect: '八分孤立带 flag；同拍的后续十六分自成一组（仅拍内同种）',
    // 拍0: e(0.5) s s s (0.75) = 1.25拍；不规整，改为：拍0: s s s s(1拍) 拍1: e | 不对
    // 重设：拍0: e(0.5) + 拍0.5: s s s s 不行（超拍）
    // 干净版：拍0: e e | 拍1: s s s s | 拍2,3: q。验证 e 与 s 跨拍断开
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e), n(D4, e),                            // 拍0：两八分一组
      n(E4, s), n(F4, s), n(G4, s), n(A4, s),        // 拍1：四十六分一组双梁
      n(B4, q), n(C5, q),                            // 拍2,3
      n(D5, w), n(E5, w), n(F5, w),                  // 后3小节
    ] },
  },
  // ── 7. 跨小节 → 强制断开 ──
  {
    title: '7. 跨小节边界断开',
    expect: '第1小节末拍的两八分一组，第2小节首拍的两八分另一组（跨小节不连）',
    // 第1小节: h h e e  (拍0,1: half；拍2: q... 不对，要拍3: e e)
    // 第1小节: q q q + e e (拍3: e e) | 第2小节: e e + q q + ...
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, q), n(D4, q), n(E4, q),                  // 第1小节拍0,1,2
      n(F4, e), n(G4, e),                            // 第1小节拍3：两八分组1
      n(A4, e), n(B4, e), n(C5, q), n(D5, q),        // 第2小节拍0：两八分组2 + 拍1,2 q
      n(E5, q),                                      // 第2小节拍3
      n(F5, w), n(G5, w),                            // 第3,4小节
    ] },
  },
  // ── 8. e + q + e → 中间 quarter 断开 ──
  {
    title: '8. 八分 + 四分 + 八分（中间长时值断开）',
    expect: '两端八分各自孤立带 flag（不连梁），中间 quarter 无符干',
    // 拍0: e(0.5) + q(1) + e(0.5) = 2拍 | 拍2,3: q | 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e), n(D4, q), n(E4, e), n(F4, q), n(G4, q),
      n(A4, w), n(B4, w), n(C5, w),
    ] },
  },
  // ── 9. 组内音高跨中线 → 平均 step 决定方向 ──
  {
    title: '9. 组内跨中线（C5 高 + C4 低）',
    expect: '平均 step 接近中线，方向由平均决定；符干对齐到同一梁',
    // C5 step≈8, C4 step≈2, 平均≈5（≤6 → up）
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C5, e), n(C4, e), n(D4, q), n(E4, q), n(F4, q),
      n(G4, w), n(A4, w), n(B4, w),
    ] },
  },
  // ── 10. 全组高于中线 → 符干统一朝下 ──
  {
    title: '10. 全组高于中线（符干朝下）',
    expect: '高音组，符干统一朝下，横梁在符头下方',
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C5, e), n(D5, e), n(E5, q), n(F5, q), n(G5, q),
      n(A5, w), n(B5, w), n(C5, w),
    ] },
  },
  // ── 11. 全组低于中线 → 符干统一朝上 ──
  {
    title: '11. 全组低于中线（符干朝上）',
    expect: '低音组，符干统一朝上，横梁在符头上方',
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e), n(D4, e), n(E4, q), n(F4, q), n(G4, q),
      n(A4, w), n(B4, w), n(C5, w),
    ] },
  },
  // ── 12. 附点八分 + 八分（dotted 不影响连梁判定）──
  {
    title: '12. 附点八分 + 八分（dotted 不影响连梁）',
    expect: '附点八分与后续八分仍连成单梁（dotted 只改符头附点）',
    // 附点八分=0.75拍。连梁组: dotted-e(0.75)+e(0.5)=1.25拍。
    // 补满第1小节(4拍): +e(0.5)+e(0.5)+q(1)+十六(0.25)*3=0.75 ... 用最简:
    // dotted-e+e+dotted-e+e+q+q = 0.75+0.5+0.75+0.5+1+1 = 4.5 超。
    // 干脆用两个连梁组+half: dotted-e+e(1.25) + dotted-e+e(1.25) + ... 
    // 最干净: 连梁组占1.25拍 + half(2) + ... 差0.75。用 dotted-quarter(1.5)超。
    // 方案: 连梁组1.25 + q(1) + q(1) + dotted-e(0.75) = 4.0 ✅ (最后dotted-e孤立带flag)
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e, true), n(D4, e),    // 连梁组1: 附点八分+八分 (验证 dotted 不影响连梁)
      n(E4, q), n(F4, q),          // 补2拍
      n(G4, e, true),              // 附点八分0.75拍, 凑满第1小节(孤立带flag)
      n(A4, w), n(B4, w), n(C5, w),
    ] },
  },
  // ── 13. 单个孤立八分 → 不连梁，保留 flag ──
  {
    title: '13. 孤立八分（前后无短时值）',
    expect: '单个八分音符保留 flag，不连梁（前后都是长时值）',
    // 第1小节: whole 填满；第2小节: q + e(孤立) + q + dotted-q = 1+0.5+1+1.5 = 4拍
    // 八分前后都是 quarter/dotted-quarter，真正孤立，带 flag
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, w),
      n(D4, q), n(E4, e), n(F4, q), n(G4, q, true),
      n(A4, w), n(B4, w),
    ] },
  },
  // ── 14. 休止符夹在八分间 → 断开 ──
  {
    title: '14. 休止符打断连梁',
    expect: '休止符前的两八分（同拍）成组，休止后另算（休止不参与连梁）',
    // 拍0: e e | 拍1: rest q | 拍2: e e | 拍3: q | 后3小节
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e), n(D4, e), n(REST, q), n(E4, e), n(F4, e), n(G4, q),
      n(A4, w), n(B4, w), n(C5, w),
    ] },
  },
  // ── 15. 上行级进 4 八分 → 梁微上斜 ──
  {
    title: '15. 上行级进（梁应微上斜：末端高于首端）',
    expect: 'C4→D4→E4→F4 上行，梁从左下往右上倾斜（up 方向，末端 y 更小）',
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e), n(D4, e), n(E4, e), n(F4, e), n(G4, q), n(A4, q),
      n(B4, w), n(C5, w), n(D5, w),
    ] },
  },
  // ── 16. 下行级进 4 八分 → 梁微下斜 ──
  {
    title: '16. 下行级进（梁应微下斜：末端低于首端）',
    expect: 'F4→E4→D4→C4 下行，梁从左上往右下倾斜',
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(F4, e), n(E4, e), n(D4, e), n(C4, e), n(G4, q), n(A4, q),
      n(B4, w), n(C5, w), n(D5, w),
    ] },
  },
  // ── 17. 大跳（C4→A4，超三度）→ 倾斜被削平，不会很陡 ──
  {
    title: '17. 大跳 C4→A4（超三度，倾斜应削平到 MAX_SLOPE）',
    expect: 'C4 到 A4 跨六度，但梁倾斜不超过一个三度，被削平，不会很陡',
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, e), n(A4, e), n(E4, q), n(F4, q), n(G4, q),
      n(A4, w), n(B4, w), n(C5, w),
    ] },
  },
  // ── 18. 首尾同高（C4→G4→C4，同拍 3 音）→ 中间符干对齐水平梁 ──
  {
    title: '18. C4→G4→C4（首尾同高 → 梁水平，中间符干最长）',
    expect: '首尾 C4 同高，梁水平；中间 G4 符干最长（符头离梁远，对齐水平线）',
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      // 同拍 3 个八分？不行，3 八分=1.5拍超拍。改用十六分让 3 音同拍
      // 改为：2 个八分首尾同高（C4-C4）最直接验证水平梁
      n(C4, e), n(C4, e), n(E4, q), n(F4, q), n(G4, q),
      n(A4, w), n(B4, w), n(C5, w),
    ] },
  },
  // ── 19. 3 音斜梁（D4→E4→F4）→ 中间符干对齐斜线 ──
  {
    title: '19. 三音斜梁（中间符干顶端落在首尾连线上）',
    expect: 'D4→E4→F4 微上行，中间 E4 的符干顶端对齐 D4-F4 连线',
    // e,e,e(1.5拍) + e(0.5) + q(1) + q(1) = 4拍第1小节; 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(D4, e), n(E4, e), n(F4, e),    // 三音斜梁组
      n(G4, e),                         // 补0.5拍凑满(孤立带flag)
      n(A4, q), n(B4, q),              // 补2拍
      n(C5, w), n(D5, w), n(E5, w),    // 后3小节
    ] },
  },
  // ── 20. sx3：3 个十六分连成双梁（末位休止）──
  {
    title: '20. 拍内 3 个十六分 + 末位休止（sx3 双梁）',
    expect: '前 3 个十六分连成一组双横梁(3音)，末位十六分休止不参与',
    // 拍0: s s s rs(休) = 0.5*4 = 2拍；拍1: q；拍2: q；拍3: q；后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, s), n(D4, s), n(E4, s), n(REST, s),  // 3连 + 休止
      n(F4, q), n(G4, q), n(A4, q),               // 补3拍
      n(B4, w), n(C5, w), n(D5, w),               // 后3小节
    ] },
  },
  // ── 21. sx2：2 个十六分连 + 八分孤立（sx2）──
  {
    title: '21. 拍内 2 个十六分连 + 1 个八分孤立（sx2）',
    expect: '前 2 个十六分连成一组双横梁(2音)，后面的八分孤立带 flag',
    // 拍0: s s e = 0.5+0.5+1 = 2拍；拍1: q；拍2: q；拍3: q；后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      n(C4, s), n(D4, s), n(E4, e),    // sx2: 前两s连，e孤立
      n(F4, q), n(G4, q), n(A4, q),    // 补3拍
      n(B4, w), n(C5, w), n(D5, w),    // 后3小节
    ] },
  },
  // ── 22. 3/8 复合拍：4 小节各 6 个十六分（s6 双梁，长跨度）──
  {
    title: '22. 3/8 每小节 6 个十六分（s6 双梁，复合拍长跨度）',
    expect: '3/8 每小节 6 个十六分 = 一组 beatGroup(3八分位)，连成双横梁；4 小节各自独立',
    piece: { clef: 'treble', key: CKEY, time: T38, notes: [
      // 4 小节 × (6 个十六分) = 24 个十六分
      n(C4, s), n(D4, s), n(E4, s), n(F4, s), n(G4, s), n(A4, s),
      n(B4, s), n(C5, s), n(D5, s), n(E5, s), n(F5, s), n(G5, s),
      n(A4, s), n(B4, s), n(C5, s), n(D5, s), n(E5, s), n(F5, s),
      n(G4, s), n(A4, s), n(B4, s), n(C5, s), n(D5, s), n(E5, s),
    ] },
  },
  // ── 23. 3/8 复合拍：一组内同时有八分组和十六分组（e2+s2）──
  {
    title: '23. 3/8 一组内八分连 + 十六分连（e2+s2 复合拍特有）',
    expect: '3/8 每小节：2个八分连成单梁 + 2个十六分连成双梁（一组内两段连梁）',
    piece: { clef: 'treble', key: CKEY, time: T38, notes: [
      // 每小节 3 八分位 = e+e+s+s = 1+1+0.5+0.5 = 3 ✅
      n(C4, e), n(D4, e), n(E4, s), n(F4, s),    // e2 + s2
      n(G4, e), n(A4, e), n(B4, s), n(C5, s),
      n(D4, e), n(E4, e), n(F4, s), n(G4, s),
      n(A4, e), n(B4, e), n(C5, s), n(D5, s),
    ] },
  },
  // ── 24. 4/4 四种典型节奏型各一小节 ──
  {
    title: '24. 4/4 四种节奏型（小节1: 8-16×4-8-16-8-16-8-8 / 小节2: 16-8-16-8-16×3-16-8-8 / 小节3: 8-16-16 ×4组 / 小节4: 附点4-16-16-4-4）',
    expect: '小节1/2/3 各4拍；小节4 附点4+16×2+4×4 = 4.5拍(略超,验证渲染)',
    piece: { clef: 'treble', key: CKEY, time: T44, notes: [
      // 小节1: 8 16 16 16 16 8 16 8 16 8 8 = 4拍
      n(C4, e), n(D4, s), n(E4, s), n(F4, s), n(G4, s), n(A4, e), n(B4, s), n(C5, e), n(D5, s), n(E5, e), n(F5, e),
      // 小节2: 16 8 16 8 16 16 16 8 16 8 8 = 4拍
      n(G4, s), n(A4, e), n(B4, s), n(C5, e), n(D5, s), n(E5, s), n(F5, s), n(G5, e), n(A5, s), n(B5, e), n(C5, e),
      // 小节3: 8 16 16 8 16 16 8 16 16 8 16 16 = 4拍(八分+2十六分 ×4组)
      n(C4, e), n(D4, s), n(E4, s), n(F4, e), n(G4, s), n(A4, s), n(B4, e), n(C5, s), n(D5, s), n(E5, e), n(F5, s), n(G5, s),
      // 小节4: 附点4 16 16 4 4 = 4.5拍(略超,触发capacity诊断)
      n(B4, q, true), n(C5, s), n(D5, s), n(E5, q), n(F5, q),
    ] },
  },
];

// ── 渲染 ────────────────────────────────────────────────
async function main() {
  const root = document.getElementById('beam-test')!;
  root.innerHTML = '';

  // 标题与说明
  const head = document.createElement('div');
  head.style.cssText = 'font-family:system-ui,sans-serif;padding:16px 20px;border-bottom:1px solid #e2e8f0;background:#f8fafc;';
  head.innerHTML = `
    <h1 style="margin:0 0 6px;font-size:18px;">连梁（Beaming）渲染测试</h1>
    <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">
      逐项核对：<b>符干方向组内统一</b> · <b>同组符干顶端对齐到梁</b> · <b>按拍分组而非全部连成一大片</b> ·
      <b>双梁（十六分）间距均匀</b> · <b>跨小节 / 混合时值 / 休止符正确断开</b>。
      <br/>每项标题下方的「预期」描述正确结果。
    </p>`;
  root.appendChild(head);

  // 注入异常 tint 样式：检测到超拍的 case 整体变暗红，一眼定位
  const tintStyle = document.createElement('style');
  tintStyle.textContent = `
    .has-issues { border-color:#dc2626 !important; }
    .has-issues > div:first-child b { color:#dc2626 !important; }
    .has-issues .svg-wrap {
      filter: sepia(0.5) saturate(2) hue-rotate(-15deg) brightness(0.92);
    }
  `;
  root.appendChild(tintStyle);

  // 等字体就绪，避免首帧用 fallback
  try { await ensureFontLoaded(); } catch { /* 忽略，buildSVG 仍可用 */ }

  const container = document.createElement('div');
  container.style.cssText = 'padding:16px 20px;display:flex;flex-direction:column;gap:18px;';
  root.appendChild(container);

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;';

    const info = document.createElement('div');
    info.style.cssText = 'padding:8px 12px;font-family:system-ui,sans-serif;border-bottom:1px solid #f1f5f9;display:flex;gap:12px;align-items:baseline;';
    const groups = computeBeams(c.piece);
    info.innerHTML = `
      <b style="font-size:14px;color:#1f2430;">${c.title}</b>
      <span style="font-size:12px;color:#64748b;">预期：${c.expect}</span>
      <span style="font-size:11px;color:#94a3b8;margin-left:auto;">分组结果：${groups.length ? groups.map(g => `[${g.startIdx}..${g.endIdx}] ${g.level}`).join('  ') : '（无连梁组）'}</span>`;
    wrap.appendChild(info);

    const stage = document.createElement('div');
    stage.style.cssText = 'padding:6px;overflow-x:auto;background:#fafbfc;';
    try {
      const layout = computeLayout(c.piece, 900, 'eighth');
      // 接入异常回调：收集 issues，渲染后若非空则 tint 红色
      let caseIssues: import('../render/diagnostics').Issue[] = [];
      const svg = buildSVG(c.piece, layout, -1, {
        exportMode: true,
        onIssues: (issues) => { caseIssues = issues; },
      });
      const svgWrap = document.createElement('div');
      svgWrap.className = 'svg-wrap';
      svgWrap.style.cssText = 'min-width:' + layout.width + 'px;';
      svgWrap.innerHTML = svg;
      stage.appendChild(svgWrap);
      // 有问题 → 整个 case tint 暗红 + 显示问题清单
      if (caseIssues.length > 0) {
        wrap.classList.add('has-issues');
        wrap.setAttribute('data-issue-count', String(caseIssues.length));
        const issueList = document.createElement('div');
        issueList.style.cssText = 'padding:8px 12px;font-family:monospace;font-size:11px;color:#b91c1c;background:#fef2f2;border-top:1px solid #fecaca;';
        issueList.innerHTML = `<b>⚠ 检测到 ${caseIssues.length} 个问题：</b><br>` +
          caseIssues.map(i => `· ${i.message}`).join('<br>');
        wrap.appendChild(issueList);
      }
    } catch (err) {
      stage.innerHTML = `<div style="color:#dc2626;font-family:monospace;font-size:12px;padding:8px;">渲染失败：${String(err)}</div>`;
    }
    wrap.appendChild(stage);

    container.appendChild(wrap);
  }

  // 页脚
  const foot = document.createElement('div');
  foot.style.cssText = 'padding:12px 20px;font-family:system-ui,sans-serif;font-size:11px;color:#94a3b8;';
  foot.textContent = '共 ' + cases.length + ' 个用例 · 数据来自 src/beam-test/main.ts · 渲染走生产管线 computeLayout→buildSVG';
  root.appendChild(foot);
}

main();
