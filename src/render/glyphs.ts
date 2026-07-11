// SMuFL 字形：码位常量、字体加载、字形宽度

import codepoints from './smufl-codepoints.json';

const CP = codepoints as Record<string, string>;

/** 取某字形的码位字符串（如 "U+E050"）→ 转为可直接放进文本的字符 */
function glyph(name: string): string {
  const cp = CP[name];
  if (!cp) throw new Error(`Unknown SMuFL glyph: ${name}`);
  // cp 形如 "U+E050"
  const hex = cp.replace('U+', '');
  return String.fromCodePoint(parseInt(hex, 16));
}

// 常用字形（提前求值，避免每次查找）
export const G = {
  gClef: glyph('gClef'),
  fClef: glyph('fClef'),
  noteWhole: glyph('noteWhole'),
  noteheadBlack: glyph('noteheadBlack'),
  noteheadHalf: glyph('noteheadHalf'),
  noteheadWhole: glyph('noteheadWhole'),
  flag8thUp: glyph('flag8thUp'),
  flag8thDown: glyph('flag8thDown'),
  flag16thUp: glyph('flag16thUp'),
  flag16thDown: glyph('flag16thDown'),
  flag32ndUp: glyph('flag32ndUp'),
  flag32ndDown: glyph('flag32ndDown'),
  stem: glyph('stem'),
  augmentationDot: glyph('augmentationDot'),
  accidentalSharp: glyph('accidentalSharp'),
  accidentalFlat: glyph('accidentalFlat'),
  accidentalNatural: glyph('accidentalNatural'),
  restWhole: glyph('restWhole'),
  restHalf: glyph('restHalf'),
  restQuarter: glyph('restQuarter'),
  rest8th: glyph('rest8th'),
  rest16th: glyph('rest16th'),
  rest32nd: glyph('rest32nd'),
  legerLine: glyph('legerLine'),
  timeSig: (d: number) => glyph(`timeSig${d}`),
  timeSigCommon: glyph('timeSigCommon'),
  /** 连谱号 brace(U+E000)。ScoreSheet 用于连接 treble+bass 两谱表(跨整个 system 高度)。
   *  字形宽高比大,需配合 viewBox 缩放定位(见 score-sheet.ts renderBrace)。 */
  brace: glyph('brace'),
};

/** 字形前进宽度（以 staff space 为单位，em = 4 staff spaces）。来自 Bravura metadata。 */
const ADV = {
  gClef: 2.684, fClef: 2.736,
  accidentalSharp: 0.996, accidentalFlat: 0.904, accidentalNatural: 0.672,
  noteWhole: 1.836, noteheadBlack: 1.18, noteheadHalf: 1.18, noteheadWhole: 1.688,
  flag8thUp: 1.056, flag8thDown: 1.224, flag16thUp: 1.116, flag16thDown: 1.168,
  flag32ndUp: 1.048, flag32ndDown: 1.096,
  augmentationDot: 0.4,
  timeSigDigit: 1.88,
};

/** 某字形 advance 宽度（以 staff space 为单位） */
export function advanceSS(name: keyof typeof ADV): number {
  return ADV[name] ?? 1.2;
}

/** em 宽度（px）= font-size。staff space = em / 4 */
export function emPx(fontSize: number): number {
  return fontSize;
}
export function staffSpace(fontSize: number): number {
  return fontSize / 4;
}
/** 字形宽度（px）= advance(staff spaces) * staffSpace */
export function advPx(name: keyof typeof ADV, fontSize: number): number {
  const adv = ADV[name] ?? 1.2;
  return adv * staffSpace(fontSize);
}

// ── 字体加载 ────────────────────────────────────────────────

let fontLoadPromise: Promise<void> | null = null;

/** 确保 Bravura 字体已声明并加载完成 */
export function ensureFontLoaded(): Promise<void> {
  if (fontLoadPromise) return fontLoadPromise;
  fontLoadPromise = (async () => {
    // @font-face 已在 style.css 中声明（指向 /bravura.woff2）
    if ('fonts' in document) {
      try {
        // 用一个 PUA 字符触发加载
        await (document as any).fonts.load('48px Bravura', G.noteheadBlack);
        await (document as any).fonts.load('48px Bravura', G.gClef);
        await (document as any).fonts.load('48px Bravura', G.accidentalSharp);
        await (document as any).fonts.ready;
      } catch {
        /* 忽略：字体可能已在加载中 */
      }
    }
  })();
  return fontLoadPromise;
}
