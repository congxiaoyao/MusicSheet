// 回归:三连音填满小节边界 → 编辑不应锁死,待输入格子应落在新小节起点
// 用法: npx tsx scripts/verify-tuplet-bar.mjs
//
// 背景:tuplet 引入后,非 2 的幂时值累加产生 ~1e-16 浮点误差,
//   remainingBeatsInCurrentBar 用 total % bpb 算小节偏移会漏判「小节已满」,
//   导致 barRemain≈4e-16 → 工具栏全 disable + appendNote 拒绝 → 编辑锁死。
//   layout 的 Math.floor(startBeat/bpb) 同源隐患:待输入格子漂到错误小节。
import { deserialize } from '../src/core/serialize.ts';
import { totalBeats, remainingBeats, remainingBeatsInCurrentBar, capacityBeats, noteStartBeats, appendNote } from '../src/core/model.ts';
import { durationBeats } from '../src/core/types.ts';
import { computeLayout } from '../src/render/layout.ts';

// 用户导入的那段数据:7 个八分 + 3 个十六分三连音(actual:3 normal:2) = 3.5 + 0.5 = 4.0 拍
const json = `{
  "format": "musicsheet", "version": 1, "exportedAt": 1782060781704,
  "piece": {
    "clef": "treble",
    "key": { "name": "C", "tonic": 0, "sharps": [], "flats": [] },
    "time": { "num": 4, "den": 4 },
    "measureCount": 2,
    "notes": [
      { "midi": 71, "duration": "eighth", "dotted": false, "accidental": null },
      { "midi": 71, "duration": "eighth", "dotted": false, "accidental": null },
      { "midi": 71, "duration": "eighth", "dotted": false, "accidental": null },
      { "midi": 71, "duration": "eighth", "dotted": false, "accidental": null },
      { "midi": 71, "duration": "eighth", "dotted": false, "accidental": null },
      { "midi": 71, "duration": "eighth", "dotted": false, "accidental": null },
      { "midi": 71, "duration": "eighth", "dotted": false, "accidental": null },
      { "midi": 71, "duration": "sixteenth", "dotted": false, "accidental": null, "tuplet": { "actual": 3, "normal": 2, "groupId": "tup-23" } },
      { "midi": 71, "duration": "sixteenth", "dotted": false, "accidental": null, "tuplet": { "actual": 3, "normal": 2, "groupId": "tup-23" } },
      { "midi": 71, "duration": "sixteenth", "dotted": false, "accidental": null, "tuplet": { "actual": 3, "normal": 2, "groupId": "tup-23" } }
    ]
  }
}`;

let pass = 0, fail = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 得 ${JSON.stringify(got)} / 期 ${JSON.stringify(expect)}`);
  ok ? pass++ : fail++;
}

const piece = deserialize(json);

console.log('═══ 场景1:三连音填满第1小节,模型层判定 ═══');
check('totalBeats≈4.0(浮点误差内)', Math.abs(totalBeats(piece) - 4) < 1e-6, true);
check('remainingBeats=4.0(整个第2小节可用)', Math.abs(remainingBeats(piece) - 4) < 1e-6, true);
check('remainingBeatsInCurrentBar=4.0(不应≈4e-16)', Math.abs(remainingBeatsInCurrentBar(piece) - 4) < 1e-6, true);

console.log('\n═══ 场景2:第2小节应可正常追加音符 ═══');
const before = piece.notes.length;
const okQ = appendNote(piece, { midi: 60, duration: 'quarter', dotted: false, accidental: null });
check('追加四分音到第2小节', okQ, true);
check('notes 数 +1', piece.notes.length, before + 1);
check('新音 startBeat=4.0(第2小节起点)', Math.abs(noteStartBeats(piece)[piece.notes.length - 1] - 4) < 1e-6, true);

console.log('\n═══ 场景3:layout 待输入格子应落在新小节起点 ═══');
// 重新用原始 piece(撤掉刚追加的)测 layout
const piece2 = deserialize(json);
const lay = computeLayout(piece2, 940, 'quarter');
const bar2Start = lay.barLines[1];   // 第2小节起点 x
const nextSlotCenter = lay.nextSlotX;
check('待输入格子中心≈第2小节起点(不漂到小节线上)', Math.abs(nextSlotCenter - bar2Start - lay.nextSlotW / 2) < 1.5, true);
check('待输入格子宽度>0(未被锁死为0)', lay.nextSlotW > 0, true);
check('isFull=false(还有整个第2小节)', lay.isFull, false);

// 边界对照:非 tuplet 等价场景(8个八分=4拍填满第1小节)不应受影响
console.log('\n═══ 场景4:对照——非 tuplet 填满小节仍正常 ═══');
import { createPiece } from '../src/core/model.ts';
const p2 = createPiece();
p2.measureCount = 2;
for (let i = 0; i < 8; i++) appendNote(p2, { midi: 71, duration: 'eighth', dotted: false, accidental: null });
check('非tuplet totalBeats=4.0', Math.abs(totalBeats(p2) - 4) < 1e-6, true);
check('非tuplet remainingInBar=4.0', Math.abs(remainingBeatsInCurrentBar(p2) - 4) < 1e-6, true);
const okQ2 = appendNote(p2, { midi: 60, duration: 'quarter', dotted: false, accidental: null });
check('非tuplet 第2小节可追加', okQ2, true);

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`} (通过 ${pass}/${pass + fail})`);
if (fail > 0) process.exit(1);
