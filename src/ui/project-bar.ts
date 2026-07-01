// 项目面板(标题区右侧,两行):
//   第一行:当前曲谱下拉 + 新建 + 小节数增删(加小节/减小节)。
//   第二行:小节书签横滑条(7~8 个小节号 + 末尾「+」加小节)+ 右侧固定「预览」按钮。
//
// 点小节号 → onSelectMeasure(n):编辑区换到「从第 n 小节起的 N 个连续小节」。
// 预览按钮 → onOpenPreview():弹整曲预览框(Step 6)。

import { ScoreMeta } from '../core/score';

export interface ProjectBarState {
  pieces: ScoreMeta[];
  currentId: string | null;
  totalMeasures: number;
  currentStartMeasure: number;   // 0-based
  measuresPerLine: number;       // 编辑区显示几个小节(窗口大小)
}

export interface ProjectBarCallbacks {
  onSelectPiece: (id: string) => void;
  onCreatePiece: () => void;
  onDeletePiece: () => void;          // 删除当前曲谱
  onExportScore: () => void;          // 导出整曲(.mscore)
  onImportScore: () => void;          // 导入整曲(.mscore → 新曲谱)
  onAddMeasure: () => void;          // 末尾追加一小节(扩 totalMeasures)
  onRemoveMeasure: () => void;       // 末尾删除一小节
  onSelectMeasure: (measure0Based: number) => void;
  onOpenPreview: () => void;
}

export interface ProjectBarHandle {
  el: HTMLElement;
  /** 状态变化后刷新下拉选中项 + 书签条(active 高亮 + 横滑定位当前小节)。 */
  refresh: (state: ProjectBarState) => void;
}

/** 构建项目面板 DOM,返回句柄(含 refresh)。 */
export function buildProjectBar(initial: ProjectBarState, cb: ProjectBarCallbacks): ProjectBarHandle {
  const wrap = document.createElement('div');
  wrap.className = 'project-bar';

  // ── 第一行:曲谱选择 + 新建 + 小节增删 ──
  const row1 = document.createElement('div');
  row1.className = 'pb-row pb-row1';

  const select = document.createElement('select');
  select.className = 'pb-select';
  select.title = '选择曲谱';
  select.addEventListener('change', () => {
    const id = select.value;
    if (id) cb.onSelectPiece(id);
  });
  row1.appendChild(select);

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'pb-btn';
  newBtn.textContent = '＋ 新建';
  newBtn.title = '新建曲谱';
  newBtn.addEventListener('click', () => cb.onCreatePiece());
  row1.appendChild(newBtn);

  // 导入/导出/删除曲谱(曲谱级操作)。
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'pb-icon-btn';
  importBtn.textContent = '⬆ 导入';
  importBtn.title = '从 .mscore 文件导入整曲(新建一曲谱)';
  importBtn.addEventListener('click', () => cb.onImportScore());
  row1.appendChild(importBtn);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'pb-icon-btn';
  exportBtn.textContent = '⬇ 导出';
  exportBtn.title = '导出整曲为 .mscore 文件';
  exportBtn.addEventListener('click', () => cb.onExportScore());
  row1.appendChild(exportBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'pb-icon-btn pb-danger';
  deleteBtn.textContent = '🗑';
  deleteBtn.title = '删除当前曲谱';
  deleteBtn.addEventListener('click', () => cb.onDeletePiece());
  row1.appendChild(deleteBtn);

  const measureCtrl = document.createElement('div');
  measureCtrl.className = 'pb-measure-ctrl';
  measureCtrl.title = '曲谱总小节数';
  const mMinus = document.createElement('button');
  mMinus.type = 'button';
  mMinus.className = 'pb-mini-btn';
  mMinus.textContent = '−';
  mMinus.title = '末尾删一小节';
  mMinus.addEventListener('click', () => cb.onRemoveMeasure());
  const mLabel = document.createElement('span');
  mLabel.className = 'pb-measure-label';
  const mPlus = document.createElement('button');
  mPlus.type = 'button';
  mPlus.className = 'pb-mini-btn';
  mPlus.textContent = '+';
  mPlus.title = '末尾加一小节';
  mPlus.addEventListener('click', () => cb.onAddMeasure());
  measureCtrl.append(mMinus, mLabel, mPlus);
  row1.appendChild(measureCtrl);

  wrap.appendChild(row1);

  // ── 第二行:小节书签横滑条 + 预览按钮 ──
  const row2 = document.createElement('div');
  row2.className = 'pb-row pb-row2';

  const scroller = document.createElement('div');
  scroller.className = 'pb-bookmarks';
  row2.appendChild(scroller);

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'pb-preview-btn';
  previewBtn.innerHTML = '👁 <span>预览整曲</span>';
  previewBtn.title = '打开整曲预览(点小节定位)';
  previewBtn.addEventListener('click', () => cb.onOpenPreview());
  row2.appendChild(previewBtn);

  wrap.appendChild(row2);

  // ── refresh:重建下拉选项 + 书签条 ──
  const refresh = (state: ProjectBarState) => {
    // 下拉:选项 = 所有曲谱;选中当前
    select.innerHTML = '';
    for (const p of state.pieces) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.title || '未命名';
      if (p.id === state.currentId) opt.selected = true;
      select.appendChild(opt);
    }
    if (state.pieces.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = '(无曲谱)';
      opt.disabled = true;
      select.appendChild(opt);
    }
    mLabel.textContent = `${state.totalMeasures} 小节`;
    mMinus.disabled = state.totalMeasures <= 1;
    mPlus.disabled = state.totalMeasures >= 256;

    // 书签条:小节号 1..totalMeasures + 末尾「+」
    scroller.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < state.totalMeasures; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pb-bookmark';
      b.textContent = String(i + 1);
      b.dataset.measure = String(i);
      b.title = `第 ${i + 1} 小节(编辑区从这开始)`;
      // 高亮:该小节落在当前编辑区窗口内 [start, start+measuresPerLine)
      const inWindow = i >= state.currentStartMeasure && i < state.currentStartMeasure + state.measuresPerLine;
      if (inWindow) b.classList.add('in-window');
      if (i === state.currentStartMeasure) b.classList.add('active');
      b.addEventListener('click', () => cb.onSelectMeasure(i));
      frag.appendChild(b);
    }
    // 末尾「+」加小节
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'pb-bookmark pb-bookmark-add';
    addBtn.textContent = '+';
    addBtn.title = '末尾加一小节';
    addBtn.addEventListener('click', () => cb.onAddMeasure());
    frag.appendChild(addBtn);
    scroller.appendChild(frag);

    // 横滑定位:把当前起始小节的按钮滚到可视区左侧。
    const activeBtn = scroller.querySelector('.pb-bookmark.active') as HTMLElement | null;
    if (activeBtn) {
      // rAF 等 DOM 布局完成后再滚动。
      requestAnimationFrame(() => {
        activeBtn.scrollIntoView({ block: 'nearest', inline: 'start' });
      });
    }
  };

  refresh(initial);
  return { el: wrap, refresh };
}
