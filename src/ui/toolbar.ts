// 工具栏：当前编辑状态 + 控件渲染

import { Clef, DurationValue, KeyName, TimeSig, noteValueBeats } from '../core/types';
import { G } from '../render/glyphs';

/** 连音模式。off=普通；其余值表示对应连音类型（actual:normal）。 */
export type TupletMode = 'off' | 'triplet' | 'quintuplet' | 'sextuplet';

/** 视图模式(排版区 radio):高音谱/低音谱/高低音谱/仅预览 */
export type ViewMode = 'treble' | 'bass' | 'grand' | 'preview';

/** 各连音模式的 actual:normal 配置。三连音=3:2(3个音占2个普通音位)；五连音=5:4；六连音=6:4。 */
export const TUPLET_CONFIG: Record<Exclude<TupletMode, 'off'>, { actual: number; normal: number; label: string }> = {
  triplet: { actual: 3, normal: 2, label: '三连音' },
  quintuplet: { actual: 5, normal: 4, label: '五连音' },
  sextuplet: { actual: 6, normal: 4, label: '六连音' },
};

/** 反查:actual 音数 → 对应 TupletMode。删除连音时用于从残留音的 tuplet.actual 恢复模式。 */
export function tupletModeForActual(actual: number): Exclude<TupletMode, 'off'> | null {
  for (const k of Object.keys(TUPLET_CONFIG) as Exclude<TupletMode, 'off'>[]) {
    if (TUPLET_CONFIG[k].actual === actual) return k;
  }
  return null;
}

/** 用户当前的「输入笔」状态 */
export interface ToolState {
  duration: DurationValue;
  dotted: boolean;
  accidental: 'sharp' | 'flat' | 'natural' | null;
  /** 下一个音符是否休止符 */
  rest: boolean;
  /** 连音组(tuplet)输入模式：off=关闭；triplet=三连音(3:2)；quintuplet=五连音(5:4)；sextuplet=六连音(6:4)。
   *  开启后接下来输入的 actual 个音自动归为一组，输入完第 actual 个后自动关闭。 */
  tupletMode: TupletMode;
  /** 和弦(chord)输入模式：开启后接下来输入的若干音叠在同一时间位(不推进时间),
   *  再按一次或输入不同时值音时关闭,光标推进到新时间位。 */
  chordMode: boolean;
  clef: Clef;
  key: KeyName;
  time: TimeSig;
  /** 总小节数（单行） */
  measureCount: number;
  /** 视图模式:高音谱/低音谱/高低音谱/仅预览 */
  viewMode: ViewMode;
}

export function defaultTool(): ToolState {
  return {
    duration: 'quarter',
    dotted: false,
    accidental: null,
    rest: false,
    tupletMode: 'off',
    chordMode: false,
    clef: 'treble',
    key: 'C',
    time: { num: 4, den: 4 },
    measureCount: 2,
    viewMode: 'treble',
  };
}

const DURATIONS: { value: DurationValue; label: string; sub: string }[] = [
  { value: 'whole', label: '𝅝', sub: '全音符' },
  { value: 'half', label: '𝅗𝅥', sub: '二分' },
  { value: 'quarter', label: '♩', sub: '四分' },
  { value: 'eighth', label: '♪', sub: '八分' },
  { value: 'sixteenth', label: '𝅘𝅥𝅯', sub: '十六分' },
  { value: 'thirtysecond', label: '𝅘𝅥𝅰', sub: '三十二分' },
];

/** 用 Bravura 字形拼工具栏时值图标(符头 + 符干 + 符尾),与五线谱画法一致、不错位。
 *  Bravura notehead 字形 baseline 居中穿过符头椭圆中心,故符头 baseline y = 符头垂直中心。
 *  符干从符头右边缘竖直向上,底端 = 符头中心(不穿过符头),长 0.62em(图标紧凑)。
 *  符干/符尾相对符头左移 3%(0.009em,符头不动)。返回 em 单位 SVG,自适应字号。 */
function durationIcon(d: DurationValue): string {
  const headAdv = 0.295;
  const stemW = 0.04;
  const shift = -0.012;                  // 符干/符尾左移 4%(符头不动)
  const stemTop = -0.62;
  const stemX = headAdv - stemW / 2 + shift;
  const stem = `<rect x="${stemX.toFixed(3)}" y="${stemTop}" width="${stemW}" height="${0 - stemTop}" fill="currentColor"/>`;
  let inner = '';
  if (d === 'whole') {
    inner = `<text x="0" y="0" font-family="Bravura" font-size="1" text-anchor="start" fill="currentColor">${G.noteheadWhole}</text>`;
  } else if (d === 'half') {
    inner = `<text x="0" y="0" font-family="Bravura" font-size="1" text-anchor="start" fill="currentColor">${G.noteheadHalf}</text>` + stem;
  } else {
    inner = `<text x="0" y="0" font-family="Bravura" font-size="1" text-anchor="start" fill="currentColor">${G.noteheadBlack}</text>` + stem;
    if (d === 'eighth' || d === 'sixteenth' || d === 'thirtysecond') {
      const flag = d === 'eighth' ? G.flag8thUp : d === 'sixteenth' ? G.flag16thUp : G.flag32ndUp;
      inner += `<text x="${(headAdv + shift).toFixed(3)}" y="${stemTop.toFixed(3)}" font-family="Bravura" font-size="1" text-anchor="start" fill="currentColor">${flag}</text>`;
    }
  }
  return `<svg viewBox="-0.05 -0.7 0.62 0.9" width="0.95em" height="1.35em" style="display:block;overflow:visible" aria-hidden="true">${inner}</svg>`;
}

/** 和弦图标:文字「和音」右侧的迷你图标。两小符头叠放 + 符干(右侧朝上)。
 *  符干长度按标准记谱 ≈ 2.2×符头高(图标紧凑,能识别是音符又不顶出按钮)。
 *  符头 ry=1.7(高3.4),符干=7.5。朝上符干对齐下符头(最低音)右边缘,
 *  底端=下符头中心,向上贯穿上符头到顶端。viewBox 14×18。 */
function chordIcon(): string {
  return '<svg viewBox="0 0 14 18" width="12" height="15" style="display:block" aria-hidden="true">'
    + '<ellipse cx="4.5" cy="8" rx="2.4" ry="1.7" fill="currentColor"/>'
    + '<ellipse cx="4.5" cy="12" rx="2.4" ry="1.7" fill="currentColor"/>'
    + '<rect x="6.3" y="4.5" width="0.9" height="7.5" fill="currentColor"/>'
    + '</svg>';
}

const KEYS_ORDER: KeyName[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];

export interface ToolbarCallbacks {
  onChange: () => void;
  onRest: () => void;
  /** 连音线(tie)动作:复制末尾音(同音高+同时值+同附点)追加进来,并打 tieStart/tieEnd */
  onTie: () => void;
  /** 切换和弦模式开关 */
  onToggleChord: () => void;
}

/** 构建工具栏 DOM，并把它与 ToolState 绑定 */
export function buildToolbar(state: ToolState, cb: ToolbarCallbacks): HTMLElement {
  const root = document.createElement('div');
  root.className = 'toolbar';

  // ── 时值选择 ──
  const durWrap = document.createElement('div');
  durWrap.className = 'tb-group';
  durWrap.appendChild(label('时值'));
  const durBtns: HTMLButtonElement[] = [];
  for (const d of DURATIONS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.dur = d.value;
    b.innerHTML = `<span class="chip-glyph">${durationIcon(d.value)}</span><span class="chip-sub">${d.sub}</span>`;
    b.title = d.sub;
    b.addEventListener('click', () => {
      state.duration = d.value;
      updateDurActive();
      cb.onChange();
    });
    durBtns.push(b);
    durWrap.appendChild(b);
  }
  function updateDurActive() {
    durBtns.forEach((b, i) => b.classList.toggle('active', DURATIONS[i].value === state.duration));
  }
  updateDurActive();
  root.appendChild(durWrap);

  // ── 修饰:和弦(图标)、附点、连音、休止、连音组、升降 ──
  const optWrap = document.createElement('div');
  optWrap.className = 'tb-group';
  optWrap.appendChild(label('修饰'));

  // 和弦(chord)模式开关:移到修饰行首位(比休止常用)。图标(缩小符头)+ 文字「和音」。
  const chordBtn = document.createElement('button');
  chordBtn.className = 'chip toggle';
  chordBtn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px"><span>和音</span>${chordIcon()}</span>`;
  chordBtn.title = '和弦模式(c)：连续输入的音叠加在同一时间位(再按关闭)';
  const syncChordUI = () => { chordBtn.classList.toggle('active', state.chordMode); };
  chordBtn.addEventListener('click', () => {
    state.chordMode = !state.chordMode;
    syncChordUI();
    cb.onToggleChord();
  });
  optWrap.appendChild(chordBtn);

  const dotBtn = toggle('附点 ·', '附点音符', () => state.dotted, (v) => { state.dotted = v; });
  optWrap.appendChild(dotBtn.el);
  // 连音线(tie):动作按钮,点一下立刻复制末尾音进来并自动连音(类休止按钮)。
  const tieBtn = document.createElement('button');
  tieBtn.className = 'chip toggle';
  tieBtn.textContent = '连音 ⌣';
  tieBtn.title = '连音(t)：复制末尾音(同音高+同时值)追加,并自动连音';
  tieBtn.addEventListener('click', () => { cb.onTie(); });
  optWrap.appendChild(tieBtn);
  // 休止符：直接作为「动作按钮」，点一下立刻追加一个休止符（当前时值），不再进入休止模式
  const restBtn = document.createElement('button');
  restBtn.className = 'chip toggle';
  restBtn.textContent = '休止 0';
  restBtn.title = '追加一个休止符(0)';
  restBtn.addEventListener('click', () => { cb.onRest(); });
  optWrap.appendChild(restBtn);

  // 连音组(tuplet):单个按钮,左键 toggle 三连音(高频),右键弹菜单选五/六连音。
  // 键盘 r/f/x 全保留(r=三连音、f=五连音、x=六连音)。
  const tupletMenu = document.createElement('div');
  tupletMenu.className = 'dropdown-menu anchored';   // anchored:fixed 定位,脱离工具栏流不被裁切
  function tupletBtnLabel(): string {
    if (state.tupletMode === 'triplet') return '3连';
    if (state.tupletMode === 'quintuplet') return '5连';
    if (state.tupletMode === 'sextuplet') return '6连';
    return '3连';
  }
  const tupletBtn = document.createElement('button');
  tupletBtn.className = 'chip toggle';
  tupletBtn.textContent = '3连';
  tupletBtn.title = '左键=三连音(r)　右键=选五/六连音(f/x)';
  const syncTupletUI = () => {
    tupletBtn.textContent = tupletBtnLabel();
    tupletBtn.classList.toggle('active', state.tupletMode !== 'off');
    tupletMenu.querySelectorAll('.dropdown-item').forEach((it) => {
      it.classList.toggle('active', state.tupletMode === (it as any).dataset.mode);
    });
  };
  // 左键:toggle 三连音
  tupletBtn.addEventListener('click', () => {
    state.tupletMode = state.tupletMode === 'triplet' ? 'off' : 'triplet';
    syncTupletUI();
  });
  // 右键:弹菜单选 N 连音(阻止系统菜单)
  tupletBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const open = tupletMenu.classList.toggle('open');
    syncTupletUI();
    // 定位菜单:左对齐按钮,但若右侧空间不足则改右对齐(避免被视口右边缘遮挡)
    if (open) {
      const r = tupletBtn.getBoundingClientRect();
      const menuW = 220;   // 菜单宽度(适配「五连音(5个音占4个普通音位)」等长文本)
      const margin = 8;
      const spaceRight = window.innerWidth - r.left;
      let left: number;
      if (spaceRight >= menuW + margin) {
        left = r.left;                       // 右侧够:左对齐按钮
      } else {
        left = Math.max(margin, r.right - menuW);  // 右侧不够:右对齐,不顶到视口边
      }
      tupletMenu.style.left = `${left}px`;
      tupletMenu.style.top = `${r.bottom + 4}px`;
      tupletMenu.style.minWidth = `${menuW}px`;
    }
  });
  for (const mode of ['triplet', 'quintuplet', 'sextuplet'] as const) {
    const cfg = TUPLET_CONFIG[mode];
    const item = document.createElement('button');
    item.className = 'dropdown-item';
    item.type = 'button';
    item.dataset.mode = mode;
    item.textContent = `${cfg.label}（${cfg.actual}个音占${cfg.normal}个普通音位）`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      state.tupletMode = state.tupletMode === mode ? 'off' : mode;
      tupletMenu.classList.remove('open');
      syncTupletUI();
    });
    tupletMenu.appendChild(item);
  }
  // 菜单挂在 body 下(脱离工具栏流,绝对定位)
  document.body.appendChild(tupletMenu);
  // 点页面其它地方关闭菜单
  document.addEventListener('click', () => { tupletMenu.classList.remove('open'); });
  optWrap.appendChild(tupletBtn);

  // 升降记号（三选一）
  const accWrap = document.createElement('div');
  accWrap.className = 'seg';
  const accNone = segBtn('本位', '遵循调号');
  const accSharp = segBtn('♯', '强制升');
  const accFlat = segBtn('♭', '强制降');
  function updateAcc() {
    accNone.classList.toggle('active', state.accidental === null);
    accSharp.classList.toggle('active', state.accidental === 'sharp');
    accFlat.classList.toggle('active', state.accidental === 'flat');
  }
  accNone.onclick = () => { state.accidental = null; updateAcc(); cb.onChange(); };
  accSharp.onclick = () => { state.accidental = 'sharp'; updateAcc(); cb.onChange(); };
  accFlat.onclick = () => { state.accidental = 'flat'; updateAcc(); cb.onChange(); };
  updateAcc();
  accWrap.append(accNone, accSharp, accFlat);
  optWrap.appendChild(accWrap);
  root.appendChild(optWrap);

  // ── 调号 / 拍号 ──(谱号由排版区 viewMode radio 控制,不再单独设谱号按钮)
  const setWrap = document.createElement('div');
  setWrap.className = 'tb-group';
  setWrap.appendChild(label('设置'));

  // 调号：自定义下拉（原生 <select> 的弹出面板无法用 CSS 美化，所以自建）
  const keyDrop = document.createElement('div');
  keyDrop.className = 'dropdown';
  const keyBtn = document.createElement('button');
  keyBtn.className = 'select';
  keyBtn.type = 'button';
  const keyLabel = document.createElement('span');
  keyBtn.appendChild(keyLabel);
  const keyCaret = document.createElement('span');
  keyCaret.className = 'select-caret';
  keyCaret.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  keyBtn.appendChild(keyCaret);
  const keyMenu = document.createElement('div');
  keyMenu.className = 'dropdown-menu';
  function refreshKeyBtn() {
    keyLabel.textContent = `${state.key} 大调`;
  }
  for (const k of KEYS_ORDER) {
    const item = document.createElement('button');
    item.className = 'dropdown-item';
    item.type = 'button';
    item.textContent = `${k} 大调`;
    item.addEventListener('click', () => {
      state.key = k;
      refreshKeyBtn();
      keyMenu.classList.remove('open');
      keyBtn.classList.remove('open');
      cb.onChange();
    });
    keyMenu.appendChild(item);
  }
  keyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = keyMenu.classList.toggle('open');
    keyBtn.classList.toggle('open', open);
    // 高亮当前
    keyMenu.querySelectorAll('.dropdown-item').forEach((it, i) => {
      it.classList.toggle('active', KEYS_ORDER[i] === state.key);
    });
  });
  refreshKeyBtn();
  keyDrop.appendChild(keyBtn);
  keyDrop.appendChild(keyMenu);
  setWrap.appendChild(keyDrop);
  // 点页面其它地方关闭
  document.addEventListener('click', () => { keyMenu.classList.remove('open'); keyBtn.classList.remove('open'); });


  const timeWrap = document.createElement('div');
  timeWrap.className = 'seg';
  for (const t of ['2/4', '3/4', '4/4']) {
    const b = segBtn(t, `${t} 拍`);
    if (`${state.time.num}/${state.time.den}` === t) b.classList.add('active');
    b.onclick = () => {
      state.time = { num: parseInt(t), den: 4 };
      timeWrap.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      cb.onChange();
    };
    timeWrap.appendChild(b);
  }
  setWrap.appendChild(timeWrap);
  root.appendChild(setWrap);

  // ── 排版:总小节数(单拎成独立分组) ──
  const layoutWrap = document.createElement('div');
  layoutWrap.className = 'tb-group';
  layoutWrap.appendChild(label('排版'));
  // 小节数（总小节数，单行）：离散选项 2/3/4/5/6
  const barWrap = document.createElement('div');
  barWrap.className = 'seg';
  const BAR_OPTIONS = [2, 3, 4, 5, 6];
  const barBtns: HTMLButtonElement[] = [];
  for (const n of BAR_OPTIONS) {
    const b = segBtn(String(n), `${n} 个小节`);
    if (state.measureCount === n) b.classList.add('active');
    b.onclick = () => {
      state.measureCount = n;
      barBtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      cb.onChange();
    };
    barBtns.push(b);
    barWrap.appendChild(b);
  }
  layoutWrap.appendChild(barWrap);

  // 视图模式 radio(高音谱/低音谱/高低音谱/仅预览):控制显示几个卡片 + 预览模式。
  // 图标用音乐符号(谱号 ♩),innerHTML 让符号放大,与其他按钮风格统一。
  const viewWrap = document.createElement('div');
  viewWrap.className = 'seg';
  const VIEW_OPTIONS: { v: ViewMode; glyph: string; text: string; title: string }[] = [
    { v: 'treble', glyph: '𝄞', text: '高音', title: '高音谱(单卡)' },
    { v: 'bass', glyph: '𝄢', text: '低音', title: '低音谱(单卡)' },
    { v: 'grand', glyph: '𝄞𝄢', text: '双谱', title: '高低音谱(双卡可分别编辑)' },
    { v: 'preview', glyph: '♪', text: '预览', title: '仅预览(双谱表可视化 seekbar)' },
  ];
  for (const o of VIEW_OPTIONS) {
    const b = segBtn('', o.title);
    b.innerHTML = `<span class="view-glyph">${o.glyph}</span><span>${o.text}</span>`;
    if (state.viewMode === o.v) b.classList.add('active');
    b.onclick = () => {
      state.viewMode = o.v;
      viewWrap.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      cb.onChange();
    };
    viewWrap.appendChild(b);
  }
  layoutWrap.appendChild(viewWrap);
  root.appendChild(layoutWrap);

  // 返回需要重置修饰的钩子（休止符/连音现在是动作按钮，无需重置；和弦模式是持久开关，也不重置）。
  // 同时暴露容量刷新：根据「本小节剩余拍数」「全局剩余拍数」disable 放不下的时值/附点按钮。
  (root as any)._resetModifiers = () => {
    state.dotted = false;
    state.accidental = null;
    dotBtn.set(false);
    updateAcc();
  };
  (root as any)._setTupletMode = (v: TupletMode) => {
    state.tupletMode = v;
    syncTupletUI();
  };
  (root as any)._setChordMode = (v: boolean) => {
    state.chordMode = v;
    syncChordUI();
  };
  (root as any)._refreshCapacity = (remBarBeats: number, remPieceBeats: number) => {
    const pieceFull = remPieceBeats < 1e-6;
    // 时值按钮：该时值(非附点)放不进本小节剩余 → disable
    durBtns.forEach((b, i) => {
      const dur = DURATIONS[i].value;
      const need = noteValueBeats(dur, false);
      b.disabled = pieceFull || need > remBarBeats + 1e-6;
    });
    // 附点按钮：当前选中时值加附点放不进 → disable
    const dottedNeed = noteValueBeats(state.duration, true);
    dotBtn.el.disabled = pieceFull || dottedNeed > remBarBeats + 1e-6;
  };

  return root;
}

function label(t: string): HTMLElement {
  const e = document.createElement('span');
  e.className = 'tb-label';
  e.textContent = t;
  return e;
}

function toggle(text: string, title: string, get: () => boolean, set: (v: boolean) => void): { el: HTMLButtonElement; set: (v: boolean) => void } {
  const b = document.createElement('button');
  b.className = 'chip toggle';
  b.textContent = text;
  b.title = title;
  if (get()) b.classList.add('active');
  b.addEventListener('click', () => {
    const v = !get();
    set(v);
    b.classList.toggle('active', v);
  });
  return { el: b, set: (v: boolean) => { b.classList.toggle('active', v); } };
}

function segBtn(text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'seg-btn';
  b.textContent = text;
  b.title = title;
  return b;
}
