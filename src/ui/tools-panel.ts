// 工具盘(二级编辑页)—— demo .sv-tools 三行卡片,接全功能。
// 时值/和音图标:忠实复刻 staff.ts 编辑区画音符的几何(staff space 单位 + 切点偏移 +
//   墨迹半宽 + 符干宽/长 + 符尾),与五线谱上的音符同源同几何,非 Unicode 非简化图标。

import './tools-panel.css';
import './measure-selector.css';   // MeasureSelector 组件样式(挂在工具盘第三行)
import { DurationValue, ViewMode, noteValueBeats } from '../core/types';
import { ToolState, TupletMode } from './toolbar';
import { G, advanceSS } from '../render/glyphs';

// ── 与 staff.ts 同源的几何常量(staff space ss 为单位)──
// 直接复用 staff.ts 的数值,保证工具盘图标与编辑区五线谱音符几何一致。
const INK_HALF_W_RATIO = 0.497;   // 符头墨迹半宽 = advanceSS × 此比例 × ss(staff.ts 实测)
const HEAD_TANGENT_OFFSET = 0.16; // 符头切点偏移:符干连符头的端偏离垂直中心 0.16ss
const W_STEM = 0.24;              // 符干宽 = 0.24ss(staff.ts W_STEM)
const STEM_LEN = 3.5;             // 符干长 = 3.5ss(staff.ts 标准符干)

/** 时值图标 SVG:忠实复刻 staff.ts renderNote 的几何。
 *  内部用 staff space 单位(ss 定值),fs=4*ss。stemUp(图标统一朝上)。
 *  几何:
 *  - 符头:<text> Bravura noteheadBlack/Half/Whole,墨迹半宽 headHalfW=advanceSS*INK_HALF_W_RATIO*ss
 *  - 符干:<rect> 宽 W_STEM*ss、长 STEM_LEN*ss;右缘=x+headHalfW-stemW(对齐符头右切点);
 *          底端=headY-HEAD_TANGENT_OFFSET*ss(切点偏上);顶端=底端-STEM_LEN*ss
 *  - 符尾:<text> flag8thUp/16thUp/32ndUp,anchor=start,贴符干顶端(八分及以下)
 *  viewBox 按实际占位算出,精确无裁切。 */
function durationIcon(d: DurationValue): string {
  const ss = 10;                 // 图标 staff space 定值
  const fs = 4 * ss;             // = 40,Bravura em = 4ss
  const headX = ss * 1.2;        // 符头中心 x(留左余量给视觉居中)
  const headY = ss * 4.2;        // 符头中心 y(留顶部余量给符干+符尾)

  // 符头字形 + 墨迹半宽
  const headName = d === 'whole' ? 'noteheadWhole' : d === 'half' ? 'noteheadHalf' : 'noteheadBlack';
  const headGlyph = d === 'whole' ? G.noteheadWhole : d === 'half' ? G.noteheadHalf : G.noteheadBlack;
  const headHalfW = advanceSS(headName) * INK_HALF_W_RATIO * ss;

  const elems: string[] = [];
  // 符头(Bravura text,dominant-baseline alphabetic;text 的 y 是 baseline;
  //   Bravura notehead baseline 穿过椭圆中心 → y=headY)
  elems.push(`<text x="${headX}" y="${headY}" font-family="Bravura" font-size="${fs}" text-anchor="middle" dominant-baseline="alphabetic" fill="currentColor">${headGlyph}</text>`);

  // whole 无符干/符尾
  if (d !== 'whole') {
    const stemW = W_STEM * ss;
    const tangentOff = HEAD_TANGENT_OFFSET * ss;
    const stemLen = STEM_LEN * ss;
    // stemUp:右缘 = headX + headHalfW - stemW;底端 = headY - tangentOff;顶端 = 底端 - stemLen
    const stemX = headX + headHalfW - stemW;
    const stemBot = headY - tangentOff;
    const stemTop = stemBot - stemLen;
    elems.push(`<rect x="${stemX.toFixed(2)}" y="${stemTop.toFixed(2)}" width="${stemW.toFixed(2)}" height="${stemLen.toFixed(2)}" fill="currentColor"/>`);
    // 符尾:八分及以下
    if (d === 'eighth' || d === 'sixteenth' || d === 'thirtysecond') {
      const flagGlyph = d === 'eighth' ? G.flag8thUp : d === 'sixteenth' ? G.flag16thUp : G.flag32ndUp;
      // staff.ts: text(flag, stemX+stemW/2, stemTop, fs, anchor:start)。flag 字形 baseline 在符干顶端
      elems.push(`<text x="${(stemX + stemW / 2).toFixed(2)}" y="${stemTop.toFixed(2)}" font-family="Bravura" font-size="${fs}" text-anchor="start" dominant-baseline="alphabetic" fill="currentColor">${flagGlyph}</text>`);
    }
  }

  // viewBox:按实际占位算。x 从 符头左缘-headHalfW 余量 到 符干右/符尾右;y 从 符干顶端余量 到 符头底
  const padX = ss * 0.6, padY = ss * 0.6;
  const minX = headX - headHalfW - padX;
  // 右端:whole=符头右缘;否则 max(符干右缘, 符尾右缘≈stemX+flagAdvance*ss)
  let maxX: number;
  if (d === 'whole') {
    maxX = headX + headHalfW + padX;
  } else {
    const stemRight = headX + headHalfW + padX;
    const stemW = W_STEM * ss;
    const stemX = headX + headHalfW - stemW;
    const flagAdv = (d === 'eighth' || d === 'sixteenth' || d === 'thirtysecond')
      ? advanceSS(d === 'eighth' ? 'flag8thUp' : d === 'sixteenth' ? 'flag16thUp' : 'flag32ndUp') * ss : 0;
    maxX = Math.max(stemRight, stemX + stemW + flagAdv + padX);
  }
  const tangentOff = HEAD_TANGENT_OFFSET * ss;
  const stemTop = (headY - tangentOff) - STEM_LEN * ss;
  const minY = Math.min(stemTop, headY - headHalfW) - padY;
  const maxY = headY + headHalfW + padY;
  const vbW = maxX - minX, vbH = maxY - minY;
  return `<svg viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${vbW.toFixed(2)} ${vbH.toFixed(2)}" width="1.1em" height="1.5em" style="display:block;overflow:visible" aria-hidden="true">${elems.join('')}</svg>`;
}

/** 和音图标:两符头叠放 + 贯穿符干(参照 staff.ts 和弦画法)。
 *  两个 noteheadBlack 上下叠放(三度间隔),右侧一根符干贯穿两符头。 */
function chordIcon(): string {
  const ss = 4;
  const fs = 4 * ss;
  const headHalfW = advanceSS('noteheadBlack') * INK_HALF_W_RATIO * ss;
  const stemW = W_STEM * ss;
  const tangentOff = HEAD_TANGENT_OFFSET * ss;
  const stemLen = STEM_LEN * ss;
  // 两符头:下符头 y=8,上符头 y=5(三度 ≈ 1.5ss 间距,这里用 3ss 更醒目)
  const x = 6;
  const yLow = 9, yHigh = 6;
  const elems: string[] = [
    `<text x="${x}" y="${yLow}" font-family="Bravura" font-size="${fs}" text-anchor="middle" dominant-baseline="alphabetic" fill="currentColor">${G.noteheadBlack}</text>`,
    `<text x="${x}" y="${yHigh}" font-family="Bravura" font-size="${fs}" text-anchor="middle" dominant-baseline="alphabetic" fill="currentColor">${G.noteheadBlack}</text>`,
  ];
  // 符干:贯穿,右缘对齐下符头右切点,底端=下符头切点,顶端=底端-stemLen
  const stemX = x + headHalfW - stemW;
  const stemBot = yLow - tangentOff;
  const stemTop = stemBot - stemLen;
  elems.push(`<rect x="${stemX.toFixed(2)}" y="${stemTop.toFixed(2)}" width="${stemW.toFixed(2)}" height="${(stemBot - stemTop).toFixed(2)}" fill="currentColor"/>`);
  const padX = 1.5, padY = 1.5;
  const minX = x - headHalfW - padX;
  const maxX = x + headHalfW + padX;
  const minY = stemTop - padY;
  const maxY = yLow + headHalfW + padY;
  return `<svg viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${(maxX - minX).toFixed(2)} ${(maxY - minY).toFixed(2)}" width="0.95em" height="1.2em" style="display:block;overflow:visible" aria-hidden="true">${elems.join('')}</svg>`;
}

// ── 工具盘组件 ──────────────────────────────────────────────

/** 工具盘回调。 */
export interface ToolsPanelCallbacks {
  onChange: () => void;          // tool 状态变化(时值/修饰/临时等)
  onRest: () => void;
  onTie: () => void;
  onToggleChord: () => void;
  onChangeViewMode: (v: ViewMode) => void;   // 视图模式切换
}

export interface ToolsPanelHandle {
  el: HTMLElement;
  /** MeasureSelector 挂载宿主(第三行 .sv-measures-host)。 */
  measuresHost: HTMLElement;
  // 钩子(与原 toolbar 同名,app.ts 已有调用)
  _setTupletMode: (v: TupletMode) => void;
  _setChordMode: (v: boolean) => void;
  _setViewMode: (v: ViewMode) => void;       // 视图模式高亮同步
  _refreshCapacity: (remBarBeats: number, remPieceBeats: number) => void;
  _resetModifiers: () => void;
}

const DURATIONS: { value: DurationValue; sub: string }[] = [
  { value: 'whole', sub: '全' },
  { value: 'half', sub: '二分' },
  { value: 'quarter', sub: '四分' },
  { value: 'eighth', sub: '八分' },
  { value: 'sixteenth', sub: '十六分' },
  { value: 'thirtysecond', sub: '三十二分' },
];


/** state 直接传入 ToolState(App 的 this.tool 引用),改动直接同步。 */

/** state 直接传入 ToolState(App 的 this.tool 引用),改动直接同步——
 *  与原 toolbar 一致(原 toolbar 也是直接改传入 state)。App 的编辑逻辑全读 this.tool。 */
export function buildToolsPanel(state: ToolState, cb: ToolsPanelCallbacks): ToolsPanelHandle {
  const root = document.createElement('div');
  root.className = 'sv-tools';

  // ── 行1: 时值 / 修饰 / 临时 ──
  const row1 = document.createElement('div');
  row1.className = 'sv-tools-row';

  // 时值
  const durCell = document.createElement('div');
  durCell.className = 'sv-cell';
  durCell.appendChild(label('时值'));
  const durGroup = document.createElement('div');
  durGroup.className = 'sv-tool-group';
  const durBtns: HTMLButtonElement[] = [];
  for (const d of DURATIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sv-dur';
    b.dataset.dur = d.value;
    b.innerHTML = durationIcon(d.value);
    b.title = d.sub;
    b.addEventListener('click', () => {
      state.duration = d.value;
      updateDurActive();
      cb.onChange();
    });
    durBtns.push(b);
    durGroup.appendChild(b);
  }
  durCell.appendChild(durGroup);
  const dotBtn = document.createElement('button');
  dotBtn.type = 'button';
  dotBtn.className = 'sv-toggle';
  dotBtn.textContent = '附点';
  dotBtn.title = '附点 (.)';
  dotBtn.addEventListener('click', () => {
    state.dotted = !state.dotted;
    dotBtn.classList.toggle('active', state.dotted);
    cb.onChange();
  });
  durCell.appendChild(dotBtn);
  row1.appendChild(durCell);

  // 修饰
  const modCell = document.createElement('div');
  modCell.className = 'sv-cell';
  modCell.appendChild(label('修饰'));
  const chordBtn = document.createElement('button');
  chordBtn.type = 'button';
  chordBtn.className = 'sv-toggle';
  chordBtn.innerHTML = chordIcon() + '<span>和音</span>';
  chordBtn.title = '和音模式 (c)';
  chordBtn.addEventListener('click', () => {
    state.chordMode = !state.chordMode;
    chordBtn.classList.toggle('active', state.chordMode);
    cb.onToggleChord();
  });
  modCell.appendChild(chordBtn);
  const tupBtn = document.createElement('button');
  tupBtn.type = 'button';
  tupBtn.className = 'sv-toggle';
  tupBtn.textContent = '3连';
  tupBtn.title = '三连音 (r)';
  tupBtn.addEventListener('click', () => {
    // 简化:只在 off ↔ triplet 间切(demo 风格;五/六连由键盘 f/x)
    const next = state.tupletMode === 'triplet' ? 'off' : 'triplet';
    setTupletMode(next);
    cb.onChange();
  });
  modCell.appendChild(tupBtn);
  const tieBtn = document.createElement('button');
  tieBtn.type = 'button';
  tieBtn.className = 'sv-action';
  tieBtn.textContent = '连音';
  tieBtn.title = '连音线 (t)';
  tieBtn.addEventListener('click', () => cb.onTie());
  modCell.appendChild(tieBtn);
  const restBtn = document.createElement('button');
  restBtn.type = 'button';
  restBtn.className = 'sv-action';
  restBtn.textContent = '休止';
  restBtn.title = '追加休止符 (0)';
  restBtn.addEventListener('click', () => cb.onRest());
  modCell.appendChild(restBtn);
  row1.appendChild(modCell);

  // 临时记号
  const accCell = document.createElement('div');
  accCell.className = 'sv-cell';
  accCell.appendChild(label('临时'));
  const accGroup = document.createElement('div');
  accGroup.className = 'sv-tool-group';
  const accBtns: { btn: HTMLButtonElement; val: 'sharp' | 'flat' | 'natural' | null }[] = [];
  for (const o of [{ g: '♮', v: 'natural' as const }, { g: '♯', v: 'sharp' as const }, { g: '♭', v: 'flat' as const }]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sv-acc';
    b.textContent = o.g;
    b.title = o.v === 'sharp' ? '升' : o.v === 'flat' ? '降' : '本位';
    b.addEventListener('click', () => {
      state.accidental = state.accidental === o.v ? null : o.v;
      updateAccActive();
      cb.onChange();
    });
    accBtns.push({ btn: b, val: o.v });
    accGroup.appendChild(b);
  }
  // "无" 按钮(清除临时记号)
  const accNone = document.createElement('button');
  accNone.type = 'button';
  accNone.className = 'sv-acc';
  accNone.textContent = '无';
  accNone.title = '无临时记号';
  accNone.style.fontSize = '13px';
  accNone.addEventListener('click', () => {
    state.accidental = null;
    updateAccActive();
    cb.onChange();
  });
  accGroup.insertBefore(accNone, accGroup.firstChild);
  accCell.appendChild(accGroup);
  row1.appendChild(accCell);
  root.appendChild(row1);

  // ── 行2: 视图模式(独立一行,icon+文案,包在 sv-tool-group 浅白底里)──
  const row2 = document.createElement('div');
  row2.className = 'sv-tools-row';
  const viewCell = document.createElement('div');
  viewCell.className = 'sv-cell';
  viewCell.appendChild(label('视图'));
  const viewGroup = document.createElement('div');
  viewGroup.className = 'sv-tool-group view-group';
  const viewBtns: { btn: HTMLButtonElement; v: ViewMode }[] = [];
  for (const o of [
    { v: 'treble' as const, gly: G.gClef, text: '高音', title: '高音谱(单卡)' },
    { v: 'bass' as const, gly: G.fClef, text: '低音', title: '低音谱(单卡)' },
    { v: 'grand' as const, gly: G.gClef + G.fClef, text: '双谱', title: '双谱表(双卡)' },
    { v: 'preview' as const, gly: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>', text: '预览', title: '小节预览(只读+试听)' },
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'view-btn';
    b.title = o.title;
    b.innerHTML = `<span class="view-gly${o.v === 'grand' ? ' clef-pair' : ''}">${o.gly}</span>${o.text}`;
    b.addEventListener('click', () => {
      viewBtns.forEach(x => x.btn.classList.remove('active'));
      b.classList.add('active');
      cb.onChangeViewMode(o.v);
    });
    viewBtns.push({ btn: b, v: o.v });
    viewGroup.appendChild(b);
  }
  function updateViewActive() {
    viewBtns.forEach(({ btn, v }) => btn.classList.toggle('active', state.viewMode === v));
  }
  viewCell.appendChild(viewGroup);
  row2.appendChild(viewCell);
  root.appendChild(row2);

  // ── 行3: 小节(矮 pill 50px,包"小节"标签 + MeasureSelector,选框上下冒出)──
  const row3 = document.createElement('div');
  row3.className = 'sv-tools-row measure-row';
  const measurePill = document.createElement('div');
  measurePill.className = 'measure-pill';
  measurePill.appendChild(label('小节'));
  const measuresHost = document.createElement('div');
  measuresHost.className = 'sv-measures-host';
  measurePill.appendChild(measuresHost);
  row3.appendChild(measurePill);
  root.appendChild(row3);

  // ── 状态同步函数 ──
  function updateDurActive() {
    durBtns.forEach(b => b.classList.toggle('active', b.dataset.dur === state.duration));
  }
  function updateAccActive() {
    accBtns.forEach(({ btn, val }) => btn.classList.toggle('active', state.accidental === val));
    accNone.classList.toggle('active', state.accidental === null);
  }
  function setTupletMode(v: TupletMode) {
    state.tupletMode = v;
    tupBtn.classList.toggle('active', v === 'triplet');
  }

  // 初始高亮
  updateDurActive();
  dotBtn.classList.toggle('active', state.dotted);
  updateAccActive();
  setTupletMode(state.tupletMode);
  chordBtn.classList.toggle('active', state.chordMode);
  updateViewActive();

  return {
    el: root,
    measuresHost,
    _setTupletMode: (v: TupletMode) => setTupletMode(v),
    _setChordMode: (v: boolean) => { state.chordMode = v; chordBtn.classList.toggle('active', v); },
    _setViewMode: (v: ViewMode) => { state.viewMode = v; updateViewActive(); },
    _refreshCapacity: (remBarBeats: number, remPieceBeats: number) => {
      const pieceFull = remPieceBeats < 1e-6;
      durBtns.forEach((b, i) => {
        const need = noteValueBeats(DURATIONS[i].value, false);
        b.disabled = pieceFull || need > remBarBeats + 1e-6;
      });
    },
    _resetModifiers: () => {
      state.dotted = false;
      state.accidental = null;
      dotBtn.classList.remove('active');
      updateAccActive();
    },
  };
}

function label(text: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'sv-tlabel';
  s.textContent = text;
  return s;
}
