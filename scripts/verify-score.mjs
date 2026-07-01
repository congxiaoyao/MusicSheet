// 整曲(Score)数据模型验证:rangeToPiece / pieceBackToScore 往返正确性。
// 核心风险:把「某小节起的 N 个」拼成 Piece 编辑后,能否按小节拍边界正确切回 score.measures。
// 用法: npx tsx scripts/verify-score.mjs
import { appendNote, createPiece } from '../src/core/model.ts';
import { durationBeats } from '../src/core/types.ts';
import { createScore, emptyMeasure, rangeToPiece, pieceBackToScore } from '../src/core/score.ts';
import { serializeScore, deserializeScore, serializeMeasure, deserializeMeasure, measureFileName } from '../src/core/serialize.ts';

let pass = 0, fail = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 得 ${JSON.stringify(got)} / 期 ${JSON.stringify(expect)}`);
  ok ? pass++ : fail++;
}
function note(midi, duration) { return { midi, duration, dotted: false, accidental: null }; }

const KEY_C = { name: 'C', tonic: 0, sharps: [], flats: [] };
const TIME_44 = { num: 4, den: 4 };

// ═══ 场景1:rangeToPiece 基本拼接(4 小节 score,取第 2 起的 2 个小节) ═══
console.log('═══ 场景1:rangeToPiece 基本拼接 ═══');
{
  const meta = { id: 's1', title: 't', key: KEY_C, time: TIME_44, totalMeasures: 4, viewMode: 'treble', updatedAt: 0 };
  const score = createScore(meta);
  // 第 0 小节放 4 个四分(C4),第 1 小节放 4 个四分(D4),第 2 小节放 E4×4,第 3 小节 F4×4
  score.measures[0].treble = [note(60, 'quarter'), note(60, 'quarter'), note(60, 'quarter'), note(60, 'quarter')];
  score.measures[1].treble = [note(62, 'quarter'), note(62, 'quarter'), note(62, 'quarter'), note(62, 'quarter')];
  score.measures[2].treble = [note(64, 'quarter'), note(64, 'quarter'), note(64, 'quarter'), note(64, 'quarter')];
  score.measures[3].treble = [note(65, 'quarter'), note(65, 'quarter'), note(65, 'quarter'), note(65, 'quarter')];

  // 取第 2 起的 2 个小节(startMeasure=2, count=2)
  const piece = rangeToPiece(score, 2, 2, 'treble');
  check('measureCount=2(取了2小节)', piece.measureCount, 2);
  check('treble 拼接8个音(E4×4 + F4×4)', piece.treble.map(n => n.midi), [64, 64, 64, 64, 65, 65, 65, 65]);
  check('bass 空', piece.bass, []);
  check('key/time 沿用整曲', [piece.key.name, piece.time.num], ['C', 4]);
  check('notes 指向 treble(活跃组)', piece.notes, piece.treble);
}

// ═══ 场景2:pieceBackToScore 切回 — 编辑后按小节边界正确切分 ═══
console.log('\n═══ 场景2:pieceBackToScore 切回 ═══');
{
  const meta = { id: 's2', title: 't', key: KEY_C, time: TIME_44, totalMeasures: 4, viewMode: 'treble', updatedAt: 0 };
  const score = createScore(meta);
  // 第 0 小节放满 C4×4(不能动),其余空
  score.measures[0].treble = [note(60, 'quarter'), note(60, 'quarter'), note(60, 'quarter'), note(60, 'quarter')];

  // 取第 1 起的 2 个小节,编辑:第1小节 D4×4,第2小节 E4×4
  let piece = rangeToPiece(score, 1, 2, 'treble');
  for (let i = 0; i < 4; i++) appendNote(piece, note(62, 'quarter'));  // D4×4 进第1小节
  for (let i = 0; i < 4; i++) appendNote(piece, note(64, 'quarter'));  // E4×4 进第2小节

  pieceBackToScore(score, piece, 1);
  check('第0小节不动(C4×4)', score.measures[0].treble.map(n => n.midi), [60, 60, 60, 60]);
  check('第1小节=D4×4', score.measures[1].treble.map(n => n.midi), [62, 62, 62, 62]);
  check('第2小节=E4×4', score.measures[2].treble.map(n => n.midi), [64, 64, 64, 64]);
  check('第3小节仍空', score.measures[3].treble, []);
  check('第3小节 bass 空(未触碰)', score.measures[3].bass, []);
}

// ═══ 场景3:只编辑第1小节不满,第2小节空 — 切回正确 ═══
console.log('\n═══ 场景3:部分填充的小节切回 ═══');
{
  const meta = { id: 's3', title: 't', key: KEY_C, time: TIME_44, totalMeasures: 2, viewMode: 'treble', updatedAt: 0 };
  const score = createScore(meta);
  let piece = rangeToPiece(score, 0, 2, 'treble');
  appendNote(piece, note(60, 'quarter'));  // 只放1个 C4 进第0小节
  // 第1小节空(不填)
  pieceBackToScore(score, piece, 0);
  check('第0小节=C4×1', score.measures[0].treble.map(n => n.midi), [60]);
  check('第1小节空', score.measures[1].treble, []);
}

// ═══ 场景4:跨小节的不同时值(八分×8 占2小节,4/4 每小节8个八分) ═══
console.log('\n═══ 场景4:八分音符跨小节切分 ═══');
{
  const meta = { id: 's4', title: 't', key: KEY_C, time: TIME_44, totalMeasures: 2, viewMode: 'treble', updatedAt: 0 };
  const score = createScore(meta);
  let piece = rangeToPiece(score, 0, 2, 'treble');
  // 8个八分 = 4拍 = 1小节,放16个八分填满2小节(每小节8个)
  for (let i = 0; i < 16; i++) appendNote(piece, note(60, 'eighth'));
  pieceBackToScore(score, piece, 0);
  check('第0小节=8个八分', score.measures[0].treble.length, 8);
  check('第1小节=8个八分', score.measures[1].treble.length, 8);
}

// ═══ 场景5:三连音(浮点鲁棒)— 三连音八分×12 填满 2 小节(4/4 每小节 6 个三连音八分=2拍×3) ═══
// 注:4/4 一小节 4 拍,三连音八分=1/3 拍,一小节 12 个三连音八分。放 24 个填满 2 小节。
console.log('\n═══ 场景5:三连音浮点鲁棒切分 ═══');
{
  const meta = { id: 's5', title: 't', key: KEY_C, time: TIME_44, totalMeasures: 2, viewMode: 'treble', updatedAt: 0 };
  const score = createScore(meta);
  let piece = rangeToPiece(score, 0, 2, 'treble');
  const tup = { actual: 3, normal: 2, groupId: 'g1' };
  for (let i = 0; i < 24; i++) appendNote(piece, { midi: 60, duration: 'eighth', dotted: false, accidental: null, tuplet: tup });
  pieceBackToScore(score, piece, 0);
  check('第0小节=12个三连音八分', score.measures[0].treble.length, 12);
  check('第1小节=12个三连音八分', score.measures[1].treble.length, 12);
}

// ═══ 场景6:rangeToPiece clamp(超出范围) ═══
console.log('\n═══ 场景6:rangeToPiece clamp ═══');
{
  const meta = { id: 's6', title: 't', key: KEY_C, time: TIME_44, totalMeasures: 3, viewMode: 'treble', updatedAt: 0 };
  const score = createScore(meta);
  // 从第 2 小节取 5 个 → 只能取到第 2(共 1 个小节)
  const piece = rangeToPiece(score, 2, 5, 'treble');
  check('measureCount clamp 到 1', piece.measureCount, 1);
}

// ═══ 场景7:bass 组独立编辑 ═══
console.log('\n═══ 场景7:bass 组独立 ═══');
{
  const meta = { id: 's7', title: 't', key: KEY_C, time: TIME_44, totalMeasures: 1, viewMode: 'bass', updatedAt: 0 };
  const score = createScore(meta);
  let piece = rangeToPiece(score, 0, 1, 'bass');
  for (let i = 0; i < 4; i++) appendNote(piece, note(40, 'quarter'));  // 低音 E2
  pieceBackToScore(score, piece, 0);
  check('bass 第0小节=4个音', score.measures[0].bass.map(n => n.midi), [40, 40, 40, 40]);
  check('treble 仍空', score.measures[0].treble, []);
}

// ═══ 场景8:整曲序列化往返(serializeScore/deserializeScore 零丢失) ═══
console.log('\n═══ 场景8:整曲序列化往返 ═══');
{
  const meta = { id: 's8', title: '我的曲子', key: KEY_C, time: TIME_44, totalMeasures: 2, viewMode: 'grand', updatedAt: 12345 };
  const score = createScore(meta);
  score.measures[0].treble = [note(60, 'quarter'), note(62, 'eighth')];
  score.measures[0].bass = [note(40, 'half')];
  const text = serializeScore(score);
  const back = deserializeScore(text);
  check('整曲往返 meta', back.meta, score.meta);
  check('整曲往返 measures', back.measures, score.measures);
}

// ═══ 场景9:小节序列化往返 + 文件名 ═══
console.log('\n═══ 场景9:小节序列化往返 ═══');
{
  const m = { treble: [note(60, 'quarter')], bass: [] };
  const text = serializeMeasure(m);
  const back = deserializeMeasure(text);
  check('小节往返', back, m);
  check('measureFileName(0)=m0001.json', measureFileName(0), 'm0001.json');
  check('measureFileName(9)=m0010.json', measureFileName(9), 'm0010.json');
}

console.log(`\n${fail === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
