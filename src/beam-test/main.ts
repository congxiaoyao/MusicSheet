// 连梁渲染测试页：把多种连接场景并排渲染，供人工核对。
// 访问：http://localhost:5173/beam-test.html
//
// 每个 case 是一个填满 2 小节的 Piece（第1小节=核心连梁场景，第2小节 whole 收尾）。
// 用例覆盖：成组、跨拍、复合拍、十六分双梁、混合时值断开、跨小节、
//           休止符断开、孤立音符、组内方向统一（跨中线、全高、全低）等。
// 跨小节场景（用例7）保留 2 小节以体现「跨边界断开」；
// 多节奏型合集（原用例24）拆成 24a–24d，每个聚焦一种节奏型。

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
/** 连音线(tie)起点音：向后连到下一个同音高音 */
function nt(midi: number, duration: DurationValue, dotted = false): Note {
  return { midi, duration, dotted, accidental: null, tieStart: true };
}
/** 连音线(tie)终点音：从前一个同音高音连来 */
function te(midi: number, duration: DurationValue, dotted = false): Note {
  return { midi, duration, dotted, accidental: null, tieEnd: true };
}
const e = 'eighth' as DurationValue;
const s = 'sixteenth' as DurationValue;
const t = 'thirtysecond' as DurationValue;
const q = 'quarter' as DurationValue;
const h = 'half' as DurationValue;

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
    expect: '拍1的两个八分连成单梁',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, e), n(E4, q), n(F4, q), n(G4, q),   // 第1小节 4拍
    ] },
  },
  // ── 2. 一拍内 2+2 个八分（拍1、拍2 各成一组）──
  {
    title: '2. 一拍内 2+2 个八分（拍1、拍2 各成一组）',
    expect: '拍1的两八分一组，拍2的两八分另一组',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, e), n(E4, e), n(F4, e), n(G4, q), n(A4, q),
    ] },
  },
  // ── 3. 3/8 拍号 → 复合拍每组 3 个八分（2 小节各 1.5 拍）──
  {
    title: '3. 3/8 拍号（每组 3 个八分）',
    expect: '每 3 个八分连一组（复合拍，按附点四分拍分组）',
    piece: { clef: 'treble', key: CKEY, time: T38, measureCount: 2, notes: [
      n(C4, e), n(D4, e), n(E4, e),   // 1.5 拍
      n(F4, e), n(G4, e), n(A4, e),   // 1.5 拍
    ] },
  },
  // ── 4. 4 个十六分同拍 → 双梁一组 ──
  {
    title: '4. 同拍 4 个十六分音符',
    expect: '4 个十六分连成一组双横梁',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, s), n(E4, s), n(F4, s), n(G4, q), n(A4, q), n(B4, q),
    ] },
  },
  // ── 5. 两拍各 4 个十六分 → 两组双梁 ──
  {
    title: '5. 两拍各 4 个十六分（按拍分两组双梁）',
    expect: '拍1的4个十六分一组双梁，拍2的4个十六分另一组双梁',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, s), n(E4, s), n(F4, s),
      n(G4, s), n(A4, s), n(B4, s), n(C5, s),
      n(D5, q), n(E5, q),
    ] },
  },
  // ── 6. 八分 + 十六分相邻 → 时值不同断开 ──
  {
    title: '6. 八分接十六分（时值不同 → 断开）',
    expect: '八分孤立带 flag；同拍的后续十六分自成一组（仅拍内同种）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, e),                            // 拍0：两八分一组
      n(E4, s), n(F4, s), n(G4, s), n(A4, s),        // 拍1：四十六分一组双梁
      n(B4, q), n(C5, q),                            // 拍2,3
    ] },
  },
  // ── 7. 跨小节 → 强制断开（必须占 2 小节）──
  {
    title: '7. 跨小节边界断开',
    expect: '第1小节末拍的两八分一组，第2小节首拍的两八分另一组（跨小节不连）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 2, notes: [
      n(C4, q), n(D4, q), n(E4, q),        // 第1小节拍0,1,2
      n(F4, e), n(G4, e),                  // 第1小节拍3：两八分组1
      n(A4, e), n(B4, e),                  // 第2小节拍0：两八分组2（跨小节，不连）
      n(C5, q), n(D5, q), n(E5, q),
    ] },
  },
  // ── 8. e + q + e → 中间 quarter 断开 ──
  {
    title: '8. 八分 + 四分 + 八分（中间长时值断开）',
    expect: '两端八分各自孤立带 flag（不连梁），中间 quarter 无符干',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, q), n(E4, e), n(F4, q), n(G4, q),
    ] },
  },
  // ── 9. 组内音高跨中线 → 平均 step 决定方向 ──
  {
    title: '9. 组内跨中线（C5 高 + C4 低）',
    expect: '平均 step 接近中线，方向由平均决定；符干对齐到同一梁',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C5, e), n(C4, e), n(D4, q), n(E4, q), n(F4, q),
    ] },
  },
  // ── 10. 全组高于中线 → 符干统一朝下 ──
  {
    title: '10. 全组高于中线（符干朝下）',
    expect: '高音组，符干统一朝下，横梁在符头下方',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C5, e), n(D5, e), n(E5, q), n(F5, q), n(G5, q),
    ] },
  },
  // ── 11. 全组低于中线 → 符干统一朝上 ──
  {
    title: '11. 全组低于中线（符干朝上）',
    expect: '低音组，符干统一朝上，横梁在符头上方',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, e), n(E4, q), n(F4, q), n(G4, q),
    ] },
  },
  // ── 12. 附点八分 + 八分（dotted 不影响连梁判定）──
  {
    title: '12. 附点八分 + 八分（dotted 不影响连梁）',
    expect: '附点八分与后续八分仍连成单梁（dotted 只改符头附点）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e, true), n(D4, e),    // 连梁组1：附点八分+八分（验证 dotted 不影响连梁）
      n(E4, q), n(F4, q),          // 补2拍
      n(G4, e, true),              // 附点八分0.75拍，凑满第1小节（孤立带 flag）
    ] },
  },
  // ── 13. 单个孤立八分 → 不连梁，保留 flag ──
  {
    title: '13. 孤立八分（前后无短时值）',
    expect: '单个八分音符保留 flag，不连梁（前后都是长时值）',
    // 核心场景重排到第1小节：q + e(孤立) + q + dotted-q = 4拍
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(D4, q), n(E4, e), n(F4, q), n(G4, q, true),   // 八分 E4 前后都是长时值，孤立带 flag
    ] },
  },
  // ── 14. 休止符夹在八分间 → 断开 ──
  {
    title: '14. 休止符打断连梁',
    expect: '休止符前的两八分（同拍）成组，休止后另算（休止不参与连梁）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, e), n(REST, q), n(E4, e), n(F4, e), n(G4, q),
    ] },
  },
  // ── 15. 上行级进 4 八分 → 梁微上斜 ──
  {
    title: '15. 上行级进（梁应微上斜：末端高于首端）',
    expect: 'C4→D4→E4→F4 上行，梁从左下往右上倾斜（up 方向，末端 y 更小）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, e), n(E4, e), n(F4, e), n(G4, q), n(A4, q),
    ] },
  },
  // ── 16. 下行级进 4 八分 → 梁微下斜 ──
  {
    title: '16. 下行级进（梁应微下斜：末端低于首端）',
    expect: 'F4→E4→D4→C4 下行，梁从左上往右下倾斜',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(F4, e), n(E4, e), n(D4, e), n(C4, e), n(G4, q), n(A4, q),
    ] },
  },
  // ── 17. 大跳（C4→A4，超三度）→ 倾斜被削平，不会很陡 ──
  {
    title: '17. 大跳 C4→A4（超三度，倾斜应削平到 MAX_SLOPE）',
    expect: 'C4 到 A4 跨六度，但梁倾斜不超过一个三度，被削平，不会很陡',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(A4, e), n(E4, q), n(F4, q), n(G4, q),
    ] },
  },
  // ── 18. 首尾同高（C4-C4）→ 梁水平 ──
  {
    title: '18. C4-C4 首尾同高 → 梁水平',
    expect: '首尾 C4 同高，梁水平',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(C4, e), n(E4, q), n(F4, q), n(G4, q),
    ] },
  },
  // ── 19. 斜梁（D4→E4→F4→G4）→ 符干对齐斜线 ──
  {
    title: '19. 斜梁（符干顶端落在首尾连线上）',
    expect: 'D4→E4→F4→G4 微上行，符干顶端对齐首尾连线',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(D4, e), n(E4, e), n(F4, e), n(G4, e), n(A4, q), n(B4, q),
    ] },
  },
  // ── 20. sx3：3 个十六分连成双梁（末位休止）──
  {
    title: '20. 拍内 3 个十六分 + 末位休止（sx3 双梁）',
    expect: '前 3 个十六分连成一组双横梁(3音)，末位十六分休止不参与',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, s), n(E4, s), n(REST, s),  // 3 连 + 休止
      n(F4, q), n(G4, q), n(A4, q),               // 补3拍
    ] },
  },
  // ── 21. sx2：2 个十六分连 + 八分孤立（sx2）──
  {
    title: '21. 拍内 2 个十六分连 + 1 个八分孤立（sx2）',
    expect: '前 2 个十六分连成一组双横梁(2音)，后面的八分孤立带 flag',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, s), n(E4, e),    // sx2：前两 s 连，e 孤立
      n(F4, q), n(G4, q), n(A4, q),    // 补3拍
    ] },
  },
  // ── 22. 3/8 复合拍：每小节 6 个十六分（s6 双梁，长跨度）──
  {
    title: '22. 3/8 每小节 6 个十六分（s6 双梁，复合拍长跨度）',
    expect: '3/8 每小节 6 个十六分 = 一组 beatGroup(3八分位)，连成双横梁；2 小节各自独立',
    piece: { clef: 'treble', key: CKEY, time: T38, measureCount: 2, notes: [
      n(C4, s), n(D4, s), n(E4, s), n(F4, s), n(G4, s), n(A4, s),   // 1.5 拍
      n(B4, s), n(C5, s), n(D5, s), n(E5, s), n(F5, s), n(G5, s),   // 1.5 拍
    ] },
  },
  // ── 23. 3/8 复合拍：一组内同时有八分组和十六分组（e2+s2）──
  {
    title: '23. 3/8 一组内八分连 + 十六分连（e2+s2 复合拍特有）',
    expect: '3/8 每小节：2个八分连成单梁 + 2个十六分连成双梁（一组内两段连梁）',
    piece: { clef: 'treble', key: CKEY, time: T38, measureCount: 2, notes: [
      // 每小节 3 八分位 = e+e+s+s = 0.5+0.5+0.25+0.25 = 1.5 拍
      n(C4, e), n(D4, e), n(E4, s), n(F4, s),    // e2 + s2
      n(G4, e), n(A4, e), n(B4, s), n(C5, s),
    ] },
  },
  // ── 24a. 节奏型：8-16-16-16-16-8-16-8-16-8-8（1 小节，正好 4 拍）──
  {
    title: '24a. 节奏型：8 16 16 16 16 8 16 8 16 8 8',
    expect: '混合八分/十六分，按拍分组（e 孤立 / 四十六分双梁）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, s), n(E4, s), n(F4, s), n(G4, s),
      n(A4, e), n(B4, s), n(C5, e), n(D5, s), n(E5, e), n(F5, e),
    ] },
  },
  // ── 24b. 节奏型：16-8-16-8-16-16-16-8-16-8-8（1 小节，正好 4 拍）──
  {
    title: '24b. 节奏型：16 8 16 8 16 16 16 8 16 8 8',
    expect: '混合八分/十六分，十六分起拍',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(G4, s), n(A4, e), n(B4, s), n(C5, e), n(D5, s),
      n(E5, s), n(F5, s), n(G5, e), n(A5, s), n(B5, e), n(C5, e),
    ] },
  },
  // ── 24c. 节奏型：8-16-16 ×4 组（1 小节，正好 4 拍）──
  {
    title: '24c. 节奏型：8 16 16 ×4 组',
    expect: '每拍一个八分接两个十六分（八分孤立带 flag / 两十六分双梁）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, s), n(E4, s),
      n(F4, e), n(G4, s), n(A4, s),
      n(B4, e), n(C5, s), n(D5, s),
      n(E5, e), n(F5, s), n(G5, s),
    ] },
  },
  // ── 24d. 节奏型：附点4-16-16-4-4（1 小节，正好 4 拍）──
  {
    title: '24d. 节奏型：附点4 16 16 4 4',
    expect: '附点四分 + 两个十六分双梁 + 两个四分（1.5+0.5+2 = 4拍，正好填满）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(B4, q, true), n(C5, s), n(D5, s), n(E5, q), n(F5, q),   // 1.5+0.25+0.25+1+1 = 4拍
    ] },
  },
  // ── 25. partial beam：8 16 16（八分+2十六分连一组，次梁仅16-16段）──
  {
    title: '25. partial beam 8-16-16（八分与十六分连成一组）',
    expect: '主梁(1)贯穿三音；次梁(2)仅在后两个十六分之间（八分容量1不参与次梁）',
    // 拍0: 8(0.5)+16(0.25)+16(0.25)=1拍 | 拍1,2,3: q | 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, s), n(E4, s),
      n(F4, q), n(G4, q), n(A4, q),
    ] },
  },
  // ── 26. partial beam：16 16 8（反向，次梁仅前两个十六分段）──
  {
    title: '26. partial beam 16-16-8（反向）',
    expect: '主梁(1)贯穿三音；次梁(2)仅在前两个十六分之间',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, s), n(E4, e),
      n(F4, q), n(G4, q), n(A4, q),
    ] },
  },
  // ── 27. partial beam：16 8 16（八分夹中间，次梁全断）──
  {
    title: '27. partial beam 16-8-16（八分夹中间，次梁全断）',
    expect: '主梁(1)贯穿三音；次梁(2)全断（中间八分容量1，两侧十六分与它 min=1，够不上次梁）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, e), n(E4, s),
      n(F4, q), n(G4, q), n(A4, q),
    ] },
  },
  // ── 28. partial beam：8 16 16 16（八分+3十六分，次梁后三音段）──
  {
    title: '28. partial beam 8-16-16-16（次梁在后三个十六分段）',
    expect: '主梁(1)贯穿四音；次梁(2)在后三个十六分之间（首个八分容量1不参与次梁）',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, s), n(E4, s), n(F4, s),
      n(G4, e), n(A4, e), n(B4, e, true),  // 1.25 + 0.5+0.5+0.75 = 3.0
      n(C5, q),                              // +1 = 4.0
    ] },
  },
  // ── 29. 三十二分：32 32 32 32（三梁贯穿）──
  {
    title: '29. 32-32-32-32（三梁贯穿整组）',
    expect: '主梁(1)、次梁(2)、三梁(3)全部贯穿四音；符干延伸到最外侧三梁',
    // 拍0: 32×4(0.5拍) | 16×2(0.5拍) | q(1) | q(1) | q(1) = 4拍 | 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, t), n(D4, t), n(E4, t), n(F4, t),  // 三十二分四连（三梁）
      n(G4, s), n(A4, s),                        // 十六分双梁（对照）
      n(B4, q), n(C5, q), n(D5, q),
    ] },
  },
  // ── 30. 三十二分 partial：16 32 32 16（主+次贯穿、三梁仅中段）──
  {
    title: '30. 16-32-32-16（主+次贯穿，三梁仅中间32-32段）',
    expect: '主梁(1)、次梁(2)贯穿四音；三梁(3)仅在中间两个三十二分之间',
    // 16(0.25)+32(0.125)+32(0.125)+16(0.25)=0.75拍 | e(0.5)+e(0.5)+e(0.5)=1.5 | q(1)+dotted-e(0.75)=1.75 = 4.0
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, t), n(E4, t), n(F4, s),
      n(G4, e), n(A4, e), n(B4, e),
      n(C5, q), n(D5, e, true),
    ] },
  },
  // ── 31. 孤立三十二分：夹在休止符间，保留 flag32nd ──
  {
    title: '31. 孤立三十二分（前后休止符，保留 flag32nd）',
    expect: '三十二分音符孤立带 flag（前面两十六分自成一组，休止符打断，三十二分单独 flag32nd）',
    // 16(0.25)+16(0.25)+rest8(0.5)+32(0.125)+rest32(0.125)+16×5(1.25)+dotted-q(1.5) = 4.0
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, s),               // 两十六分一组双梁
      n(REST, e),                        // 八分休止打断
      n(E4, t),                          // 孤立三十二分（前是休止，后是休止 → flag32nd）
      n(REST, t),                        // 三十二分休止打断（验证 rest32nd 字形）
      n(F4, s), n(G4, s), n(A4, s), n(B4, s), n(C5, s),  // 五十六分（前两+后三各自成组）
      n(D5, q, true),                    // 附点四分补 1.5 拍
    ] },
  },
  // ── 32. 一拍 8 个三十二分（经典「一拍八连」，三梁长组贯穿）──
  {
    title: '32. 一拍 8 个三十二分（三梁长组贯穿）',
    expect: '8 个三十二分连成一组：primary、次梁、三梁全部贯穿 8 音；符干等长到最外侧 primary',
    // t×8(1拍) | q q q(3) = 4拍 | 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, t), n(D4, t), n(E4, t), n(F4, t), n(G4, t), n(A4, t), n(B4, t), n(C5, t),
      n(D5, q), n(E5, q), n(F5, q),
    ] },
  },
  // ── 33. 16-32-32（十六分接两三十二分：三梁仅后两 32 段）──
  {
    title: '33. 16-32-32（三梁仅在后两个三十二分段）',
    expect: 'primary+次梁贯穿三音；三梁(最内侧)仅在后两个三十二分之间（首个十六分容量2不够三梁）',
    // 16(0.25)+32(0.125)+32(0.125)=0.5拍 | half(2)+dotted-q(1.5)=3.5 → 4.0 | 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, t), n(E4, t),
      n(F4, h), n(G4, q, true),
    ] },
  },
  // ── 34. 32-32-16（反向：三梁仅前两 32 段）──
  {
    title: '34. 32-32-16（三梁仅在前两个三十二分段）',
    expect: 'primary+次梁贯穿三音；三梁(最内侧)仅在前两个三十二分之间',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, t), n(D4, t), n(E4, s),
      n(F4, h), n(G4, q, true),
    ] },
  },
  // ── 35. 32-16-32（十六分夹中间，三梁两侧短桩）──
  {
    title: '35. 32-16-32（三梁两侧短桩：两端32分各一短桩，中间16分处断）',
    expect: 'primary+次梁贯穿三音；三梁(最内侧)在两端三十二分各画一短桩（跟随主梁斜率），中间十六分处断开',
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, t), n(D4, s), n(E4, t),
      n(F4, h), n(G4, q, true),
    ] },
  },
  // ── 36. 8-32-32-32-32（八分接 4 个三十二分：次梁+三梁仅后4个32段）──
  {
    title: '36. 8-32-32-32-32（八分容量1不参与次/三梁，后4个32分连次+三梁）',
    expect: 'primary 贯穿5音；次梁、三梁仅在后4个三十二分之间（首个八分容量1只到 primary）',
    // e(0.5)+t×4(0.5)=1拍 | q(1)+half(2)=3 → 4.0 | 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, e), n(D4, t), n(E4, t), n(F4, t), n(G4, t),
      n(A4, q), n(B4, h),
    ] },
  },
  // ── 37. 16-16-32-32-32-32（两十六分接四三十二分：次梁贯穿，三梁仅后四32段）──
  {
    title: '37. 16-16-32-32-32-32（次梁贯穿，三梁仅在后四个三十二分段）',
    expect: 'primary+次梁贯穿6音（全部容量≥2）；三梁(最内侧)仅在后四个三十二分之间（前两个十六分容量2不够三梁）',
    // 16-16-32-32-32-32 = 0.25+0.25+0.125×4 = 1拍 | q(1)+half(2)=3 → 4拍 | 后3小节 whole
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      n(C4, s), n(D4, s), n(E4, t), n(F4, t), n(G4, t), n(A4, t),  // 16-16-32-32-32-32 = 1拍
      n(B4, q), n(C5, h),
    ] },
  },
  // ── 38. 连音线(tie)基础：两个同音高四分音 tie（符干朝上，弧线在符头下方朝下凸）──
  {
    title: '38. tie 基础（C4 四分 + C4 四分，符干朝上）',
    expect: '两个 C4 四分音符之间一条弧线，凸向下方（符干朝上→弧线在符头下方）；播放合并为 2 拍长音',
    // C4(1拍,tie起点)+C4(1拍,tie终点)+D4(1拍)+E4(1拍) = 4拍
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      nt(C4, q), te(C4, q), n(D4, q), n(E4, q),
    ] },
  },
  // ── 39. tie 符干朝下：高音区，弧线应在符头上方朝上凸 ──
  {
    title: '39. tie 符干朝下（C5 四分 + C5 四分，弧线朝上凸）',
    expect: '两个 C5 四分音符之间一条弧线，凸向上方（符干朝下→弧线在符头上方）；与用例38方向相反',
    // C5(1拍)+C5(1拍)+B4(1拍)+A4(1拍) = 4拍
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      nt(C5, q), te(C5, q), n(B4, q), n(A4, q),
    ] },
  },
  // ── 40. 跨小节 tie：四分音从小节1末连到小节2头（两音相邻，跨小节线）──
  {
    title: '40. 跨小节 tie（C4 四分跨小节线）',
    expect: '小节1末 C4 四分(tieStart)与小节2头 C4 四分(tieEnd)相邻、横跨小节线之间一条弧线；播放合并为 2 拍长音',
    // 小节1: D4(1)+E4(1)+F4(1)+C4(1,tie起点)=4拍；小节2: C4(1,tie终点)+G4(1)+A4(1)+B4(1)=4拍
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 2, notes: [
      n(D4, q), n(E4, q), n(F4, q), nt(C4, q),
      te(C4, q), n(G4, q), n(A4, q), n(B4, q),
    ] },
  },
  // ── 41. tie 链：3 个同音高音连续 tie（A-B-C，两组 tie 弧线）──
  {
    title: '41. tie 链（C4 四分 ×3，两组 tie 连续）',
    expect: '三个 C4 四分音符，前两个之间一组 tie、后两个之间一组 tie（共两段弧线）；播放合并为 3 拍长音',
    // C4(nt,1)+C4(te&nt,1)+C4(te,1)+D4(1) = 4拍
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      nt(C4, q), { midi: C4, duration: q, dotted: false, accidental: null, tieStart: true, tieEnd: true }, te(C4, q), n(D4, q),
    ] },
  },
  // ── 42. 不同音高尝试 tie（应无弧线）：C4 四分 + D4 四分 ──
  {
    title: '42. 不同音高无 tie（C4 + D4，弧线不应出现）',
    expect: 'C4 与 D4 音高不同，即使数据带 tieStart/tieEnd 也不画弧线（tie 必须同音高）',
    // 防御性：手动塞入非法 tie 标记，渲染应跳过
    piece: { clef: 'treble', key: CKEY, time: T44, measureCount: 1, notes: [
      { midi: C4, duration: q, dotted: false, accidental: null, tieStart: true }, { midi: D4, duration: q, dotted: false, accidental: null, tieEnd: true }, n(E4, q), n(F4, q),
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
      <span style="font-size:11px;color:#94a3b8;margin-left:auto;">分组结果：${groups.length ? groups.map(g => `[${g.startIdx}..${g.endIdx}] m${g.maxBeamCount}`).join('  ') : '（无连梁组）'}</span>`;
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
