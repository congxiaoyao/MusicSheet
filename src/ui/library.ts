// 曲谱库一级页(首屏)—— 卡片即入口,卡片缩略图为该曲真实前两小节五线谱。
//
// 设计来源:library-demo.html / src/library-demo.ts(设计 demo)。
// 本模块是 demo 的"落地版":用真实服务端数据(经 storage.ts API),不做 mock。
// 由 App 持有,作为启动首屏;点卡片 → 回调 onOpen(id) → App 切到编辑器(二级页)。

import './library.css';
import { Score, ScoreMeta } from '../core/score';
import { rangeToPiece } from '../core/score';
import { getPiece } from '../core/storage';
import { computeLayout } from '../render/layout';
import { buildSVG } from '../render/export';
import { buildPromptModal } from './prompt-modal';

// ── 图标(内联 SVG,stroke=currentColor,与搜索框图标同款)──
// 严禁使用 emoji;曲谱库页面所有图标统一走 SVG。
const ICON = {
  // 视图分段:网格 / 列表
  grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>',
  // 新建(按钮 + 占位大卡)
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  plusBig: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  // 卡片操作:重命名 / 导出 / 删除
  pencil: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>',
  // 空状态:音符
  note: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
};

// ── 类型 ──────────────────────────────────────────────────

type View = 'grid' | 'list';
type Sort = 'recent' | 'title' | 'bars';

export interface LibraryCallbacks {
  /** 点卡片进入曲谱(动画结束后调)。 */
  onOpen: (id: string) => void;
  /** 点新建(工具栏按钮 / 末尾占位卡)。 */
  onNew: () => void;
  /** 卡片浮层 → 重命名。newTitle 已 trim(可能等于原标题)。 */
  onRename: (id: string, newTitle: string) => void;
  /** 卡片浮层 → 导出(.mscore)。 */
  onExport: (id: string) => void;
  /** 卡片浮层 → 删除(已 confirm)。 */
  onDelete: (id: string) => void;
}

export interface LibraryHandle {
  el: HTMLElement;
  /** meta 列表变化后刷新(保留 view/sort/query/selectedId/搜索框焦点),
   *  并为新曲谱惰性加载缩略图。 */
  refresh: (metas: ScoreMeta[]) => void;
}

// ── 内部状态 ──────────────────────────────────────────────

interface State {
  view: View;
  sort: Sort;
  query: string;
  selectedId: string | null;
  metas: ScoreMeta[];
  /** id → Score 缩略图缓存(惰性加载)。 */
  scores: Map<string, Score>;
}

// ── 工具 ──────────────────────────────────────────────────

const fmtTime = (ts: number): string => {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  return d + ' 天前';
};

/** 生成缩略图 SVG:用前 2 小节构 piece,buildSVG 渲染,裁掉简谱区只留五线谱。
 *  空曲谱(treble+bass 全空)返回 ''(由调用方加 .empty 占位)。复刻 demo thumbSvg。 */
function thumbSvg(score: Score): string {
  const total = score.meta.totalMeasures;
  if (total <= 0) return '';
  // 判空:前两小节是否全空(没有音就不渲染缩略图)。
  const thumbMeasures = Math.min(2, total);
  let anyNote = false;
  for (let i = 0; i < thumbMeasures; i++) {
    const m = score.measures[i];
    if (m && (m.treble.length > 0 || m.bass.length > 0)) { anyNote = true; break; }
  }
  if (!anyNote) return '';
  const piece = rangeToPiece(score, 0, thumbMeasures, 'treble');
  const layout = computeLayout(piece, 560, 'quarter');
  let svg = buildSVG(piece, layout, -1, { hover: null });
  // 只保留五线谱部分(裁掉简谱 group):用 viewBox 限制高度到 jianpuTop
  const vby = -layout.viewBoxYOffset;
  const staffH = layout.jianpuTop - vby + 8;
  svg = svg.replace(/viewBox="([^"]*)"/, `viewBox="${vby} ${vby} ${layout.width} ${staffH}"`);
  return svg;
}

/** 算该曲有多少小节"已写内容"(treble/bass 任一非空)。供进度点 filledCount 用。 */
function filledMeasureCount(score: Score | undefined): number {
  if (!score) return 0;
  let n = 0;
  for (const m of score.measures) {
    if (m && (m.treble.length > 0 || m.bass.length > 0)) n++;
  }
  return n;
}

// ── 主构造 ────────────────────────────────────────────────

export function buildLibrary(initial: ScoreMeta[], cb: LibraryCallbacks): LibraryHandle {
  const host = document.createElement('div');
  host.className = 'library-host';

  const state: State = {
    view: 'grid',
    sort: 'recent',
    query: '',
    selectedId: null,
    metas: initial.slice(),
    scores: new Map(),
  };
  /** 重命名 / 删除用的自定义弹窗(替代原生 prompt/confirm)。 */
  const modal = buildPromptModal();
  /** 已对哪些 id 发起过缩略图加载(避免重复请求)。 */
  const thumbLoaded = new Set<string>();

  // ── 过滤 + 排序 ──
  function filteredSorted(): ScoreMeta[] {
    let list = state.metas.filter(s =>
      !state.query || (s.title || '').toLowerCase().includes(state.query.toLowerCase()));
    if (state.sort === 'recent') list.sort((a, b) => b.updatedAt - a.updatedAt);
    else if (state.sort === 'title') list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
    else if (state.sort === 'bars') list.sort((a, b) => b.totalMeasures - a.totalMeasures);
    return list;
  }

  // ── 渲染 ──
  // 渲染分两层:
  //   render()      —— 重建整体骨架(标题/工具栏/搜索框/分段/列表容器)。仅在首次、
  //                    view/sort 切换、或库结构变化时调用。重建会销毁搜索框 → 打断 IME,
  //                    故搜索 input 事件绝不能走 render()。
  //   renderList()  —— 只换列表区(.lib-content 内的网格/空状态),不动顶部工具栏,
  //                    搜索输入态下用它刷新,保证输入框不被重建、IME 不被打断。
  function render(): void {
    // 选中项归位(可能因过滤而失配)。
    const list = filteredSorted();
    if (state.selectedId && !list.some(s => s.id === state.selectedId)) state.selectedId = null;
    if (!state.selectedId && list.length > 0) state.selectedId = list[0].id;

    const sortBtn = (key: string, label: string) =>
      `<button class="${state.sort === key ? 'active' : ''}" data-sort="${key}">${label}</button>`;

    host.innerHTML = `
      <div class="lib">
        <div class="lib-top">
          <div class="lib-title">
            <h1>曲谱库 <span class="count">${state.metas.length}</span></h1>
            <p>选一首进入编辑 · 卡片上的缩略图是该曲前两小节</p>
          </div>
          <div class="lib-toolbar">
            <div class="lib-search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
              <input type="text" placeholder="搜索曲谱…" value="${state.query.replace(/"/g, '&quot;')}" />
            </div>
            <div class="lib-seg" data-seg="sort">
              ${sortBtn('recent', '最近')}
              ${sortBtn('title', '标题')}
              ${sortBtn('bars', '小节')}
            </div>
            <div class="lib-seg" data-seg="view">
              <button class="${state.view === 'grid' ? 'active' : ''}" data-view="grid">${ICON.grid}<span>网格</span></button>
              <button class="${state.view === 'list' ? 'active' : ''}" data-view="list">${ICON.list}<span>列表</span></button>
            </div>
            <button class="lib-new" data-action="new">${ICON.plus}<span>新建曲谱</span></button>
          </div>
        </div>
        <div class="lib-content"></div>
      </div>
    `;

    bindTopEvents();
    renderList();

    // 滚动选中卡到可见区(键盘导航后)
    if (state.selectedId) {
      const card = host.querySelector(`.score-card[data-id="${state.selectedId}"]`) as HTMLElement | null;
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /** 只重建列表区(网格 / 空状态),不动顶部工具栏与搜索框。
   *  搜索输入、缩略图到达、选中变化都用它刷新,避免重建 input 打断 IME。 */
  function renderList(): void {
    const content = host.querySelector('.lib-content') as HTMLElement | null;
    if (!content) return;
    content.innerHTML = '';

    const list = filteredSorted();
    // 选中项归位。
    if (state.selectedId && !list.some(s => s.id === state.selectedId)) state.selectedId = null;
    if (!state.selectedId && list.length > 0) state.selectedId = list[0].id;

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lib-empty';
      if (state.metas.length === 0) {
        empty.innerHTML = `
          <div class="big">${ICON.note}</div>
          <h2>曲谱库还是空的</h2>
          <p>新建第一首曲谱开始创作</p>
          <button class="lib-new" data-action="new">${ICON.plus}<span>新建曲谱</span></button>
        `;
      } else {
        empty.innerHTML = `
          <div class="big">${ICON.note}</div>
          没有匹配「${escapeHtml(state.query)}」的曲谱
        `;
      }
      content.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'lib-grid' + (state.view === 'list' ? ' list' : '');
      for (const s of list) {
        grid.appendChild(buildCard(s));
      }
      // 新建占位卡(仅网格视图、且无搜索时显示)。
      // 注意:不要给占位卡加 data-action="new",否则会被工具栏的 [data-action="new"]
      // 选择器和卡片的 .new-card 分支各绑一次,导致新建两遍。占位卡只走卡片分支。
      if (state.view === 'grid' && !state.query) {
        const nc = document.createElement('div');
        nc.className = 'score-card new-card';
        nc.tabIndex = 0;
        nc.innerHTML = `<div class="new-card-inner"><div class="plus">${ICON.plusBig}</div><div>新建曲谱</div></div>`;
        grid.appendChild(nc);
      }
      content.appendChild(grid);
    }

    bindCardEvents();

    // 滚动选中卡到可见区(键盘导航 / 过滤后)
    if (state.selectedId) {
      const card = host.querySelector(`.score-card[data-id="${state.selectedId}"]`) as HTMLElement | null;
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /** 构单张卡片。 */
  function buildCard(meta: ScoreMeta): HTMLElement {
    const card = document.createElement('div');
    card.className = 'score-card' + (state.selectedId === meta.id ? ' selected' : '');
    card.tabIndex = 0;
    card.dataset.id = meta.id;

    const score = state.scores.get(meta.id);
    const thumb = score ? thumbSvg(score) : '';
    const thumbClass = !score ? 'loading' : (thumb ? '' : 'empty');
    // 进度点:每小节一个点,已写的填实。
    const dots = Array.from({ length: meta.totalMeasures }, () => `<span class="sc-dot"></span>`).join('');
    const filled = filledMeasureCount(score);
    // 评分等级映射(filled 是已写小节数)

    card.innerHTML = `
      <div class="sc-thumb ${thumbClass}">${thumb || ''}
        <span class="sc-bars">${meta.totalMeasures} 小节</span>
      </div>
      <div class="sc-body">
        <div class="sc-title-row">
          <span class="sc-title">${escapeHtml(meta.title || '未命名')}</span>
        </div>
        <div class="sc-badges">
          <span class="sc-badge key">${meta.key.name} 大调</span>
          <span class="sc-badge">${meta.time.num}/${meta.time.den}</span>
        </div>
        <div class="sc-meta">
          <div class="sc-fill" data-dots>${dots}</div>
          <span>${fmtTime(meta.updatedAt)}</span>
        </div>
      </div>
      <div class="sc-actions">
        <button class="sc-act" data-action="rename" title="重命名">${ICON.pencil}</button>
        <button class="sc-act" data-action="export" title="导出">${ICON.download}</button>
        <button class="sc-act danger" data-action="delete" title="删除">${ICON.trash}</button>
      </div>
    `;
    // 填实进度点
    card.querySelectorAll('.sc-dot').forEach((d, i) => { if (i < filled) d.classList.add('filled'); });
    return card;
  }

  // ── 事件 ──
  // 绑定顶部工具栏(搜索框 / 分段 / 新建按钮)。仅在 render() 重建骨架时调用一次。
  function bindTopEvents(): void {
    // 搜索:用 compositionstart/end 守卫 IME 中文输入;输入只刷新列表区(renderList),
    // 不重建搜索框本身,避免打断输入法。
    const search = host.querySelector('.lib-search input') as HTMLInputElement | null;
    if (search) {
      let composing = false;
      search.addEventListener('compositionstart', () => { composing = true; });
      search.addEventListener('compositionend', (e) => {
        composing = false;
        state.query = (e.target as HTMLInputElement).value;
        renderList();
      });
      search.addEventListener('input', (e) => {
        if (composing) return;          // 拼音上屏中,不刷新
        state.query = (e.target as HTMLInputElement).value;
        renderList();
      });
    }
    // 排序 / 视图 分段(切 view/sort 需重排结构 → 走 render,但不会发生在输入态)
    host.querySelectorAll<HTMLButtonElement>('.lib-seg button').forEach(b => {
      b.addEventListener('click', () => {
        const seg = (b.closest('.lib-seg') as HTMLElement).dataset.seg;
        if (seg === 'sort') state.sort = b.dataset.sort as Sort;
        else state.view = b.dataset.view as View;
        render();
      });
    });
    // 工具栏新建(仅匹配工具栏 .lib-new[data-action=new];占位卡已不带 data-action)
    host.querySelectorAll('[data-action="new"]').forEach(b =>
      b.addEventListener('click', (e) => { e.stopPropagation(); cb.onNew(); }));
  }

  /** 绑定卡片(普通卡 + 占位新建卡)。每次 renderList 重建列表后调用。 */
  function bindCardEvents(): void {
    host.querySelectorAll<HTMLElement>('.score-card').forEach(card => {
      if (card.classList.contains('new-card')) {
        card.addEventListener('click', () => cb.onNew());
        card.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); cb.onNew(); }
        });
        return;
      }
      const id = card.dataset.id!;
      // 点击:浮层 action 优先处理,否则进入。
      card.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
        if (act === 'rename') { e.stopPropagation(); doRename(id); return; }
        if (act === 'export') { e.stopPropagation(); cb.onExport(id); return; }
        if (act === 'delete') { e.stopPropagation(); doDelete(id); return; }
        enterScore(id, card);
      });
      card.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); enterScore(id, card); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveSelection(e.key);
        }
      });
    });
  }

  /** 进入曲谱:整库淡出上移(不再单卡缩小,避免像删除),动画后回调 onOpen。 */
  function enterScore(id: string, _card: HTMLElement): void {
    state.selectedId = id;
    const libRoot = host.querySelector('.lib') as HTMLElement | null;
    libRoot?.classList.add('lib-leaving');
    setTimeout(() => cb.onOpen(id), 240);
  }

  async function doRename(id: string): Promise<void> {
    const meta = state.metas.find(m => m.id === id);
    if (!meta) return;
    const t = await modal.promptText({
      title: '重命名曲谱',
      initial: meta.title || '',
      placeholder: '曲谱标题',
      confirmText: '保存',
    });
    if (t === null) return;
    const newTitle = t || '未命名';
    if (newTitle === meta.title) return;
    cb.onRename(id, newTitle);
  }

  async function doDelete(id: string): Promise<void> {
    const meta = state.metas.find(m => m.id === id);
    if (!meta) return;
    const ok = await modal.confirm({
      title: '删除曲谱',
      message: `删除「${meta.title || '未命名'}」?此操作不可撤销。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    cb.onDelete(id);
  }

  /** 键盘方向键移动选中(跨行估算列数;列表视图逐个)。 */
  function moveSelection(key: string): void {
    const list = filteredSorted();
    if (list.length === 0) return;
    const curIdx = state.selectedId ? list.findIndex(s => s.id === state.selectedId) : -1;
    let next = curIdx < 0 ? 0 : curIdx;
    if (key === 'ArrowRight') next = Math.min(list.length - 1, curIdx + 1);
    else if (key === 'ArrowLeft') next = Math.max(0, curIdx - 1);
    else {
      // 上下:估算列数(auto-fill minmax 280px)
      const grid = host.querySelector('.lib-grid') as HTMLElement | null;
      let cols = 1;
      if (grid && state.view === 'grid') {
        const cw = grid.clientWidth;
        cols = Math.max(1, Math.floor((cw + 18) / (280 + 18)));
      }
      const step = state.view === 'list' ? 1 : cols;
      if (key === 'ArrowDown') next = Math.min(list.length - 1, curIdx + step);
      else if (key === 'ArrowUp') next = Math.max(0, curIdx - step);
    }
    if (next === curIdx) return;
    state.selectedId = list[next].id;
    renderList();
    // 把焦点放到新选中卡(便于连续方向键)
    const card = host.querySelector(`.score-card[data-id="${state.selectedId}"]`) as HTMLElement | null;
    card?.focus();
  }

  // ── 缩略图惰性加载 ──
  /** 为所有"有 meta 但无缩略图缓存且未发起过加载"的曲谱并发拉取整曲。
   *  到达后刷新这些卡片(只换缩略图 + 进度点,不重建整个库)。 */
  function loadMissingThumbs(): void {
    const pending = state.metas.filter(m => !state.scores.has(m.id) && !thumbLoaded.has(m.id));
    if (pending.length === 0) return;
    pending.forEach(m => thumbLoaded.add(m.id));
    let arrived = 0;
    pending.forEach(m => {
      getPiece(m.id).then(score => {
        state.scores.set(m.id, score);
        arrived++;
        updateCardThumb(m.id);
      }).catch(() => {
        // 拉取失败:移除"加载中"标记,留空占位(不阻塞其它卡片)。
        thumbLoaded.delete(m.id);
        const card = host.querySelector(`.score-card[data-id="${m.id}"] .sc-thumb`) as HTMLElement | null;
        if (card) { card.classList.remove('loading'); card.classList.add('empty'); }
      });
      void arrived;
    });
  }

  /** 单张卡片缩略图到达后增量更新(不重建列表,保留 hover/焦点)。 */
  function updateCardThumb(id: string): void {
    const score = state.scores.get(id);
    const cardEl = host.querySelector(`.score-card[data-id="${id}"]`) as HTMLElement | null;
    if (!cardEl || !score) return;
    const thumb = thumbSvg(score);
    const thumbWrap = cardEl.querySelector('.sc-thumb') as HTMLElement | null;
    if (!thumbWrap) return;
    thumbWrap.classList.remove('loading');
    thumbWrap.classList.toggle('empty', !thumb);
    // 保留 .sc-bars 徽章(它在 thumb 内)
    const bars = thumbWrap.querySelector('.sc-bars');
    thumbWrap.innerHTML = thumb || '';
    if (bars) thumbWrap.appendChild(bars);
    // 更新进度点
    const filled = filledMeasureCount(score);
    cardEl.querySelectorAll('.sc-dot').forEach((d, i) => d.classList.toggle('filled', i < filled));
  }

  // ── refresh(metas 变化)──
  const refresh = (metas: ScoreMeta[]): void => {
    // 删除已不存在的缓存。
    const ids = new Set(metas.map(m => m.id));
    for (const k of Array.from(state.scores.keys())) {
      if (!ids.has(k)) state.scores.delete(k);
    }
    for (const k of Array.from(thumbLoaded)) {
      if (!ids.has(k)) thumbLoaded.delete(k);
    }
    state.metas = metas.slice();
    // 选中项若被删,清空(refresh 后若列表非空,render 会默认选第一个)。
    if (state.selectedId && !ids.has(state.selectedId)) state.selectedId = null;
    render();
    loadMissingThumbs();
  };

  // ── 全局键盘(库视图专属,编辑器激活时不响应)──
  const onKey = (e: KeyboardEvent) => {
    // 仅当库宿主可见时响应。
    if (host.hidden) return;
    const ae = document.activeElement as HTMLElement | null;
    const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA');
    // `/` 聚焦搜索(不在输入框时)
    if (e.key === '/' && !inField) {
      e.preventDefault();
      const inp = host.querySelector('.lib-search input') as HTMLInputElement | null;
      inp?.focus();
      return;
    }
    // 搜索框内:Esc 清空搜索(只刷列表区,保留 input 不重建)
    if (inField && e.key === 'Escape') {
      const inp = host.querySelector('.lib-search input') as HTMLInputElement | null;
      if (inp && inp.value) {
        inp.value = '';
        state.query = '';
        renderList();
        inp.focus();
      } else {
        (ae as HTMLElement).blur();
      }
      return;
    }
    if (inField) return;
    // 方向键 / Enter:仅当焦点在卡片或库宿主内时由卡片自身 keydown 处理;
    // 这里兜底:无焦点时按方向键也能移动。
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 若焦点已在某卡片上,卡片的 keydown 已处理并 preventDefault;这里不再重复。
      if (ae && ae.classList && ae.classList.contains('score-card')) return;
      e.preventDefault();
      moveSelection(e.key);
    } else if (e.key === 'Enter' && state.selectedId) {
      if (ae && ae.classList && ae.classList.contains('score-card')) return; // 卡片自处理
      e.preventDefault();
      const card = host.querySelector(`.score-card[data-id="${state.selectedId}"]`) as HTMLElement | null;
      if (card) {
        if (card.classList.contains('new-card')) cb.onNew();
        else enterScore(state.selectedId, card);
      }
    }
  };
  window.addEventListener('keydown', onKey);

  // 初次渲染 + 拉缩略图
  render();
  loadMissingThumbs();

  return { el: host, refresh };
}

// ── HTML 转义(标题来自用户输入)──
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}
