// 曲谱库 demo —— mock 数据 + 复用项目真实渲染生成缩略图。
// 目的:展示一个不同于"下拉+书签"的曲谱管理形态(全屏曲谱库视图,卡片即入口)。
// 入口:library-demo.html

import { computeLayout } from './render/layout';
import { buildSVG } from './render/export';
import { ensureFontLoaded } from './render/glyphs';
import { KEYS } from './core/theory';
import { KeyName, Note, Piece, TimeSig } from './core/types';
import { appendNote, popNote, noteStartBeats } from './core/model';
import { clickYToMidi } from './render/staff';
import { renderJianpuSVG } from './render/jianpu';
import { buildMeasureSelector, MeasureSelectorHandle } from './ui/measure-selector';

// ── mock 曲谱数据(模拟从服务端读到的多首曲子) ──
interface MockScore {
  id: string; title: string; key: KeyName; time: TimeSig; totalMeasures: number;
  updatedAt: number; treble: Note[]; bass?: Note[];
}
const n = (midi: number | null, duration: Note['duration'], dotted = false, extra: Partial<Note> = {}): Note =>
  ({ midi, duration, dotted, accidental: null, ...extra });
const makePiece = (key: KeyName, time: TimeSig, measureCount: number, treble: Note[]): Piece => ({
  clef: 'treble', key: KEYS[key], time, measureCount, notes: treble, treble, bass: [],
});

const SCORES: MockScore[] = [
  { id: 's1', title: '小星星', key: 'C', time: { num: 4, den: 4 }, totalMeasures: 4, updatedAt: Date.now() - 1000*60*5,
    treble: [n(60,'quarter'),n(60,'quarter'),n(67,'quarter'),n(67,'quarter'), n(69,'quarter'),n(69,'quarter'),n(67,'half'), n(65,'quarter'),n(65,'quarter'),n(64,'quarter'),n(64,'quarter'), n(62,'quarter'),n(62,'quarter'),n(60,'half')] },
  { id: 's2', title: '欢乐颂', key: 'C', time: { num: 4, den: 4 }, totalMeasures: 6, updatedAt: Date.now() - 1000*60*60*3,
    treble: [n(64,'quarter'),n(64,'quarter'),n(65,'quarter'),n(66,'quarter'), n(66,'quarter'),n(65,'quarter'),n(64,'quarter'),n(62,'quarter'), n(60,'quarter'),n(60,'quarter'),n(62,'quarter'),n(64,'quarter'), n(64,'quarter',true),n(62,'quarter'),n(62,'half')] },
  { id: 's3', title: 'G 大调练习', key: 'G', time: { num: 3, den: 4 }, totalMeasures: 8, updatedAt: Date.now() - 1000*60*60*24,
    treble: [n(67,'quarter'),n(69,'eighth'),n(71,'eighth'),n(74,'half'), n(71,'quarter'),n(69,'quarter'),n(67,'quarter')], bass: [n(43,'half'),n(43,'quarter'),n(38,'half'),n(38,'quarter')] },
  { id: 's4', title: '生日快乐', key: 'F', time: { num: 3, den: 4 }, totalMeasures: 4, updatedAt: Date.now() - 1000*60*60*24*3,
    treble: [n(65,'eighth'),n(65,'quarter'),n(65,'eighth'),n(65,'half'), n(65,'eighth'),n(69,'quarter'),n(65,'half'), n(74,'quarter'),n(72,'half')] },
  { id: 's5', title: '未命名草稿', key: 'C', time: { num: 4, den: 4 }, totalMeasures: 4, updatedAt: Date.now() - 1000*60*60*24*7,
    treble: [n(60,'quarter'),n(64,'quarter'),n(67,'quarter')] },
  { id: 's6', title: 'F 大调卡农片段', key: 'F', time: { num: 4, den: 4 }, totalMeasures: 4, updatedAt: Date.now() - 1000*60*60*24*14,
    treble: [n(65,'quarter'),n(69,'quarter'),n(72,'quarter'),n(77,'quarter'), n(72,'quarter'),n(69,'quarter'),n(65,'quarter'),n(60,'quarter')], bass: [n(41,'half'),n(45,'half'),n(48,'half'),n(53,'half')] },
];

// ── 生成缩略图 SVG:用前 2 小节构 piece,buildSVG 渲染,裁掉简谱区只留五线谱 ──
function thumbSvg(score: MockScore): string {
  if (score.treble.length === 0 && (!score.bass || score.bass.length === 0)) return '';
  const thumbMeasures = Math.min(2, score.totalMeasures);
  const piece = makePiece(score.key, score.time, thumbMeasures, score.treble.slice(0, 12));
  const layout = computeLayout(piece, 560, 'quarter');
  let svg = buildSVG(piece, layout, -1, { hover: null });
  // 只保留五线谱部分(裁掉简谱 group):用 viewBox 限制高度到 jianpuTop
  const vby = -layout.viewBoxYOffset;
  const staffH = layout.jianpuTop - vby + 8;
  svg = svg.replace(
    /viewBox="([^"]*)"/,
    `viewBox="${vby} ${vby} ${layout.width} ${staffH}"`,
  );
  return svg;
}

/** 把单个小节的音符构造成 1 小节 piece → 渲染五线谱缩略图(用于小节条方块)。
 *  beatInBar < bpb 的音属于该小节。空小节返回空串。用 noteStartBeats 精确归属。 */
function measureThumb(score: MockScore, measureIdx0: number): { svg: string; empty: boolean } {
  const bpb = (score.time.num * 4) / score.time.den;
  const fullPiece = makePiece(score.key, score.time, score.totalMeasures, score.treble);
  const starts = noteStartBeats(fullPiece);
  const lo = measureIdx0 * bpb, hi = (measureIdx0 + 1) * bpb;
  const inMeasure: Note[] = [];
  for (let i = 0; i < score.treble.length; i++) {
    if (starts[i] + 1e-6 >= lo && starts[i] < hi - 1e-6) inMeasure.push(score.treble[i]);
  }
  if (inMeasure.length === 0) return { svg: '', empty: true };
  const piece = makePiece(score.key, score.time, 1, inMeasure);
  const layout = computeLayout(piece, 240, 'quarter');
  let svg = buildSVG(piece, layout, -1, { hover: null });
  const vby = -layout.viewBoxYOffset;
  const staffH = layout.jianpuTop - vby + 8;
  svg = svg.replace(/viewBox="([^"]*)"/, `viewBox="${vby} ${vby} ${layout.width} ${staffH}"`);
  return { svg, empty: false };
}

// ── 渲染状态 ──
const state = {
  mode: 'library' as 'library' | 'score',   // library=曲谱库; score=进入某曲子
  openId: null as string | null,              // score 模式下打开的曲子
  startMeasure: 0,                            // score 模式:编辑区起始小节(0-based)
  measuresPerLine: 2,                         // 编辑区一次显示几小节
  // library 模式专用:
  view: 'grid' as 'grid' | 'list',
  sort: 'recent' as 'recent' | 'title' | 'bars',
  query: '',
  selectedId: null as string | null,
  scores: SCORES.slice(),
};
let searchFocus = false;

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

function filteredSorted(): MockScore[] {
  let list = state.scores.filter(s => !state.query || s.title.toLowerCase().includes(state.query.toLowerCase()));
  if (state.sort === 'recent') list.sort((a, b) => b.updatedAt - a.updatedAt);
  else if (state.sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  else if (state.sort === 'bars') list.sort((a, b) => b.totalMeasures - a.totalMeasures);
  return list;
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) return;
  if (state.mode === 'score' && state.openId) {
    renderScoreView(app);
    return;
  }
  renderLibrary(app);
}

/** 二级编辑页:顶部曲子信息条 + 工具盘 + 小节缩略图条 + 可点击编辑的五线谱+简谱。 */
function renderScoreView(app: HTMLElement): void {
  const score = state.scores.find(s => s.id === state.openId);
  if (!score) { state.mode = 'library'; renderLibrary(app); return; }
  const total = score.totalMeasures;
  const start = Math.max(0, Math.min(state.startMeasure, total - 1));
  state.startMeasure = start;
  const count = Math.min(edit.measuresPerLine, total - start);
  const end = start + count;

  const view = rangeToPieceView(score, start, count);
  if (!view) { state.mode = 'library'; renderLibrary(app); return; }
  const { staff, jp } = renderEditParts(view.piece, view.layout);

  const root = document.createElement('div');
  root.className = 'lib score-view';
  root.innerHTML = `
    <!-- 应用顶栏:左(返回) · 中(曲名+属性 + 视图模式) · 右(预览) -->
    <div class="appbar">
      <div class="appbar-left">
        <button class="appbar-back" title="返回曲谱库">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          曲谱库
        </button>
      </div>
      <div class="appbar-center">
        <span class="appbar-name" contenteditable="true" spellcheck="false" title="点此改名">${score.title}</span>
        <span class="appbar-badge key">${score.key}</span>
        <span class="appbar-badge">${score.time.num}/${score.time.den}</span>
        <div class="appbar-view" data-role="viewmode">
          <button class="appbar-vbtn ${edit.viewMode === 'treble' ? 'active' : ''}" data-view="treble" title="高音谱表">𝄞</button>
          <button class="appbar-vbtn ${edit.viewMode === 'bass' ? 'active' : ''}" data-view="bass" title="低音谱表">𝄢</button>
          <button class="appbar-vbtn ${edit.viewMode === 'grand' ? 'active' : ''}" data-view="grand" title="高低音双谱表">𝄞𝄢</button>
          <button class="appbar-vbtn ${edit.viewMode === 'preview' ? 'active' : ''}" data-view="preview" title="整曲预览">♪</button>
        </div>
      </div>
      <div class="appbar-right">
        <button class="appbar-preview" data-act="preview" title="整曲预览">👁 预览</button>
      </div>
    </div>

    <!-- 大气工具盘(三行分区):
         ① 输入修饰(时值/附点/和音/连音/休止/连音组/临时记号)
         ② 曲子属性(调号/拍号) + 编辑动作(退格/清空)
         ③ 小节导航(数字方块 + 可拖拽吸附选择框) -->
    <div class="sv-tools">
      <div class="sv-tools-row">
        <div class="sv-cell">
          <span class="sv-tlabel">时值</span>
          <div class="sv-tool-group">
            ${DURATIONS.map(d => `<button class="sv-dur ${edit.duration === d.v ? 'active' : ''}" data-dur="${d.v}" title="${d.v} (${DURATIONS.indexOf(d)+1})">${d.label}</button>`).join('')}
          </div>
          <button class="sv-toggle ${edit.dotted ? 'active' : ''}" data-act="dotted" title="附点 (.)">附点</button>
        </div>
        <div class="sv-cell">
          <span class="sv-tlabel">修饰</span>
          <button class="sv-toggle ${edit.chord ? 'active' : ''}" data-act="chord" title="和音模式 (c)">和音</button>
          <button class="sv-toggle ${edit.tuplet ? 'active' : ''}" data-act="tuplet" title="三连音 (r)">3连</button>
          <button class="sv-action" data-act="tie" title="连音线 (t)">连音</button>
          <button class="sv-action" data-act="rest" title="追加休止符 (0)">休止</button>
        </div>
        <div class="sv-cell">
          <span class="sv-tlabel">临时</span>
          <div class="sv-tool-group">
            <button class="sv-acc ${edit.accidental === null ? 'active' : ''}" data-acc="null" title="无临时记号">♮</button>
            <button class="sv-acc ${edit.accidental === 'sharp' ? 'active' : ''}" data-acc="sharp" title="升">♯</button>
            <button class="sv-acc ${edit.accidental === 'flat' ? 'active' : ''}" data-acc="flat" title="降">♭</button>
          </div>
        </div>
      </div>
      <div class="sv-tools-row">
        <div class="sv-cell">
          <span class="sv-tlabel">调号</span>
          <select class="sv-select" data-act="key">${KEYS_LIST.map(k => `<option ${k === score.key ? 'selected' : ''}>${k}</option>`).join('')}</select>
        </div>
        <div class="sv-cell">
          <span class="sv-tlabel">拍号</span>
          <select class="sv-select" data-act="time">${[[4,4],[3,4],[2,4],[6,8],[3,8]].map(([n,d]) => `<option ${n===score.time.num&&d===score.time.den?'selected':''} value="${n}/${d}">${n}/${d}</option>`).join('')}</select>
        </div>
        <div class="sv-cell" style="margin-left:auto">
          <button class="sv-ghost" data-act="undo" title="退格删除最后一个音 (Backspace)">⌫ 退格</button>
          <button class="sv-ghost danger" data-act="clear" title="清空当前范围">清空</button>
        </div>
      </div>
      <div class="sv-tools-row sv-tools-measures">
        <span class="sv-tlabel">小节</span>
        <span class="sv-range-hint">第 <b>${start + 1}–${end}</b> 小节</span>
        <div class="sv-measures-host" data-role="measure-selector"></div>
      </div>
    </div>

    <!-- 可点击编辑的五线谱 + 简谱翻译区 -->
    <div class="sv-edit">
      <div class="sv-edit-label">点五线谱放音(短信验证码式:往右追加,退格删尾)</div>
      <div class="sv-staff-host" data-role="staff">${staff}</div>
      <div class="sv-jp-host" data-role="jianpu">${jp}</div>
    </div>

    <div class="lib-hint">二级编辑页 v2:① <b>数字方块小节条</b>(有内容的加圆点)替代了之前看不清的小五线谱;② <b>可拖拽吸附选择框</b>——拖框体=移编辑区起点,拖左/右边缘=改框宽=改每行小节数(替代了"每行小节数"下拉);③ <b>工具盘补全</b>:时值/附点/和音/连音/休止/三连/临时记号 + 调号/拍号/退格/清空,分两行排版不挤。</div>
  `;
  app.innerHTML = '';
  app.appendChild(root);

  // 填充小节内容指示点:该小节有音 → 加圆点
  root.querySelectorAll<HTMLElement>('.sv-m[data-m]').forEach(el => {
    const idx = parseInt(el.dataset.m!, 10);
    const t = measureThumb(score, idx);
    if (!t.empty) el.classList.add('has-content');
  });

  bindScoreEvents(root, score, view);
}

/** 当前范围的实时视图(供 bindScoreEvents 在编辑后重渲染五线谱+简谱)。 */
function reRenderStaff(root: HTMLElement, score: MockScore): void {
  const start = state.startMeasure;
  const count = Math.min(edit.measuresPerLine, score.totalMeasures - start);
  const view = rangeToPieceView(score, start, count);
  if (!view) return;
  const { staff, jp } = renderEditParts(view.piece, view.layout);
  const sh = root.querySelector('[data-role="staff"]') as HTMLElement;
  const jh = root.querySelector('[data-role="jianpu"]') as HTMLElement;
  if (sh) sh.innerHTML = staff;
  if (jh) jh.innerHTML = jp;
}

/** 把曲子的某范围(第 start 小节起的 count 小节)切成一个可编辑的 piece 视图。
 *  用 noteStartBeats 精确归属音到小节(复刻主应用 rangeToPiece)。 */
function rangeToPieceView(score: MockScore, start: number, count: number): { piece: Piece; layout: ReturnType<typeof computeLayout> } | null {
  const bpb = (score.time.num * 4) / score.time.den;
  const fullPiece = makePiece(score.key, score.time, score.totalMeasures, score.treble);
  const starts = noteStartBeats(fullPiece);
  const lo = start * bpb, hi = (start + count) * bpb;
  const notes: Note[] = [];
  for (let i = 0; i < score.treble.length; i++) {
    if (starts[i] + 1e-6 >= lo && starts[i] < hi - 1e-6) notes.push(score.treble[i]);
  }
  const realCount = Math.max(1, Math.min(count, score.totalMeasures - start));
  const piece: Piece = { clef: 'treble', key: KEYS[score.key], time: score.time, measureCount: realCount, notes, treble: notes, bass: [] };
  const layout = computeLayout(piece, 1060, 'quarter');
  return { piece, layout };
}

/** 渲染编辑区:五线谱(staff)+ 简谱(jianpu)分两段。返回 { staff, jp }。 */
function renderEditParts(piece: Piece, layout: ReturnType<typeof computeLayout>): { staff: string; jp: string } {
  const staffFull = buildSVG(piece, layout, -1, { hover: null });
  const jpInner = renderJianpuSVG({ piece, layout, playingIndex: -1, hover: null });
  const vby = -layout.viewBoxYOffset;
  const staffH = layout.jianpuTop - vby;
  const jpH = (layout.jianpuBottom - layout.jianpuTop) + 6;
  const staff = staffFull.replace(/viewBox="([^"]*)"/, `viewBox="${vby} ${vby} ${layout.width} ${staffH}"`);
  const jp = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${layout.jianpuTop} ${layout.width} ${jpH}" width="${layout.width}" height="${jpH}">${jpInner}</svg>`;
  return { staff, jp };
}

/** 点击坐标 → svg 内部坐标(y 含 viewBoxYOffset 偏移)。复刻主应用 toSvgCoords。 */
function clientToSvgY(e: MouseEvent, svg: SVGSVGElement, layout: ReturnType<typeof computeLayout>): number {
  const rect = svg.getBoundingClientRect();
  const vby = -layout.viewBoxYOffset;
  return ((e.clientY - rect.top) / rect.height) * layout.height + vby;
}

// ── 编辑器状态(二级页)──
const edit = {
  duration: 'quarter' as Note['duration'],
  dotted: false,
  accidental: null as Note['accidental'],
  measuresPerLine: 2,
  chord: false,        // 和音模式
  tuplet: false,       // 三连音模式(demo 简化:只三连)
  viewMode: 'treble' as 'treble' | 'bass' | 'grand' | 'preview',
};

const DURATIONS: { v: Note['duration']; label: string }[] = [
  { v: 'whole', label: '𝅝' }, { v: 'half', label: '𝅗𝅥' }, { v: 'quarter', label: '𝅘𝅥' },
  { v: 'eighth', label: '♪' }, { v: 'sixteenth', label: '𝅘𝅥𝅯' }, { v: 'thirtysecond', label: '𝅘𝅥𝅰' },
];
/** 当前 MeasureSelector 句柄(renderScoreView 挂载,其它处 refresh)。 */
let msHandle: MeasureSelectorHandle | null = null;
const KEYS_LIST: KeyName[] = ['C', 'G', 'D', 'A', 'E', 'F', 'Bb', 'Eb', 'Ab', 'F#'];

/** 把编辑器范围视图里新增/删除的音,回写到 score.treble。
 *  简化:编辑发生在范围 piece 上,回写时按全局拍重排(范围以外的音保留)。 */
function commitRangeToScore(score: MockScore, viewPiece: Piece, start: number): void {
  const bpb = (score.time.num * 4) / score.time.den;
  const fullPiece = makePiece(score.key, score.time, score.totalMeasures, score.treble);
  const oldStarts = noteStartBeats(fullPiece);
  const lo = start * bpb, hi = (start + viewPiece.measureCount) * bpb;
  // 范围外的音(起始拍 < lo 或 >= hi)保留;范围内的音替换为 viewPiece 的音(它们的拍重新算)。
  const before = score.treble.filter((_, i) => oldStarts[i] < lo - 1e-6);
  const after = score.treble.filter((_, i) => oldStarts[i] >= hi - 1e-6);
  score.treble = [...before, ...viewPiece.notes, ...after];
  score.updatedAt = Date.now();
}

function bindScoreEvents(root: HTMLElement, score: MockScore, view: { piece: Piece; layout: ReturnType<typeof computeLayout> }): void {
  const total = () => score.totalMeasures;
  // 返回库
  root.querySelector('.appbar-back')?.addEventListener('click', () => {
    window.dispatchEvent(new Event('__lib-leave-score'));
    state.mode = 'library'; state.openId = null; render();
  });
  // 视图模式切换(高音/低音/双谱/预览)
  root.querySelectorAll<HTMLElement>('.appbar-vbtn').forEach(b => b.addEventListener('click', () => {
    edit.viewMode = b.dataset.view as typeof edit.viewMode;
    if (edit.viewMode === 'preview') { alert('→ 整曲预览(demo,主应用已有)'); return; }
    render();
  }));
  // ── 挂载 MeasureSelector 组件 ──
  const msHost = root.querySelector('[data-role="measure-selector"]') as HTMLElement;
  msHandle = buildMeasureSelector(
    { totalMeasures: score.totalMeasures, start: state.startMeasure, count: edit.measuresPerLine, hasContent: measureHasContent(score) },
    {
      onChange: (start, count) => {
        state.startMeasure = start; edit.measuresPerLine = count;
        const hint = root.querySelector('.sv-range-hint');
        if (hint) hint.innerHTML = `第 <b>${start + 1}–${start + count}</b> 小节`;
        // ★ 不调 render()(会重建组件、丢失抬手吸附动画)。只重渲五线谱编辑区(范围变了)。
        reRenderStaff(root, score);
      },
      onDeleteMeasure: (idx) => {
        if (score.totalMeasures <= 1) { flash(root, '至少保留 1 小节'); return; }
        if (!confirm(`删除第 ${idx + 1} 小节?后续小节前移。`)) return;
        // 用 noteStartBeats 精确删该小节的音。
        const fullPiece = makePiece(score.key, score.time, score.totalMeasures, score.treble);
        const starts = noteStartBeats(fullPiece);
        const bpb = (score.time.num * 4) / score.time.den;
        const lo = idx * bpb, hi = (idx + 1) * bpb;
        score.treble = score.treble.filter((_, i) => !(starts[i] + 1e-6 >= lo && starts[i] < hi - 1e-6));
        score.totalMeasures -= 1;
        // Bug C:删除后 start/count clamp 到新 totalMeasures(组件 refresh 内也会 clamp,这里双保险)。
        state.startMeasure = Math.min(state.startMeasure, score.totalMeasures - 1);
        edit.measuresPerLine = Math.min(edit.measuresPerLine, score.totalMeasures - state.startMeasure);
        score.updatedAt = Date.now();
        reRenderStaff(root, score);   // 五线谱区重渲(范围变了)
        refreshMs(score);             // MeasureSelector 增量更新(保留实例 + 横滑 + 动画)
      },
      onAddMeasure: () => {
        if (score.totalMeasures >= 256) return;
        score.totalMeasures += 1; score.updatedAt = Date.now();
        reRenderStaff(root, score);
        refreshMs(score);   // 新书签带进场动画
      },
    },
  );
  msHost.appendChild(msHandle.el);
  // 暴露句柄到 window(仅 demo,供自动化测试精确 setSelection/refresh,不影响生产行为)。
  (window as unknown as { __ms?: unknown }).__ms = msHandle;
  // 曲名改名
  const nameEl = root.querySelector('.appbar-name') as HTMLElement | null;
  nameEl?.addEventListener('blur', () => { score.title = (nameEl.textContent || '').trim() || '未命名'; score.updatedAt = Date.now(); });
  nameEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

  // ── 工具盘 ──
  root.querySelectorAll<HTMLElement>('[data-dur]').forEach(b => b.addEventListener('click', () => {
    edit.duration = b.dataset.dur as Note['duration']; root.querySelectorAll('[data-dur]').forEach(x => x.classList.remove('active')); b.classList.add('active');
  }));
  root.querySelector('[data-act="dotted"]')?.addEventListener('click', (e) => {
    edit.dotted = !edit.dotted; (e.currentTarget as HTMLElement).classList.toggle('active', edit.dotted);
  });
  root.querySelector('[data-act="chord"]')?.addEventListener('click', (e) => {
    edit.chord = !edit.chord; (e.currentTarget as HTMLElement).classList.toggle('active', edit.chord);
  });
  root.querySelector('[data-act="tuplet"]')?.addEventListener('click', (e) => {
    edit.tuplet = !edit.tuplet; (e.currentTarget as HTMLElement).classList.toggle('active', edit.tuplet);
  });
  root.querySelector('[data-act="tie"]')?.addEventListener('click', () => {
    // 连音:复制末尾音(同音高+同时值)追加并自动连音(demo 简化)
    const last = view.piece.notes[view.piece.notes.length - 1];
    if (!last || last.midi === null) { flash(root, '无音可连'); return; }
    const dup: Note = { ...last, tieEnd: true, tieStart: undefined };
    last.tieStart = true;
    if (appendNote(view.piece, dup)) { commitRangeToScore(score, view.piece, state.startMeasure); reRenderStaff(root, score); refreshMs(score); }
  });
  root.querySelector('[data-act="rest"]')?.addEventListener('click', () => {
    const note: Note = { midi: null, duration: edit.duration, dotted: edit.dotted, accidental: null };
    if (appendNote(view.piece, note)) { commitRangeToScore(score, view.piece, state.startMeasure); reRenderStaff(root, score); refreshMs(score); }
  });
  root.querySelectorAll<HTMLElement>('[data-acc]').forEach(b => b.addEventListener('click', () => {
    edit.accidental = (b.dataset.acc === 'null' ? null : b.dataset.acc) as Note['accidental'];
    root.querySelectorAll('[data-acc]').forEach(x => x.classList.remove('active')); b.classList.add('active');
  }));
  root.querySelector<HTMLElement>('[data-act="key"]')?.addEventListener('change', (e) => {
    score.key = (e.target as HTMLSelectElement).value as KeyName; score.updatedAt = Date.now(); render();
  });
  root.querySelector<HTMLElement>('[data-act="time"]')?.addEventListener('change', (e) => {
    const [num, den] = (e.target as HTMLSelectElement).value.split('/').map(Number);
    score.time = { num, den }; score.updatedAt = Date.now(); render();
  });
  // 退格:删当前范围最后一个音
  root.querySelector('[data-act="undo"]')?.addEventListener('click', () => {
    const v = rangeToPieceView(score, state.startMeasure, Math.min(edit.measuresPerLine, score.totalMeasures - state.startMeasure));
    if (v && popNote(v.piece)) { commitRangeToScore(score, v.piece, state.startMeasure); reRenderStaff(root, score); refreshMs(score); }
  });
  // 清空当前范围
  root.querySelector('[data-act="clear"]')?.addEventListener('click', () => {
    const v = rangeToPieceView(score, state.startMeasure, Math.min(edit.measuresPerLine, score.totalMeasures - state.startMeasure));
    if (v) { v.piece.notes = []; v.piece.treble = []; commitRangeToScore(score, v.piece, state.startMeasure); reRenderStaff(root, score); refreshMs(score); }
  });

  // ── 五线谱点击放音(复刻主应用:clickYToMidi → appendNote,含和音/三连)──
  const staffHost = root.querySelector('[data-role="staff"]') as HTMLElement | null;
  let downMidi: number | null = null;
  let chordId = 0;
  if (staffHost) {
    staffHost.addEventListener('mousedown', (e: MouseEvent) => {
      const svg = staffHost.querySelector('svg');
      if (!svg) return;
      downMidi = clickYToMidi(clientToSvgY(e, svg as SVGSVGElement, view.layout), view.piece, view.layout);
    });
    staffHost.addEventListener('click', () => {
      if (downMidi === null) return;
      const midi = downMidi; downMidi = null;
      const tuplet = edit.tuplet ? { actual: 3, normal: 2, groupId: 'tup' + Date.now() } : undefined;
      const note: Note = { midi, duration: edit.duration, dotted: edit.dotted, accidental: edit.accidental, tuplet };
      if (edit.chord) {
        const last = view.piece.notes[view.piece.notes.length - 1];
        if (last && last.chordId === 'chord' + chordId) note.chordId = 'chord' + chordId;
        else { chordId++; note.chordId = 'chord' + chordId; }
      }
      const ok = appendNote(view.piece, note);
      if (!ok) { flash(root, '小节满了'); return; }
      commitRangeToScore(score, view.piece, state.startMeasure);
      reRenderStaff(root, score);
      refreshMs(score);
      void previewNote(midi);
    });
  }
  // 预览
  root.querySelector('[data-act="preview"]')?.addEventListener('click', () => alert('→ 整曲预览(demo,主应用已有)'));

  // MeasureSelector 已在上方挂载(此处无需旧 bindSelector)。

  // 键盘快捷键(全局,仅 score 模式生效)
  const onKey = (e: KeyboardEvent) => {
    if (state.mode !== 'score') return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ['INPUT', 'SELECT', 'TEXTAREA'].includes(ae.tagName)) return;
    if (ae && ae.isContentEditable) return;
    if (e.key === 'Backspace') { e.preventDefault(); root.querySelector<HTMLElement>('[data-act="undo"]')?.click(); }
    else if (e.key >= '1' && e.key <= '6') { const d = DURATIONS[parseInt(e.key, 10) - 1]; if (d) root.querySelector<HTMLElement>(`[data-dur="${d.v}"]`)?.click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); state.startMeasure = Math.max(0, state.startMeasure - 1); render(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); state.startMeasure = Math.min(total() - 1, state.startMeasure + 1); render(); }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('__lib-leave-score', () => window.removeEventListener('keydown', onKey), { once: true });
}


/** 刷新 MeasureSelector 组件(编辑后内容指示 + total 变化)。 */
function refreshMs(score: MockScore): void {
  msHandle?.refresh({ totalMeasures: score.totalMeasures, start: state.startMeasure, count: edit.measuresPerLine, hasContent: measureHasContent(score) });
}

/** 算每小节是否有内容(供 MeasureSelector 显示指示点)。 */
function measureHasContent(score: MockScore): boolean[] {
  const fullPiece = makePiece(score.key, score.time, score.totalMeasures, score.treble);
  const starts = noteStartBeats(fullPiece);
  const bpb = (score.time.num * 4) / score.time.den;
  const out: boolean[] = new Array(score.totalMeasures).fill(false);
  for (let i = 0; i < score.treble.length; i++) {
    const m = Math.floor(starts[i] / bpb);
    if (m >= 0 && m < out.length) out[m] = true;
  }
  return out;
}

/** 简单试听(WebAudio 单音)。 */
let audioCtx: AudioContext | null = null;
function previewNote(midi: number): void {
  try {
    audioCtx = audioCtx || new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    o.frequency.value = freq; o.type = 'triangle';
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.42);
  } catch { /* ignore */ }
}

/** 闪现提示。 */
function flash(root: HTMLElement, msg: string): void {
  const t = document.createElement('div');
  t.className = 'sv-flash'; t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => t.remove(), 1200);
}

/** 曲谱库视图(原 render 主体)。 */
function renderLibrary(app: HTMLElement): void {
  const list = filteredSorted();

  const sortBtn = (key: string, label: string) => `<button class="${state.sort === key ? 'active' : ''}" data-sort="${key}">${label}</button>`;
  const root = document.createElement('div');
  root.className = 'lib';
  root.innerHTML = `
    <div class="lib-top">
      <div class="lib-title">
        <h1>曲谱库 <span class="count">${state.scores.length}</span></h1>
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
          <button class="${state.view === 'grid' ? 'active' : ''}" data-view="grid">▦ 网格</button>
          <button class="${state.view === 'list' ? 'active' : ''}" data-view="list">☰ 列表</button>
        </div>
        <button class="lib-new" data-action="new">＋ 新建曲谱</button>
      </div>
    </div>
    ${list.length === 0 ? `<div class="lib-empty"><div class="big">🎵</div>没有匹配「${state.query}」的曲谱</div>` : ''}
  `;

  const grid = document.createElement('div');
  grid.className = 'lib-grid' + (state.view === 'list' ? ' list' : '');

  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'score-card' + (state.selectedId === s.id ? ' selected' : '');
    card.tabIndex = 0;
    card.dataset.id = s.id;
    const thumb = thumbSvg(s);
    const dots = Array.from({ length: s.totalMeasures }, () => `<span class="sc-dot"></span>`).join('');
    card.innerHTML = `
      <div class="sc-thumb ${thumb ? '' : 'empty'}">${thumb || ''}
        <span class="sc-bars">${s.totalMeasures} 小节</span>
      </div>
      <div class="sc-body">
        <div class="sc-title-row">
          <span class="sc-title">${s.title}</span>
        </div>
        <div class="sc-badges">
          <span class="sc-badge key">${s.key} 大调</span>
          <span class="sc-badge">${s.time.num}/${s.time.den}</span>
        </div>
        <div class="sc-meta">
          <div class="sc-fill" data-dots>${dots}</div>
          <span>${fmtTime(s.updatedAt)}</span>
        </div>
      </div>
      <div class="sc-actions">
        <button class="sc-act" data-action="rename" title="重命名">✎</button>
        <button class="sc-act" data-action="export" title="导出">⬇</button>
        <button class="sc-act danger" data-action="delete" title="删除">🗑</button>
      </div>
    `;
    // 内容进度点:mock 用 treble 数量粗略映射有内容的小节数。
    const filledCount = Math.min(s.totalMeasures, Math.ceil((s.treble?.length || 0) / 4));
    card.querySelectorAll('.sc-dot').forEach((d, i) => { if (i < filledCount) d.classList.add('filled'); });
    grid.appendChild(card);
  }

  // 新建占位卡(仅网格视图、且无搜索时显示)
  if (state.view === 'grid' && !state.query) {
    const nc = document.createElement('div');
    nc.className = 'score-card new-card';
    nc.dataset.action = 'new';
    nc.innerHTML = `<div class="new-card-inner"><div class="plus">＋</div><div>新建曲谱</div></div>`;
    grid.appendChild(nc);
  }

  root.appendChild(grid);

  const hint = document.createElement('div');
  hint.className = 'lib-hint';
  hint.innerHTML = `这是一个 <b>设计 demo</b>,展示曲谱管理的另一种形态。<br>
    交互:<kbd>↑↓←→</kbd> 选择卡片 · <kbd>Enter</kbd> 进入编辑 · <kbd>/</kbd> 聚焦搜索 · hover 卡片显示操作 · 点 <b>新建</b> 或末尾 <b>＋</b> 占位卡创建<br>
    设计要点:① 卡片缩略图是该曲真实前两小节五线谱,一眼认出曲子;② 卡片即入口(点开进编辑),不是下拉选择;③ 网格/列表双视图;④ 低频/危险操作(重命名/导出/删除)收进 hover 浮层,不占主视线。`;
  root.appendChild(hint);

  app.innerHTML = '';
  app.appendChild(root);
  bindEvents();
}

function bindEvents(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const search = app.querySelector('.lib-search input') as HTMLInputElement;
  search.addEventListener('input', (e) => { state.query = (e.target as HTMLInputElement).value; searchFocus = true; render(); });
  if (searchFocus) {
    const s = app.querySelector('.lib-search input') as HTMLInputElement;
    s.focus(); s.setSelectionRange(s.value.length, s.value.length); searchFocus = false;
  }
  app.querySelectorAll<HTMLButtonElement>('.lib-seg button').forEach(b => {
    b.addEventListener('click', () => {
      const seg = (b.closest('.lib-seg') as HTMLElement).dataset.seg;
      if (seg === 'sort') state.sort = b.dataset.sort as typeof state.sort;
      else state.view = b.dataset.view as 'grid' | 'list';
      render();
    });
  });
  app.querySelector('[data-action="new"]')?.addEventListener('click', (e) => { e.stopPropagation(); doNew(); });
  app.querySelectorAll<HTMLElement>('.score-card').forEach(card => {
    if (card.classList.contains('new-card')) {
      card.addEventListener('click', () => doNew());
      return;
    }
    card.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
      if (act === 'rename') { e.stopPropagation(); doRename(card.dataset.id!); return; }
      if (act === 'export') { e.stopPropagation(); doExport(card.dataset.id!); return; }
      if (act === 'delete') { e.stopPropagation(); doDelete(card.dataset.id!); return; }
      const id = card.dataset.id!;
      state.selectedId = id;
      card.classList.add('lib-entering');
      // 进入曲子视图
      setTimeout(() => { state.mode = 'score'; state.openId = id; state.startMeasure = 0; render(); }, 320);
    });
    card.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); card.click(); }
    });
  });
}

function doNew(): void {
  const title = prompt('曲谱标题:', '未命名曲谱');
  if (!title) return;
  state.scores.unshift({ id: 's' + Date.now(), title: title.trim() || '未命名', key: 'C', time: { num: 4, den: 4 }, totalMeasures: 4, updatedAt: Date.now(), treble: [] });
  render();
}
function doRename(id: string): void {
  const s = state.scores.find(x => x.id === id)!;
  const t = prompt('重命名:', s.title);
  if (t) { s.title = t.trim(); s.updatedAt = Date.now(); render(); }
}
function doExport(id: string): void { const s = state.scores.find(x => x.id === id)!; alert('→ 导出「' + s.title + '」为 .mscore(demo)'); }
function doDelete(id: string): void {
  const s = state.scores.find(x => x.id === id)!;
  if (confirm('删除「' + s.title + '」?')) { state.scores = state.scores.filter(x => x.id !== id); render(); }
}

// 全局快捷键
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    document.querySelector<HTMLInputElement>('.lib-search input')?.focus();
  }
});

// 启动:等字体加载完再渲染(缩略图依赖 Bravura 字体)
const root = document.getElementById('app');
if (root) root.innerHTML = '<div style="text-align:center;padding:80px;color:var(--muted)">加载字体中…</div>';
void ensureFontLoaded().then(() => render());
