// 简谱翻译正确性验证脚本：跑各调号下的简谱输出，对比预期。
// 用法: npx tsx scripts/verify-jianpu.mjs
// 修复 letter 基准 bug 后，所有调号的输出应与「预期」一致（除八度记号可能差，属另一问题）。
import { noteToJianpu } from '../src/core/theory.ts';
import { KEYS } from '../src/core/theory.ts';

function show(keyName, midi, label, expect) {
  const r = noteToJianpu({ midi, duration: 'quarter', dotted: false, accidental: null }, KEYS[keyName]);
  const accStr = r.accidental ? `(${r.accidental})` : '';
  const octStr = r.octaveDots === 0 ? '中' : (r.octaveDots > 0 ? `高${r.octaveDots}` : `低${-r.octaveDots}`);
  const got = `${r.digit}${accStr}`;
  const ok = got === expect ? '✅' : '❌';
  console.log(`  ${ok} ${label}: 简谱 ${got} [${octStr}]  预期 ${expect}`);
  return got === expect;
}

let allOk = true;
console.log('═══ C 大调(对照) 预期: C=1 D=2 E=3 F=4 G=5 A=6 B=7 ═══');
allOk = show('C', 60, 'C4', '1') && allOk;
allOk = show('C', 62, 'D4', '2') && allOk;
allOk = show('C', 64, 'E4', '3') && allOk;
allOk = show('C', 65, 'F4', '4') && allOk;
allOk = show('C', 67, 'G4', '5') && allOk;
allOk = show('C', 69, 'A4', '6') && allOk;
allOk = show('C', 71, 'B4', '7') && allOk;

console.log('\n═══ G 大调(1升 F#) 预期: G=1 A=2 B=3 C=4 D=5 E=6 F#=7(sharp) ═══');
allOk = show('G', 67, 'G4', '1') && allOk;
allOk = show('G', 69, 'A4', '2') && allOk;
allOk = show('G', 71, 'B4', '3') && allOk;
allOk = show('G', 60, 'C4', '4') && allOk;
allOk = show('G', 62, 'D4', '5') && allOk;
allOk = show('G', 64, 'E4', '6') && allOk;
// F4 在 G 调是 F#(7级升)。注意:若 resolvePitch 把 F4 当成 E#(letter偏移)，数字会错
allOk = show('G', 65, 'F4(应7)', '7(sharp)') && allOk;

console.log('\n═══ A 大调(3升 F# C# G#) 预期: A=1 B=2 C#=3(sharp) D=4 E=5 F#=6(sharp) G#=7(sharp) ═══');
allOk = show('A', 69, 'A4', '1') && allOk;
allOk = show('A', 71, 'B4', '2') && allOk;
allOk = show('A', 60, 'C4(应3)', '3(sharp)') && allOk;  // ← 当前 bug: 输出 2
allOk = show('A', 62, 'D4', '4') && allOk;
allOk = show('A', 64, 'E4', '5') && allOk;
allOk = show('A', 65, 'F4(应6)', '6(sharp)') && allOk;
allOk = show('A', 67, 'G4(应7)', '7(sharp)') && allOk;

console.log('\n═══ F 大调(1降 Bb) 预期: F=1 G=2 A=3 Bb=4(flat) C=5 D=6 E=7 ═══');
allOk = show('F', 65, 'F4', '1') && allOk;
allOk = show('F', 67, 'G4', '2') && allOk;
allOk = show('F', 69, 'A4', '3') && allOk;
allOk = show('F', 71, 'B4(应4)', '4(flat)') && allOk;
allOk = show('F', 60, 'C4', '5') && allOk;
allOk = show('F', 62, 'D4', '6') && allOk;
allOk = show('F', 64, 'E4', '7') && allOk;

console.log(`\n${allOk ? '✅ 全部正确' : '❌ 存在错误(见上)'}`);
