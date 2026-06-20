// 和弦(chord)数据层验证:时间位去重、totalBeats、tie 复制、和弦+连梁分组
// 用法: npx tsx scripts/verify-chord.mjs
import { durationBeats } from '../src/core/types.ts';
import { createPiece, appendNote, totalBeats, noteStartBeats, isChordTail, chordGroups, popNote } from '../src/core/model.ts';
import { computeBeams } from '../src/render/beam.ts';

let pass = 0, fail = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 得 ${JSON.stringify(got)} / 期 ${JSON.stringify(expect)}`);
  ok ? pass++ : fail++;
}

// ── 场景1:三和弦 C+E+G(四分),应占 1 拍,3 个音同 startBeat ──
console.log('═══ 场景1:三和弦 C4+E4+G4(四分) ─══');
let p = createPiece();
appendNote(p, { midi: 60, duration: 'quarter', dotted: false, accidental: null, chordId: 'c1' });
appendNote(p, { midi: 64, duration: 'quarter', dotted: false, accidental: null, chordId: 'c1' });
appendNote(p, { midi: 67, duration: 'quarter', dotted: false, accidental: null, chordId: 'c1' });
check('totalBeats(三和弦四分)=1拍', totalBeats(p), 1);
check('noteStartBeats 全 0(同时)', noteStartBeats(p), [0, 0, 0]);
check('isChordTail: 首音false 尾音true', [isChordTail(p.notes[0], null), isChordTail(p.notes[1], p.notes[0]), isChordTail(p.notes[2], p.notes[1])], [false, true, true]);
check('chordGroups 1组[0,2]', chordGroups(p).map(g => [g.startIdx, g.endIdx]), [[0, 2]]);

// ── 场景2:三和弦后接单音 D4(四分),单音应推进到拍位 1 ──
console.log('\n═══ 场景2:和弦 + 单音 ─══');
appendNote(p, { midi: 62, duration: 'quarter', dotted: false, accidental: null });
check('totalBeats=2拍(和弦1+单音1)', totalBeats(p), 2);
check('noteStartBeats 单音在拍1', noteStartBeats(p), [0, 0, 0, 1]);

// ── 场景3:popNote 删到只剩和弦首音(变单音和弦) ──
console.log('\n═══ 场景3:backspace 删和弦尾音 ─══');
popNote(p); // 删单音 D4
popNote(p); // 删和弦 G4 → 剩 C4+E4
check('删G4后 totalBeats=1', totalBeats(p), 1);
check('chordGroups 仍1组[0,1]', chordGroups(p).map(g => [g.startIdx, g.endIdx]), [[0, 1]]);
popNote(p); // 删 E4 → 剩 C4(单音和弦)
check('删E4后剩单音 totalBeats=1', totalBeats(p), 1);
check('单音和弦也算1组', chordGroups(p).map(g => [g.startIdx, g.endIdx]), [[0, 0]]);

// ── 场景4:两个八分和弦应连成一组连梁 ──
console.log('\n═══ 场景4:两个八分和弦连梁 ─══');
p = createPiece();
appendNote(p, { midi: 60, duration: 'eighth', dotted: false, accidental: null, chordId: 'c1' });
appendNote(p, { midi: 64, duration: 'eighth', dotted: false, accidental: null, chordId: 'c1' });
appendNote(p, { midi: 67, duration: 'eighth', dotted: false, accidental: null, chordId: 'c1' });
appendNote(p, { midi: 62, duration: 'eighth', dotted: false, accidental: null, chordId: 'c2' });
appendNote(p, { midi: 65, duration: 'eighth', dotted: false, accidental: null, chordId: 'c2' });
appendNote(p, { midi: 69, duration: 'eighth', dotted: false, accidental: null, chordId: 'c2' });
const beams = computeBeams(p);
// 预期:1 个连梁组。BeamGroup 范围覆盖整个连梁段 [0,5](含尾音索引,closeGroup 用循环变量 i),
// 但 renderBeams 收集时会再过滤 chordTail,只取首音 idx 0、3 作为时间位。
check('连梁组数=1', beams.length, 1);
check('连梁组范围[0,5](覆盖整段)', beams.length ? [beams[0].startIdx, beams[0].endIdx] : [], [0, 5]);
check('totalBeats=1拍(两个八分=0.5+0.5)', totalBeats(p), 1);

// ── 场景5:tie 复制(模拟 tieRepeat):C4 → 复制C4打tie,总时长=2拍 ──
console.log('\n═══ 场景5:单音 tie 复制 ─══');
p = createPiece();
appendNote(p, { midi: 60, duration: 'half', dotted: false, accidental: null });
// tieRepeat 等价:复制 + 打 tieStart/tieEnd
const src = p.notes[0];
appendNote(p, { midi: 60, duration: 'half', dotted: false, accidental: null, tieEnd: true });
src.tieStart = true;
check('tie 后 totalBeats=4拍(2+2)', totalBeats(p), 4);
check('noteStartBeats [0,2]', noteStartBeats(p), [0, 2]);

// ── 场景6:和弦 tie 复制:C4+E4+G4 → 复制整组打tie ──
console.log('\n═══ 场景6:和弦 tie 复制 ─══');
p = createPiece();
appendNote(p, { midi: 60, duration: 'quarter', dotted: false, accidental: null, chordId: 'a' });
appendNote(p, { midi: 64, duration: 'quarter', dotted: false, accidental: null, chordId: 'a' });
appendNote(p, { midi: 67, duration: 'quarter', dotted: false, accidental: null, chordId: 'a' });
// 模拟 tieRepeat:源组全标 tieStart,复制新组(同midi,新chordId)全标 tieEnd
p.notes[0].tieStart = true; p.notes[1].tieStart = true; p.notes[2].tieStart = true;
appendNote(p, { midi: 60, duration: 'quarter', dotted: false, accidental: null, chordId: 'b', tieEnd: true });
appendNote(p, { midi: 64, duration: 'quarter', dotted: false, accidental: null, chordId: 'b', tieEnd: true });
appendNote(p, { midi: 67, duration: 'quarter', dotted: false, accidental: null, chordId: 'b', tieEnd: true });
check('和弦tie totalBeats=2拍(两组各1,无额外推进)', totalBeats(p), 2);
check('noteStartBeats 源组[0,0,0] 新组[1,1,1]', noteStartBeats(p), [0, 0, 0, 1, 1, 1]);

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`} (通过 ${pass}/${pass + fail})`);
if (fail > 0) process.exit(1);
