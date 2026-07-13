// 一次性迁移脚本:修正旧数据中调号音的 midi 值。
//
// ⚠️ 非幂等!已执行过(2026-07)。不要再跑 —— 已修正的 midi=56 再跑会被二次修正成 55。
// 留作记录:记录这次数据迁移的逻辑。
//
// 背景:clickYToMidi 旧实现不感知调号,Ab 调下点 A3 位置存成 midi=57(自然A)而非 56(Ab)。
// 修复 clickYToMidi 后,新录入正确,但旧数据仍是自然音 midi。本脚本把旧数据修正。
//
// 逻辑:对每个曲子的每个 Note:
//   - accidental=null(遵循调号):若 midi 的自然音 letter 落在 key.flats → midi-=1;sharps → midi+=1
//   - accidental='sharp'/'flat'/'natural':不迁移(forced 是用户手选,保持原样)
//
// 执行结果(2026-07):修正 83 个音(芒种尾奏 58 + 未命名 Ab 25)。
//
// 只影响降号/升号调曲子。C 调无升降号,不受影响。

import fs from 'fs';
import path from 'path';

const NATURAL_SEMITONE = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const LETTER_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** midi → 自然音字母(0..6)。和旧 midiToStaffStep 同款"最近自然字母"逻辑。 */
function midiToLetter(midi) {
  const pc = ((midi % 12) + 12) % 12;
  let best = 0, bestErr = 99;
  for (let l = 0; l < 7; l++) {
    const err = Math.abs(NATURAL_SEMITONE[l] - pc);
    if (err < bestErr) { bestErr = err; best = l; }
  }
  return best;
}

const STORE = path.resolve('store/pieces');
let totalChanged = 0;
let totalNotes = 0;
const changedPieces = [];

for (const dir of fs.readdirSync(STORE)) {
  const pieceDir = path.join(STORE, dir);
  const manifestPath = path.join(pieceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const key = manifest.key;
  const hasFlats = key.flats && key.flats.length > 0;
  const hasSharps = key.sharps && key.sharps.length > 0;
  if (!hasFlats && !hasSharps) continue;   // C 调,跳过

  let pieceChanged = 0;
  // 遍历所有小节文件 m*.json
  const measureFiles = fs.readdirSync(pieceDir)
    .filter(f => /^m\d+\.json$/.test(f))
    .sort();
  for (const mf of measureFiles) {
    const mp = path.join(pieceDir, mf);
    const measure = JSON.parse(fs.readFileSync(mp, 'utf8'));
    let fileChanged = false;
    for (const staff of ['treble', 'bass']) {
      if (!measure[staff]) continue;
      for (const note of measure[staff]) {
        totalNotes++;
        if (note.midi === null) continue;        // 休止符
        if (note.accidental !== null) continue;  // forced 音不迁移
        const letter = midiToLetter(note.midi);
        let newMidi = note.midi;
        if (key.flats.includes(letter)) newMidi = note.midi - 1;
        else if (key.sharps.includes(letter)) newMidi = note.midi + 1;
        if (newMidi !== note.midi) {
          note.midi = newMidi;
          pieceChanged++;
          totalChanged++;
          fileChanged = true;
        }
      }
    }
    if (fileChanged) {
      fs.writeFileSync(mp, JSON.stringify(measure));
    }
  }
  if (pieceChanged > 0) {
    changedPieces.push({ title: manifest.title, key: key.name, changed: pieceChanged });
    console.log(`${manifest.title} (${key.name}): 修正 ${pieceChanged} 个音`);
  }
}

console.log(`\n共修正 ${totalChanged} 个音 / ${totalNotes} 个非休止音`);
console.log(`受影响曲子: ${changedPieces.length} 个`);
if (changedPieces.length === 0) console.log('（无降号/升号调曲子需要迁移,或数据已正确）');
