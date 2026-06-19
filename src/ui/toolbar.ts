// 工具栏：当前编辑状态 + 控件渲染

import { Clef, DurationValue, KeyName, TimeSig, durationBeats } from '../core/types';

/** 用户当前的「输入笔」状态 */
export interface ToolState {
  duration: DurationValue;
  dotted: boolean;
  accidental: 'sharp' | 'flat' | 'natural' | null;
  /** 下一个音符是否休止符 */
  rest: boolean;
  clef: Clef;
  key: KeyName;
  time: TimeSig;
}

export function defaultTool(): ToolState {
  return {
    duration: 'quarter',
    dotted: false,
    accidental: null,
    rest: false,
    clef: 'treble',
    key: 'C',
    time: { num: 4, den: 4 },
  };
}

const DURATIONS: { value: DurationValue; label: string; sub: string }[] = [
  { value: 'whole', label: '𝅝', sub: '全音符' },
  { value: 'half', label: '𝅗𝅥', sub: '二分' },
  { value: 'quarter', label: '♩', sub: '四分' },
  { value: 'eighth', label: '♪', sub: '八分' },
  { value: 'sixteenth', label: '𝅘𝅥𝅯', sub: '十六分' },
];

const KEYS_ORDER: KeyName[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];

export interface ToolbarCallbacks {
  onChange: () => void;
  onRest: () => void;
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
    b.innerHTML = `<span class="chip-glyph">${d.label}</span><span class="chip-sub">${d.sub}</span>`;
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

  // ── 附点 / 升降 / 休止 ──
  const optWrap = document.createElement('div');
  optWrap.className = 'tb-group';
  optWrap.appendChild(label('修饰'));

  const dotBtn = toggle('附点 ·', '附点音符', () => state.dotted, (v) => { state.dotted = v; });
  // 休止符：直接作为「动作按钮」，点一下立刻追加一个休止符（当前时值），不再进入休止模式
  const restBtn = document.createElement('button');
  restBtn.className = 'chip toggle';
  restBtn.textContent = '休止 0';
  restBtn.title = '追加一个休止符';
  restBtn.addEventListener('click', () => { cb.onRest(); });
  optWrap.appendChild(dotBtn.el);
  optWrap.appendChild(restBtn);

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

  // ── 谱号 / 调号 / 拍号 ──
  const setWrap = document.createElement('div');
  setWrap.className = 'tb-group';
  setWrap.appendChild(label('设置'));

  const clefWrap = document.createElement('div');
  clefWrap.className = 'seg';
  const clefT = segBtn('高音 𝄞', '高音谱号');
  const clefB = segBtn('低音 𝄢', '低音谱号');
  clefT.onclick = () => { state.clef = 'treble'; clefT.classList.add('active'); clefB.classList.remove('active'); cb.onChange(); };
  clefB.onclick = () => { state.clef = 'bass'; clefB.classList.add('active'); clefT.classList.remove('active'); cb.onChange(); };
  (state.clef === 'treble' ? clefT : clefB).classList.add('active');
  clefWrap.append(clefT, clefB);
  setWrap.appendChild(clefWrap);

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

  // 返回需要重置修饰的钩子（休止符现在是动作按钮，无需重置）。
  // 同时暴露容量刷新：根据「本小节剩余拍数」「全局剩余拍数」disable 放不下的时值/附点按钮。
  (root as any)._resetModifiers = () => {
    state.dotted = false;
    state.accidental = null;
    dotBtn.set(false);
    updateAcc();
  };
  (root as any)._refreshCapacity = (remBarBeats: number, remPieceBeats: number) => {
    const pieceFull = remPieceBeats < 1e-6;
    // 时值按钮：该时值(非附点)放不进本小节剩余 → disable
    durBtns.forEach((b, i) => {
      const dur = DURATIONS[i].value;
      const need = durationBeats(dur, false);
      b.disabled = pieceFull || need > remBarBeats + 1e-6;
    });
    // 附点按钮：当前选中时值加附点放不进 → disable
    const dottedNeed = durationBeats(state.duration, true);
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
