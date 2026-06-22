// 回归:n连音删除错乱修复 — 输入中/完成后删除 + toolbar 联动
// 用法: npx tsx scripts/verify-tuplet-delete.mjs
import { createPiece, appendNote, popNote, totalBeats } from '../src/core/model.ts';
import { tupletModeForActual, TUPLET_CONFIG } from '../src/ui/toolbar.ts';

let pass = 0, fail = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 得 ${JSON.stringify(got)} / 期 ${JSON.stringify(expect)}`);
  ok ? pass++ : fail++;
}

// 复刻 app.ts 的 tupletProgress 逻辑 + deleteLastNote 的 tuplet 修正
function makeState() {
  return { tupletProgress: null, tupletMode: 'off', tupletIdCounter: 0 };
}
function inputTupletNote(piece, st, midi, mode) {
  const cfg = TUPLET_CONFIG[mode];
  if (!st.tupletProgress) {
    st.tupletProgress = { groupId: `tup-${++st.tupletIdCounter}`, count: 0, actual: cfg.actual, normal: cfg.normal };
  }
  const tupInfo = { actual: st.tupletProgress.actual, normal: st.tupletProgress.normal, groupId: st.tupletProgress.groupId };
  appendNote(piece, { midi, duration: 'eighth', dotted: false, accidental: null, tuplet: tupInfo });
  st.tupletMode = mode;
  st.tupletProgress.count++;
  if (st.tupletProgress.count >= st.tupletProgress.actual) {
    st.tupletProgress = null;
    st.tupletMode = 'off';
  }
}
// 复刻 deleteLastNote 的 tuplet 修正
function deleteLast(piece, st) {
  const notes = piece.notes;
  if (notes.length === 0) return;
  const removed = notes[notes.length - 1];
  const removedTup = removed.tuplet;
  popNote(piece);
  if (removedTup) {
    const gid = removedTup.groupId;
    const remainInGroup = notes.filter(n => n.tuplet?.groupId === gid);
    if (remainInGroup.length === 0) {
      st.tupletProgress = null;
      st.tupletMode = 'off';
    } else {
      const mode = tupletModeForActual(removedTup.actual);
      if (mode) {
        st.tupletMode = mode;
        st.tupletProgress = { groupId: gid, count: remainInGroup.length, actual: removedTup.actual, normal: removedTup.normal };
      }
    }
  }
}

console.log('═══ 场景A:三连音输入中(输2个)→ 删1个 → 应可继续补齐 ═══');
const pA = createPiece(); pA.measureCount = 2;
const stA = makeState();
inputTupletNote(pA, stA, 60, 'triplet');
inputTupletNote(pA, stA, 62, 'triplet');
check('输入2个后 count=2', stA.tupletProgress?.count, 2);
deleteLast(pA, stA);
check('删1个后 notes=1', pA.notes.length, 1);
check('删1个后 count回退=1', stA.tupletProgress?.count, 1);
check('删1个后 模式仍triplet', stA.tupletMode, 'triplet');
check('删1个后 残留音仍带tuplet标记', pA.notes[0].tuplet?.groupId !== undefined, true);
// 继续补齐
inputTupletNote(pA, stA, 62, 'triplet');
inputTupletNote(pA, stA, 64, 'triplet');
check('补齐后 notes=3', pA.notes.length, 3);
check('补齐后 组内3个音', pA.notes.filter(n=>n.tuplet?.groupId).length, 3);
check('补齐后 模式关闭', stA.tupletMode, 'off');
check('补齐后 totalBeats=1拍(3八分三连音)', Math.abs(totalBeats(pA) - 1) < 1e-6, true);

console.log('\n═══ 场景B:三连音完成(3个)→ 删1个 → 应重进模式可补齐 ═══');
const pB = createPiece(); pB.measureCount = 2;
const stB = makeState();
inputTupletNote(pB, stB, 60, 'triplet');
inputTupletNote(pB, stB, 62, 'triplet');
inputTupletNote(pB, stB, 64, 'triplet');
check('完成3个后 模式关闭', stB.tupletMode, 'off');
check('完成3个后 tupletProgress=null', stB.tupletProgress, null);
deleteLast(pB, stB);
check('删1个后 notes=2', pB.notes.length, 2);
check('删1个后 重进triplet模式', stB.tupletMode, 'triplet');
check('删1个后 count=2(剩余音数)', stB.tupletProgress?.count, 2);
check('删1个后 groupId复用原组', stB.tupletProgress?.groupId, pB.notes[0].tuplet?.groupId);
// 补齐第3个
inputTupletNote(pB, stB, 64, 'triplet');
check('补齐后 notes=3', pB.notes.length, 3);
check('补齐后 组内3音(同groupId)', new Set(pB.notes.map(n=>n.tuplet?.groupId)).size, 1);
check('补齐后 模式关闭', stB.tupletMode, 'off');

console.log('\n═══ 场景C:三连音输入中 → 删到组空 → 模式应关闭 ═══');
const pC = createPiece(); pC.measureCount = 2;
const stC = makeState();
inputTupletNote(pC, stC, 60, 'triplet');
inputTupletNote(pC, stC, 62, 'triplet');
deleteLast(pC, stC);  // 删第2个
deleteLast(pC, stC);  // 删第1个 → 组空
check('删空后 notes=0', pC.notes.length, 0);
check('删空后 模式关闭', stC.tupletMode, 'off');
check('删空后 tupletProgress=null', stC.tupletProgress, null);

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`} (通过 ${pass}/${pass + fail})`);
if (fail > 0) process.exit(1);
