// 回归:已输入完的和弦删除 + 输入中和弦删除
import { createPiece, appendNote, popNote } from '../src/core/model.ts';

let pass = 0, fail = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 得 ${JSON.stringify(got)} / 期 ${JSON.stringify(expect)}`);
  ok ? pass++ : fail++;
}

// 复刻 deleteLastNote 的 chord 修正逻辑
function deleteLast(piece, st) {
  const notes = piece.notes;
  if (notes.length === 0) return;
  const removed = notes[notes.length - 1];
  const removedChord = removed.chordId;
  popNote(piece);
  if (removedChord) {
    const remainInChord = notes.filter(n => n.chordId === removedChord);
    if (remainInChord.length === 0) {
      st.currentChordId = null; st.chordMode = false;
    } else if (remainInChord.length === 1) {
      remainInChord[0].chordId = undefined;
      st.currentChordId = null; st.chordMode = false;
    } else {
      st.currentChordId = removedChord; st.chordMode = true;
    }
  } else {
    const last = notes[notes.length - 1];
    if (st.currentChordId && (!last || last.chordId !== st.currentChordId)) st.currentChordId = null;
  }
}

console.log('═══ 场景A:3和弦删1个 → 恢复模式可补 ═══');
const pA = createPiece(); pA.measureCount = 2;
const cidA = 'cA';
appendNote(pA, { midi: 60, duration: 'quarter', dotted: false, accidental: null, chordId: cidA });
appendNote(pA, { midi: 64, duration: 'quarter', dotted: false, accidental: null, chordId: cidA });
appendNote(pA, { midi: 67, duration: 'quarter', dotted: false, accidental: null, chordId: cidA });
const stA = { currentChordId: null, chordMode: false };  // 模式已关
deleteLast(pA, stA);
check('删G4后 notes=2', pA.notes.length, 2);
check('删G4后 残留2音带chordId', pA.notes.filter(n=>n.chordId===cidA).length, 2);
check('删G4后 恢复currentChordId', stA.currentChordId, cidA);
check('删G4后 重开chordMode', stA.chordMode, true);
// 继续补 G4
appendNote(pA, { midi: 67, duration: 'quarter', dotted: false, accidental: null, chordId: cidA });
check('补G4后 notes=3', pA.notes.length, 3);
check('补G4后 组3音', new Set(pA.notes.map(n=>n.chordId)).size, 1);

console.log('\n═══ 场景B:删到只剩1音 → 清chordId变单音 ═══');
const pB = createPiece(); pB.measureCount = 2;
const cidB = 'cB';
appendNote(pB, { midi: 60, duration: 'quarter', dotted: false, accidental: null, chordId: cidB });
appendNote(pB, { midi: 64, duration: 'quarter', dotted: false, accidental: null, chordId: cidB });
const stB = { currentChordId: null, chordMode: false };
deleteLast(pB, stB);  // 删E4 → 剩C4
check('删E4后 notes=1', pB.notes.length, 1);
check('删E4后 C4的chordId清掉', pB.notes[0].chordId, undefined);
check('删E4后 currentChordId=null', stB.currentChordId, null);
check('删E4后 chordMode=false', stB.chordMode, false);

console.log('\n═══ 场景C:2和弦全删 → 模式关 ═══');
const pC = createPiece(); pC.measureCount = 2;
const cidC = 'cC';
appendNote(pC, { midi: 60, duration: 'quarter', dotted: false, accidental: null, chordId: cidC });
appendNote(pC, { midi: 64, duration: 'quarter', dotted: false, accidental: null, chordId: cidC });
const stC = { currentChordId: cidC, chordMode: true };
deleteLast(pC, stC);  // 删E4 → 剩C4(1音)清chordId
deleteLast(pC, stC);  // 删C4 → 空
check('全删后 notes=0', pC.notes.length, 0);
check('全删后 currentChordId=null', stC.currentChordId, null);
check('全删后 chordMode=false', stC.chordMode, false);

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`} (通过 ${pass}/${pass + fail})`);
if (fail > 0) process.exit(1);
