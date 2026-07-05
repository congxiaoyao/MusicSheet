// 二级编辑页顶栏(appbar)。
//   [← 曲谱库]  [曲名(可改)] [调号徽章▾可点改] [拍号徽章▾可点改]        [👁 预览]
// 视图模式 radio 已移到工具盘第二行,小节选择移到工具盘第三行(MeasureSelector)。

import './editor-bar.css';
import { KeyName, TimeSig } from '../core/types';

export interface EditorBarState {
  title: string;
  key: KeyName;
  time: TimeSig;
}

export interface EditorBarCallbacks {
  onBack: () => void;
  onRename: (newTitle: string) => void;
  onChangeKey: (k: KeyName) => void;
  onChangeTime: (t: TimeSig) => void;
  onOpenPreview: () => void;
}

export interface EditorBarHandle {
  el: HTMLElement;
  /** 状态变化后刷新 appbar:曲名/徽章。 */
  refresh: (state: EditorBarState) => void;
}

const KEYS_ORDER: KeyName[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
const TIME_OPTIONS: [number, number][] = [[4, 4], [3, 4], [2, 4], [6, 8], [3, 8]];

export function buildEditorBar(initial: EditorBarState, cb: EditorBarCallbacks): EditorBarHandle {
  const wrap = document.createElement('div');
  wrap.className = 'editor-bar';

  // ── 行1: 返回 + 曲名 + 徽章 + 预览 ──
  const appbar = document.createElement('div');
  appbar.className = 'appbar';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'appbar-back';
  backBtn.title = '返回曲谱库';
  backBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>曲谱库`;
  backBtn.addEventListener('click', () => cb.onBack());
  appbar.appendChild(backBtn);

  const center = document.createElement('div');
  center.className = 'appbar-center';

  const nameEl = document.createElement('span');
  nameEl.className = 'appbar-name';
  nameEl.contentEditable = 'true';
  nameEl.spellcheck = false;
  nameEl.title = '点此改名';
  nameEl.textContent = initial.title;
  const commitName = () => {
    const t = (nameEl.textContent || '').trim() || '未命名';
    if (t !== nameEl.textContent) nameEl.textContent = t;
    cb.onRename(t);
  };
  nameEl.addEventListener('blur', commitName);
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameEl.blur(); }
  });
  center.appendChild(nameEl);

  // 调号徽章:可点击弹下拉改
  const keyDrop = document.createElement('div');
  keyDrop.className = 'badge-drop';
  const keyBtn = document.createElement('button');
  keyBtn.type = 'button';
  keyBtn.className = 'appbar-badge key';
  const keyCaret = document.createElement('span');
  keyCaret.className = 'caret';
  const keyMenu = document.createElement('div');
  keyMenu.className = 'badge-menu';
  for (const k of KEYS_ORDER) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = k + ' 大调';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      keyMenu.classList.remove('open');
      cb.onChangeKey(k);
    });
    keyMenu.appendChild(item);
  }
  keyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.badge-menu.open').forEach(m => { if (m !== keyMenu) m.classList.remove('open'); });
    keyMenu.classList.toggle('open');
  });
  keyDrop.append(keyBtn, keyMenu);
  center.appendChild(keyDrop);

  // 拍号徽章:可点击弹下拉改
  const timeDrop = document.createElement('div');
  timeDrop.className = 'badge-drop';
  const timeBtn = document.createElement('button');
  timeBtn.type = 'button';
  timeBtn.className = 'appbar-badge';
  const timeCaret = document.createElement('span');
  timeCaret.className = 'caret';
  const timeMenu = document.createElement('div');
  timeMenu.className = 'badge-menu';
  for (const [n, d] of TIME_OPTIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = `${n}/${d}`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      timeMenu.classList.remove('open');
      cb.onChangeTime({ num: n, den: d });
    });
    timeMenu.appendChild(item);
  }
  timeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.badge-menu.open').forEach(m => { if (m !== timeMenu) m.classList.remove('open'); });
    timeMenu.classList.toggle('open');
  });
  timeDrop.append(timeBtn, timeMenu);
  center.appendChild(timeDrop);

  // 点页面其它地方关闭下拉
  document.addEventListener('click', () => {
    document.querySelectorAll('.badge-menu.open').forEach(m => m.classList.remove('open'));
  });

  appbar.appendChild(center);

  const right = document.createElement('div');
  right.className = 'appbar-right';
  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'appbar-preview';
  previewBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> 预览`;
  previewBtn.title = '整曲预览';
  previewBtn.addEventListener('click', () => cb.onOpenPreview());
  right.appendChild(previewBtn);
  appbar.appendChild(right);

  wrap.appendChild(appbar);

  // ── refresh(同步 appbar:曲名/徽章文字/下拉 active)──
  const refresh = (state: EditorBarState) => {
    nameEl.textContent = state.title;
    keyBtn.textContent = `${state.key} 大调 `;
    keyBtn.appendChild(keyCaret);
    timeBtn.textContent = `${state.time.num}/${state.time.den} `;
    timeBtn.appendChild(timeCaret);
    keyMenu.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', KEYS_ORDER[i] === state.key));
    timeMenu.querySelectorAll('button').forEach((b, i) => {
      const [n, d] = TIME_OPTIONS[i];
      b.classList.toggle('active', n === state.time.num && d === state.time.den);
    });
  };

  refresh(initial);
  return { el: wrap, refresh };
}
