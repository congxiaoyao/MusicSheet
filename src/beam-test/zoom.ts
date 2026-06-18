// 单用例放大页：只渲染用例1（同拍2八分连梁），放大3倍便于核对横梁与符干的衔接。
import { Note, Piece, DurationValue } from '../core/types';
import { KEYS } from '../core/theory';
import { computeLayout } from '../render/layout';
import { buildSVG } from '../render/export';
import { ensureFontLoaded } from '../render/glyphs';

function n(midi: number | null, duration: DurationValue, dotted = false): Note {
  return { midi, duration, dotted, accidental: null };
}
const C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69, B4 = 71, C5 = 72;
const piece: Piece = {
  clef: 'treble', key: KEYS.C, time: { num: 4, den: 4 },
  notes: [n(C4, 'eighth'), n(D4, 'eighth'), n(E4, 'quarter'), n(F4, 'quarter'), n(G4, 'quarter'),
          n(A4, 'whole'), n(B4, 'whole'), n(C5, 'whole')],
};

async function main() {
  await ensureFontLoaded();
  const layout = computeLayout(piece, 600, 'eighth');
  const svg = buildSVG(piece, layout, -1, { exportMode: true });
  const root = document.getElementById('root')!;
  // 放大 3 倍便于看清
  root.innerHTML = `<div style="transform:scale(3);transform-origin:top left;margin:20px;">${svg}</div>`;
}
main();
