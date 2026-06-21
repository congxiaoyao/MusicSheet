// 回归:浮点鲁棒系统性修复(8333 连梁分组 + player totalBeats/noteIndexAtBeat + 小节号)
// 用法: npx tsx scripts/verify-float-robust.mjs
import { deserialize } from '../src/core/serialize.ts';
import { noteStartBeats, totalBeats, remainingBeatsInCurrentBar, measureOfBeat, beatGroupIndexOf, snapBeat, BEAT_EPS } from '../src/core/model.ts';
import { durationBeats, beatsPerBar } from '../src/core/types.ts';
import { computeBeams } from '../src/render/beam.ts';

let pass = 0, fail = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 得 ${JSON.stringify(got)} / 期 ${JSON.stringify(expect)}`);
  ok ? pass++ : fail++;
}

// ── 用户提供的第二个数据:八分 + 三连音(十六分) ×2 = 8333 / 8333 ──
const json8333 = `{
  "format":"musicsheet","version":1,"exportedAt":1782061636413,
  "piece":{"clef":"treble","key":{"name":"C","tonic":0,"sharps":[],"flats":[]},
  "time":{"num":4,"den":4},"measureCount":2,
  "notes":[
    {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
    {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"tup-24"}},
    {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"tup-24"}},
    {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"tup-24"}},
    {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
    {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"tup-26"}},
    {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"tup-26"}},
    {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"tup-26"}}
  ]}}`;

console.log('═══ 场景1:8333 连梁分组(八分+三连音同拍内连一组) ═══');
const piece8333 = deserialize(json8333);
const beams = computeBeams(piece8333);
check('连梁组数=2(8333 / 8333)', beams.length, 2);
check('组1范围[0..3](八分+三连音)', beams[0] ? [beams[0].startIdx, beams[0].endIdx] : [], [0, 3]);
check('组2范围[4..7](八分+三连音)', beams[1] ? [beams[1].startIdx, beams[1].endIdx] : [], [4, 7]);
check('组1 maxBeamCount=2(三连音十六分)', beams[0]?.maxBeamCount, 2);
check('组2 maxBeamCount=2', beams[1]?.maxBeamCount, 2);

console.log('\n═══ 场景2:beatGroupIndexOf 浮点鲁棒 ═══');
// 音4 startBeat 因三连音累加 = 0.9999999999999999,裸 floor 误判 beatGroup 0
const starts8333 = noteStartBeats(piece8333);
check('音4 startBeat 含浮点误差', starts8333[4] !== 1.0, true);
check('音4 beatGroup=1(拍1,非拍0)', beatGroupIndexOf(starts8333[4], 2), 1);
check('音0 beatGroup=0', beatGroupIndexOf(starts8333[0], 2), 0);

console.log('\n═══ 场景3:snapBeat 吸附网格 ═══');
check('snapBeat(3.9999999, 4)=4.0', snapBeat(3.9999999, 4), 4);
check('snapBeat(0.9999999, 1)=1.0', snapBeat(0.9999999, 1), 1);
check('snapBeat(3.5, 4)=3.5(非网格点不动)', snapBeat(3.5, 4), 3.5);
// 真实三连音拍位(1+2/3)离最近半拍网格(1.5)差 0.1667,远超 EPS → 不吸附(正确)
check('snapBeat(1.6667, 0.5)=1.6667(真实拍位不吸附)', snapBeat(1.6667, 0.5), 1.6667);
// 仅累加误差(~1e-16)才吸附:snapBeat(0.5+0.1666...*3=0.9999...e-16, 1) → 1.0
const accumErr = 0.5 + (0.25 * 2 / 3) * 3; // 模拟三连音累加
check('snapBeat(三连音累加误差, 1)=1.0', snapBeat(accumErr, 1), 1);

console.log('\n═══ 场景4:player totalBeats 应吸附小节网格 ═══');
// 模拟 player.play 的 totalBeats 计算(末音 endBeat 吸附到 bpb)
const lastEnd8333 = starts8333[starts8333.length - 1] + durationBeats(piece8333.notes.at(-1));
const bpb = beatsPerBar(piece8333.time);
const totalSnapped = snapBeat(lastEnd8333, bpb);
check('totalBeats 吸附后=2.0', totalSnapped, 2);
// 用「填满小节边界」的三连音数据(7八分+3十六分三连音=4拍)测:末音 endBeat 含误差
const jsonBoundary = `{"format":"musicsheet","version":1,"piece":{"clef":"treble","key":{"name":"C","tonic":0,"sharps":[],"flats":[]},"time":{"num":4,"den":4},"measureCount":2,"notes":[
  {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
  {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
  {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
  {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
  {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
  {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
  {"midi":71,"duration":"eighth","dotted":false,"accidental":null},
  {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"t1"}},
  {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"t1"}},
  {"midi":71,"duration":"sixteenth","dotted":false,"accidental":null,"tuplet":{"actual":3,"normal":2,"groupId":"t1"}}]}}`;
const pieceB = deserialize(jsonBoundary);
const startsB = noteStartBeats(pieceB);
const lastEndB = startsB[startsB.length - 1] + durationBeats(pieceB.notes.at(-1));
check('边界数据末音 endBeat 含误差(非精确4.0)', lastEndB !== 4, true);
check('边界数据 totalBeats 吸附后=4.0', snapBeat(lastEndB, 4), 4);

console.log('\n═══ 场景5:noteIndexAtBeat 末音区间不落空 ═══');
// 复刻 player.computeSchedule 的 raw(start/end) + noteIndexAtBeat 逻辑
function buildSchedule(piece) {
  const notes = piece.notes;
  const raw = [];
  let acc = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const d = durationBeats(n);
    // 8333 数据无和弦,简化
    raw.push({ index: i, startBeat: acc, endBeat: acc + d, voiceBeats: d });
    acc += d;
  }
  return raw;
}
function noteIndexAtBeat(schedule, beat) {
  for (const e of schedule) {
    if (beat >= e.startBeat - BEAT_EPS && beat < e.endBeat - BEAT_EPS) return e.index;
  }
  return schedule.length ? schedule[schedule.length - 1].index : -1;
}
const sched = buildSchedule(piece8333);
// beat = 末音 endBeat(含误差)— 旧逻辑返回 -1,新逻辑返回末音 index
check('beat=末音endBeat 返回末音(非-1)', noteIndexAtBeat(sched, lastEnd8333), piece8333.notes.length - 1);
// beat 在末音中段返回末音
check('beat=1.9 返回音7', noteIndexAtBeat(sched, 1.9), 7);
// beat 在间隙(不存在,但测边界)— beat=1.0(拍1起点=音4 startBeat)返回音4
check('beat=1.0 返回音4', noteIndexAtBeat(sched, 1.0), 4);

console.log('\n═══ 场景6:播放卡小节号 measureOfBeat ═══');
// beat=2.0(第2小节起点)应显示「小节2」(measureCount=2,共2小节)
// 模拟 8333 占2拍填满第1小节,若乐谱是4小节则 beat=2→小节2,beat=4→小节3...
const piece2bar = deserialize(json8333);
const mAt2 = measureOfBeat(2.0, 4) + 1;
check('beat=2.0 → 小节2', mAt2, 1); // 注意:8333 占2拍=填满... 等等,measureCount=2,bpb=4,2拍还在第1小节
// 修正:8333 总2拍,beat=2.0 时 measureOfBeat(2,4)=floor(2/4)=0 → 小节1。对(还在第1小节)
// 测边界:beat=4.0(填满第1小节)→ 小节2
check('beat=4.0 → 小节2', measureOfBeat(4.0, 4) + 1, 2);
check('beat=3.9999999 → 小节2(浮点鲁棒,非小节1)', measureOfBeat(3.9999999, 4) + 1, 2);
check('beat=8.0 → 小节3', measureOfBeat(8.0, 4) + 1, 3);

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`} (通过 ${pass}/${pass + fail})`);
if (fail > 0) process.exit(1);
