// 应用装配：工具栏 ↔ 画布 ↔ 简谱 ↔ 播放 ↔ 导出 ↔ 快捷键
// 录入模型：追加式（短信验证码）—— 只能往末尾加，只能从末尾删。

import { Note, Piece, DurationValue, durationBeats, ViewMode, KeyName, TimeSig } from '../core/types';
import { KEYS, resolvePitch } from '../core/theory';
import { createPiece, appendNote, popNote, remainingBeats, remainingBeatsInCurrentBar, capacityBeats, totalBeats, totalBeatsBoth, noteStartBeats } from '../core/model';
import { computeLayout } from '../render/layout';
import { buildSVG, exportPNG, buildGrandSVG } from '../render/export';
import { ensureFontLoaded } from '../render/glyphs';
import { clickYToMidi } from '../render/staff';
import { computeBeams, indexBeamMap } from '../render/beam';
import { defaultTool, ToolState, TUPLET_CONFIG, TupletMode, tupletModeForActual } from './toolbar';
import { buildToolsPanel, ToolsPanelHandle } from './tools-panel';
import { buildMeasureSelector, MeasureSelectorHandle } from './measure-selector';
import { Player, PlayState } from '../audio/player';
import { buildPlaybackCard, loadFingering, loadShow, saveFingering, saveShow, Fingering, ShowFlags, PlaybackView } from './playback-card';
import { deserializeScore, scoreFileName } from '../core/serialize';
import { twinkleExample } from './examples';
import { Score, ScoreMeta, MeasureData, rangeToPiece, pieceBackToScore, emptyMeasure } from '../core/score';
import { listPieces, createPiece as apiCreatePiece, getPiece as apiGetPiece, updateMeta as apiUpdateMeta, putMeasure, deletePiece as apiDeletePiece, exportPiece as apiExportScore, MeasureFlusher } from '../core/storage';
import { buildPreviewModal, PreviewModalHandle } from './score-preview-modal';
import { buildPromptModal, PromptModalHandle } from './prompt-modal';
import { buildLibrary, LibraryHandle } from './library';
import { buildEditorBar, EditorBarHandle } from './editor-bar';

interface HoverState { midi: number; x: number; }

/** 按谱号独立的输入配置(切换激活态时各自保留/恢复)。
 *  调号/拍号/小节数是全曲属性,不在这里(共享 piece.key/time/measureCount)。 */
interface StaffToolConfig {
  duration: DurationValue;
  dotted: boolean;
  accidental: 'sharp' | 'flat' | 'natural' | null;
  tupletMode: TupletMode;
  chordMode: boolean;
}

/** 单卡片状态(多谱表模式下 treble/bass 各一个 CardState)。
 *  封装原 App 的单卡字段:DOM 宿主、布局、高度动画锚点、增删/连梁状态。
 *  渲染层(render/bindCanvas/heightTick/playhead)通过 CardState 参数化,支持多卡。 */
interface CardState {
  staff: 'treble' | 'bass';
  svgHost: HTMLElement;
  playheadLayer: HTMLElement;
  playheadEl: HTMLElement | null;
  layout: ReturnType<typeof computeLayout> | null;
  lastLayout: ReturnType<typeof computeLayout> | null;
  lastNoteCount: number;
  lastBeamGroups: { startIdx: number; endIdx: number }[];
  heightAnimFrame: number | null;
  staffAnchorScreen: number | null;
  /** 该卡的 piece 视图:{...piece, clef, notes: 对应组}。渲染层零侵入地用它。 */
  pieceView: Piece;
}

export class App {
  private piece: Piece;
  private tool: ToolState;
  /** 按谱号独立的输入配置:切换激活态时各自保留(duration/dotted/accidental/tuplet/chord)。
   *  this.tool 的这5项始终 = 当前激活谱号的配置(切换时同步)。 */
  private trebleTool: StaffToolConfig = { duration: 'quarter', dotted: false, accidental: null, tupletMode: 'off', chordMode: false };
  private bassTool: StaffToolConfig = { duration: 'quarter', dotted: false, accidental: null, tupletMode: 'off', chordMode: false };
  /** 连音组(tuplet)输入进度：开启 tuplet 模式后，追踪当前组已输入第几个、共用 groupId。
   *  输入第 actual 个后关闭模式并清空。null 表示不在组输入中。 */
  private tupletProgress: { groupId: string; count: number; actual: number; normal: number } | null = null;
  private tupletIdCounter = 0;
  /** 和弦(chord)输入:当前正在构建的和弦 chordId(和弦模式开且末尾音同此 id 时,下个音复用它做尾音)。
   *  null/不在和弦模式 → 下个音作为新和弦首音(或单音)。 */
  private currentChordId: string | null = null;
  private chordIdCounter = 0;
  private root: HTMLElement;
  /** 卡片:按 viewMode 挂载 1-2 个。treble/bass/grand 模式用;preview 模式单独处理。 */
  private cards: CardState[] = [];
  /** 当前激活卡(编辑/hover/nextSlot 只作用于激活卡)。单卡模式唯一卡天然激活。 */
  private activeCard: CardState | null = null;
  /** 视图模式:高音谱(treble)/低音谱(bass)/高低音谱(grand)/仅预览(preview)。 */
  private viewMode: 'treble' | 'bass' | 'grand' | 'preview' = 'treble';
  /** 指示器平移动画的 rAF id(与 heightTick 同款 JS 逐帧驱动,SVG CSS transform transition 不可靠)。 */
  private slotAnimFrame: number | null = null;
  /** 新音淡入动画的 rAF id(JS 逐帧 opacity,避免 CSS transition 与 heightTick rAF 交错失效)。 */
  private noteAnimFrame: number | null = null;
  private statusEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private stageWrap!: HTMLElement;
  private bpm = 100;
  private playingIndex = -1;
  private currentBeat = 0;
  private playState: PlayState = 'stopped';
  /** 当前曲谱项目(整曲)。未加载时为 null(启动初始化阶段)。 */
  private score: Score | null = null;
  /** 所有曲谱 meta 列表(项目下拉用)。 */
  private pieces: ScoreMeta[] = [];
  /** 编辑区起始小节(0-based):this.piece = rangeToPiece(score, currentStartMeasure, tool.measureCount)。
   *  点书签/预览小节切换它 → 编辑区换到「从该小节起的 N 个连续小节」。 */
  private currentStartMeasure = 0;
  /** 落盘节流队列(3 秒间隔,按小节局部落盘)。 */
  private flusher: MeasureFlusher | null = null;
  private fingering: Fingering;
  private show: ShowFlags;
  private player: Player;
  private toolbar!: HTMLElement;
  /** 工具盘(demo .sv-tools,含时值/修饰/调号拍号/退格清空 + MeasureSelector)。 */
  private toolsPanel: ToolsPanelHandle | null = null;
  /** MeasureSelector 句柄(挂在工具盘第三行)。 */
  private msHandle: MeasureSelectorHandle | null = null;
  private editorBar: EditorBarHandle | null = null;
  /** 编辑卡片顶部工具条的元素:范围提示(常驻)。 */
  private editRangeEl: HTMLElement | null = null;
  /** 退格/清空按钮组(编辑模式可见,预览模式隐藏)。 */
  private editActionsEl: HTMLElement | null = null;
  /** 预览模式的 五线谱/简谱/两者 radio(挂在 edit-toolbar 内,仅预览可见)。 */
  private previewRadioEl: HTMLElement | null = null;
  private previewModal: PreviewModalHandle | null = null;
  /** 通用自定义弹窗(新建起名等),替代原生 prompt。 */
  private promptModal: PromptModalHandle = buildPromptModal();
  /** 当前视图层级:library=曲谱库首屏;editor=编辑器(二级页)。 */
  private appView: 'library' | 'editor' = 'library';
  /** 库视图宿主(一级页)。 */
  private libraryHost: HTMLElement | null = null;
  /** 编辑器宿主(包住现有全部编辑器 DOM,二级页)。 */
  private editorHost: HTMLElement | null = null;
  /** 库句柄。 */
  private library: LibraryHandle | null = null;
  private playbackCard!: HTMLElement;
  private hover: HoverState | null = null;
  /** hover 试听音效开关(默认关)。 */
  private hoverSound = false;
  /** 预览模式的显示选项(五线谱/简谱/两者) */
  private previewMode: 'staff' | 'jianpu' | 'both' = 'both';
  /** 预览模式的 DOM 宿主(只读双谱表) */
  private previewHost: HTMLElement | null = null;
  private previewPlayheadEl: HTMLElement | null = null;
  /** 预览模式 treble 布局(seek/playhead 坐标换算用,与常规卡片 layout 同款) */
  private previewLayout: ReturnType<typeof computeLayout> | null = null;
  /** 预览模式 bass 布局(吸附 seek / 播放头跟随 bass 音用)。renderPreview 时同步刷新。 */
  private previewBassLayout: ReturnType<typeof computeLayout> | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.piece = createPiece();   // 占位:启动后由 loadScoreFromServer 用范围视图替换
    this.tool = defaultTool();
    this.viewMode = this.tool.viewMode;
    /** hover 试听音效开关(默认关)。localStorage 持久化。 */
    this.hoverSound = localStorage.getItem('hoverSound') === '1';
    this.fingering = loadFingering();
    this.show = loadShow();
    this.player = new Player({
      // onNote 不再驱动高亮(改由 onTick 统一更新,避免数据源不一致导致「落后一个音符」)。
      // 保留回调供未来用途(如 MIDI 输出),当前空实现。
      onNote: () => {},
      // onTick:单一数据源 currentBeat → 同时更新进度条 + 编辑区播放头 + 符头高亮 + 键盘高亮。
      // 这保证四者完全同步,不再出现「播放头滞后/键盘高亮不跟随」。
      onTick: (beat) => {
        this.currentBeat = beat;
        (this.playbackCard as any)._setProgress?.(beat);
        this.updatePlayheadAndHighlight();
        (this.playbackCard as any)._updateHighlight?.();   // 键盘高亮(只切 class,不重建)
      },
      onStateChange: (s) => {
        this.playState = s;
        if (s === 'stopped') { this.playingIndex = -1; this.currentBeat = 0; }
        (this.playbackCard as any)._refresh?.();
        // 状态切换后同步播放头/高亮显隐(playing/paused 显,stopped 隐+清高亮)
        this.updatePlayheadAndHighlight();
        this.render();
      },
      onEnd: () => {
        this.playingIndex = -1;
        this.currentBeat = 0;
        this.updatePlayheadAndHighlight();
        this.render();
      },
    });
    this.buildDOM();
    // 落盘队列:按小节局部落盘到服务端。
    this.flusher = new MeasureFlusher(async (idx, m) => {
      if (this.score) await putMeasure(this.score.meta.id, idx, m);
    }, 3000);
    // 页面关闭前强制 flush(防丢失改动)。sendBeacon 兜底不可行(需复杂请求),用同步 flush。
    window.addEventListener('beforeunload', () => { if (this.flusher?.hasPending()) { void this.flusher.flush(); } });
    void ensureFontLoaded().then(() => this.render());
    // 异步加载曲谱列表 + 选/建第一个(启动后接管 this.piece)。
    void this.initFromServer();
  }

  /** 启动:拉曲谱列表 → 渲染曲谱库首屏(不自动进编辑器)。
   *  失败(如服务器未启动)时降级为内存中的空 piece,编辑不落盘但不阻塞库 UI。 */
  private async initFromServer(): Promise<void> {
    // 缩略图依赖 Bravura 字体,等字体加载完再渲染库(避免缩略图渲染成 fallback 符号)。
    try { await ensureFontLoaded(); } catch { /* 忽略:字体失败也继续 */ }
    try {
      const { pieces } = await listPieces();
      this.pieces = pieces;
      this.buildLibraryView(pieces);
    } catch (err) {
      console.warn('[app] 加载曲谱失败,降级为内存模式:', err);
      this.flash('未连接存储服务器(仅内存模式)');
      // 仍渲染库(空状态 + 新建卡),让用户看到首屏而非空白。
      this.buildLibraryView([]);
    }
  }

  /** 构建/重建曲谱库视图(一级页)。metas 变化时用 library.refresh 增量刷新。 */
  private buildLibraryView(metas: ScoreMeta[]): void {
    if (this.library) {
      this.library.refresh(metas);
      return;
    }
    this.library = buildLibrary(metas, {
      onOpen: (id) => void this.openScoreFromLibrary(id),
      onNew: () => void this.createNewPieceInLibrary(),
      onRename: (id, title) => void this.renamePieceInLibrary(id, title),
      onExport: (id) => void this.exportPieceFromLibrary(id),
      onDelete: (id) => void this.deletePieceFromLibrary(id),
    });
    this.libraryHost?.appendChild(this.library.el);
  }

  /** 加载某曲谱整曲 → 设 this.score → 按 currentStartMeasure + tool.measureCount 切范围视图。 */
  private async loadScoreById(id: string): Promise<void> {
    try {
      // 切曲谱前先 flush 旧曲谱的待落盘改动。
      if (this.flusher) await this.flusher.flush();
      const score = await apiGetPiece(id);
      this.applyScore(score);
    } catch (err) {
      this.flash('加载曲谱失败:' + (err as Error).message);
    }
  }

  /** 应用新 score 到当前会话:刷新列表 meta、重置范围视图、重建卡片、render。 */
  private applyScore(score: Score): void {
    this.score = score;
    // 同步 tool 状态(调号/拍号/视图模式跟随整曲 meta)。
    this.tool.key = score.meta.key.name;
    this.tool.time = { ...score.meta.time };
    this.tool.measureCount = Math.min(this.tool.measureCount, score.meta.totalMeasures);
    this.tool.measureCount = Math.max(2, this.tool.measureCount);
    this.viewMode = score.meta.viewMode;
    this.currentStartMeasure = 0;
    // 刷新列表里该曲谱的 meta( updatedAt 可能变了)。
    this.pieces = this.pieces.map(p => p.id === score.meta.id ? score.meta : p);
    this.rebuildRangePiece();
    this.player.stop();
    this.playingIndex = -1;
    this.currentBeat = 0;
    this.playState = 'stopped';
    this.hover = null;
    this.currentChordId = null;
    this.tupletProgress = null;
    this.rebuildCards();
    this.rebuildToolbar();
    this.refreshEditorBar();
    this.render();
  }

  /** 由 this.score + currentStartMeasure + tool.measureCount 重建范围视图 Piece。
   *  现有渲染/编辑/播放层继续吃这个 N 小节单行 Piece,零改动。 */
  private rebuildRangePiece(): void {
    if (!this.score) return;
    const activeStaff = this.viewMode === 'bass' ? 'bass' : 'treble';
    this.piece = rangeToPiece(this.score, this.currentStartMeasure, this.tool.measureCount, activeStaff);
  }

  /** 刷新编辑器顶栏(appbar:曲名/调号拍号徽章)+ 视图 active(工具盘)+ MeasureSelector + 范围提示。 */
  private refreshEditorBar(): void {
    this.editorBar?.refresh({
      title: this.score?.meta.title ?? '未命名',
      key: this.tool.key,
      time: this.tool.time,
    });
    this.toolsPanel?._setViewMode(this.viewMode);
    this.refreshMeasureSelector();
    this.updateRangeHint();
  }

  /** 算每小节是否有内容(treble/bass 任一非空)。供 appbar 书签圆点。 */
  private measureHasContent(): boolean[] {
    if (!this.score) return [];
    return this.score.measures.map(m => !!(m && (m.treble.length > 0 || m.bass.length > 0)));
  }

  // ── 编辑器顶栏(appbar)回调 ────────────────────────────────

  /** appbar 曲名改名:落盘 + 同步 pieces/score meta。 */
  private async renameInEditor(newTitle: string): Promise<void> {
    if (!this.score) return;
    if ((this.score.meta.title || '') === newTitle) return;
    try {
      const meta = await apiUpdateMeta(this.score.meta.id, { title: newTitle });
      this.score.meta = meta;
      this.pieces = this.pieces.map(p => p.id === meta.id ? meta : p);
      this.flash('已改名');
    } catch (err) {
      this.flash('改名失败:' + (err as Error).message);
    }
  }

  /** appbar 视图 radio:同步 tool.viewMode 后走 onToolChange(复用现有重建/落盘)。 */
  private changeViewMode(v: ViewMode): void {
    if (this.tool.viewMode === v) return;
    this.tool.viewMode = v;
    this.onToolChange();
  }

  /** appbar 调号徽章:同步 tool.key 后走 onToolChange(落盘 + 重建)。 */
  private changeKey(k: KeyName): void {
    if (this.tool.key === k) return;
    this.tool.key = k;
    this.onToolChange();
  }

  /** appbar 拍号徽章:同步 tool.time 后走 onToolChange(拍号变会清空整曲小节)。 */
  private changeTime(t: TimeSig): void {
    if (this.tool.time.num === t.num && this.tool.time.den === t.den) return;
    this.tool.time = t;
    this.onToolChange();
  }

  // ── 曲谱库一级页回调 ──────────────────────────────────────

  /** 库 → 打开某曲谱:加载整曲 → 切到编辑器。 */
  private async openScoreFromLibrary(id: string): Promise<void> {
    await this.loadScoreById(id);
    this.switchToEditor();
  }

  /** 库 → 新建曲谱:弹自定义起名弹窗 → 建谱 → 直接进入二级编辑页。 */
  private async createNewPieceInLibrary(): Promise<void> {
    const title = await this.promptModal.promptText({
      title: '新建曲谱',
      placeholder: '曲谱标题',
      initial: '未命名曲谱',
      confirmText: '创建',
    });
    if (title === null) return;   // 取消
    try {
      const meta = await apiCreatePiece({
        title: title || '未命名曲谱',
        totalMeasures: 4,
        viewMode: this.tool.viewMode,
        key: KEYS[this.tool.key],
        time: { ...this.tool.time },
      });
      this.pieces = [meta, ...this.pieces];
      // 建好后直接进入二级编辑页(不再留在库)。
      await this.openScoreFromLibrary(meta.id);
    } catch (err) {
      this.flash('新建失败:' + (err as Error).message);
    }
  }

  /** 库 → 重命名:落盘 meta → 刷新库。 */
  private async renamePieceInLibrary(id: string, newTitle: string): Promise<void> {
    try {
      const meta = await apiUpdateMeta(id, { title: newTitle });
      this.pieces = this.pieces.map(p => p.id === id ? meta : p);
      this.buildLibraryView(this.pieces);
    } catch (err) {
      this.flash('重命名失败:' + (err as Error).message);
    }
  }

  /** 库 → 导出整曲为 .mscore(下载)。复用 exportCurrentScore 的下载逻辑,
   *  但操作任意 id(不依赖当前打开的 score)。 */
  private async exportPieceFromLibrary(id: string): Promise<void> {
    const meta = this.pieces.find(p => p.id === id);
    if (!meta) { this.flash('无曲谱可导出'); return; }
    try {
      const text = await apiExportScore(id);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = scoreFileName(meta.title);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      this.flash('导出失败:' + (err as Error).message);
    }
  }

  /** 库 → 删除曲谱:删后刷新库(库为空也不强制建,显示空状态)。 */
  private async deletePieceFromLibrary(id: string): Promise<void> {
    try {
      // 若删的是当前正在编辑的曲谱,先 flush 再清空编辑器引用。
      if (this.score && this.score.meta.id === id) {
        if (this.flusher) await this.flusher.flush();
        this.score = null;
      }
      await apiDeletePiece(id);
      this.pieces = this.pieces.filter(p => p.id !== id);
      this.buildLibraryView(this.pieces);
    } catch (err) {
      this.flash('删除失败:' + (err as Error).message);
    }
  }

  /** 切到编辑器(二级页):显示编辑器,隐藏库,并触发一次渲染填充五线谱。 */
  private switchToEditor(): void {
    this.appView = 'editor';
    if (this.libraryHost) this.libraryHost.hidden = true;
    if (this.editorHost) this.editorHost.hidden = false;
    // applyScore 的 render 在库视图下早退(此时编辑器隐藏),切到编辑器后补一次,
    // 让卡片五线谱/简谱真正填充。卡片宽度依赖可见后的 clientWidth,故必须切显后再渲染。
    this.rebuildCards();
    this.refreshEditorBar();
    this.render();
    // 入场动画:opacity + translateY(200ms easeOutCubic),与 mode-enter 同款。
    if (this.editorHost) {
      this.editorHost.classList.add('editor-enter');
      window.setTimeout(() => this.editorHost?.classList.remove('editor-enter'), 220);
    }
  }

  /** 切回曲谱库(一级页):flush 编辑改动 + 停播放 + 刷新库(更新时间/顺序) + 显示库。 */
  private async switchToLibrary(): Promise<void> {
    if (this.flusher) await this.flusher.flush();
    this.player.stop();
    this.playingIndex = -1;
    this.currentBeat = 0;
    this.playState = 'stopped';
    this.appView = 'library';
    if (this.editorHost) this.editorHost.hidden = true;
    if (this.libraryHost) this.libraryHost.hidden = false;
    // 刷新库:updatedAt 可能因编辑变化,排序需更新;新缩略图按需拉取。
    try {
      const { pieces } = await listPieces();
      this.pieces = pieces;
      this.buildLibraryView(pieces);
    } catch { /* 忽略:保留旧列表 */ }
  }

  /** 由 .mscore 文本导入整曲(拖拽共用)。 */
  private async importScoreText(text: string): Promise<void> {
    try {
      const imported = deserializeScore(text);
      if (this.flusher) await this.flusher.flush();
      // 建新曲谱(用导入的 meta),再把各小节逐个 PUT。
      const meta = await apiCreatePiece({
        title: imported.meta.title || '导入的曲谱',
        key: imported.meta.key,
        time: imported.meta.time,
        totalMeasures: imported.meta.totalMeasures,
        viewMode: imported.meta.viewMode,
      });
      // 逐小节落盘(并发会乱序,顺序 await)。
      for (let i = 0; i < imported.meta.totalMeasures; i++) {
        await putMeasure(meta.id, i, imported.measures[i]);
      }
      this.pieces = [meta, ...this.pieces];
      await this.loadScoreById(meta.id);
      this.flash(`已导入整曲(${imported.meta.totalMeasures} 小节)`);
    } catch (err) {
      this.flash('导入失败:' + (err as Error).message);
    }
  }

  /** 点小节书签:切编辑区到「从第 n 小节起的 N 个连续小节」。保留其它小节。 */
  private selectMeasure(n0Based: number): void {
    if (!this.score) return;
    // 切前先 flush 当前窗口改动。
    void this.flusher?.flush();
    const maxStart = Math.max(0, this.score.meta.totalMeasures - this.tool.measureCount);
    this.currentStartMeasure = Math.max(0, Math.min(n0Based, maxStart));
    this.rebuildRangePiece();
    this.player.stop();
    this.playingIndex = -1;
    this.currentBeat = 0;
    this.playState = 'stopped';
    this.hover = null;
    this.currentChordId = null;
    this.tupletProgress = null;
    this.refreshEditorBar();
    this.rebuildCards();
    this.render();
  }

  /** 打开整曲预览弹窗。 */
  private openPreview(): void {
    if (!this.score) { this.flash('无曲谱可预览'); return; }
    this.previewModal?.open();
  }

  private buildDOM(): void {
    this.root.innerHTML = '';
    this.root.className = 'app';

    // 一级页:曲谱库宿主(启动首屏)。
    this.libraryHost = document.createElement('div');
    this.libraryHost.className = 'library-host';
    this.root.appendChild(this.libraryHost);

    // 二级页:编辑器宿主(包住现有全部编辑器 DOM,初始隐藏)。
    this.editorHost = document.createElement('div');
    this.editorHost.className = 'editor-host';
    this.editorHost.hidden = true;
    this.root.appendChild(this.editorHost);

    // 二级页顶栏(appbar):返回 + 曲名 + 调号拍号徽章(可点改) + 预览。
    this.editorBar = buildEditorBar(
      { title: this.score?.meta.title ?? '未命名', key: this.tool.key, time: this.tool.time },
      {
        onBack: () => void this.switchToLibrary(),
        onRename: (t) => void this.renameInEditor(t),
        onChangeKey: (k) => this.changeKey(k),
        onChangeTime: (t) => this.changeTime(t),
        onOpenPreview: () => this.openPreview(),
      },
    );
    this.editorHost.appendChild(this.editorBar.el);

    // 整曲预览弹窗(惰性 open)。
    this.previewModal = buildPreviewModal({
      onSelectMeasure: (n) => this.selectMeasure(n),
      getScore: () => this.score,
    });

    this.toolbar = this.buildToolsPanelEl();
    this.editorHost.appendChild(this.toolbar);

    this.stageWrap = document.createElement('div');
    this.stageWrap.className = 'stage';
    // 编辑卡片顶部工具条:左侧范围提示(常驻) + 右侧编辑动作(退格/清空) 或 预览 radio。
    // 预览模式下退格/清空隐藏,改显示 五线谱/简谱/两者 radio(由 syncEditToolbar 切换)。
    const editToolbar = document.createElement('div');
    editToolbar.className = 'edit-toolbar';
    const editRange = document.createElement('span');
    editRange.className = 'edit-range';
    editRange.innerHTML = '第 <b>1–2</b> 小节';
    this.editRangeEl = editRange;
    const undoBtn = mkBtn('⌫ 退格', 'ghost', () => this.deleteLastNote());
    undoBtn.className = 'btn btn-ghost edit-act';
    undoBtn.title = '退格删除最后一个音 (Backspace)';
    const editClearBtn = mkBtn('清空当前范围', 'ghost', () => this.clear());
    editClearBtn.className = 'btn btn-ghost edit-act danger';
    editClearBtn.title = '清空当前范围';
    // 退格/清空包进 edit-actions 容器(整体显隐)
    const editActions = document.createElement('div');
    editActions.className = 'edit-actions';
    editActions.append(undoBtn, editClearBtn);
    this.editActionsEl = editActions;
    // 预览 radio(复用 makePreviewRadio,驱动 this.previewMode);默认隐藏,预览模式显示
    this.previewRadioEl = this.makePreviewRadio();
    this.previewRadioEl.classList.add('hidden');
    const editSpacer = document.createElement('div');
    editSpacer.className = 'spacer';
    editToolbar.append(editRange, editSpacer, editActions, this.previewRadioEl);
    this.stageWrap.appendChild(editToolbar);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';
    // status 行内左侧:hover 试听音效开关(无文案,图标用 speaker SVG)
    const hoverSoundBtn = document.createElement('button');
    hoverSoundBtn.className = 'hover-sound-toggle';
    hoverSoundBtn.type = 'button';
    hoverSoundBtn.title = '悬停时试听音效';
    const speakerOn = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    const speakerOff = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    const updateHoverBtn = () => {
      hoverSoundBtn.innerHTML = this.hoverSound ? speakerOn : speakerOff;
      hoverSoundBtn.classList.toggle('active', this.hoverSound);
    };
    updateHoverBtn();
    hoverSoundBtn.onclick = () => {
      this.hoverSound = !this.hoverSound;
      localStorage.setItem('hoverSound', this.hoverSound ? '1' : '0');
      updateHoverBtn();
    };
    this.statusEl.appendChild(hoverSoundBtn);
    const statusText = document.createElement('span');
    statusText.className = 'status-text';
    this.statusEl.appendChild(statusText);
    this.statusTextEl = statusText;
    this.stageWrap.appendChild(this.statusEl);
    this.editorHost.appendChild(this.stageWrap);

    // 按 viewMode 创建卡片
    this.rebuildCards();

    // 放音功能区卡片（替换原播放底栏）
    this.playbackCard = buildPlaybackCard(() => this.playbackView(), {
      onTogglePlay: () => this.togglePlay(),
      onStop: () => { this.player.stop(); this.playingIndex = -1; this.currentBeat = 0; this.render(); },
      onRestart: () => this.restart(),
      onSeek: (beat) => this.seek(beat),
      onBpm: (b) => this.changeBpm(b),
      onFingering: (f) => { this.fingering = f; saveFingering(f); this.refreshCard(); },
      onShow: (key, on) => { this.show = { ...this.show, [key]: on }; saveShow(this.show); this.refreshCard(); },
    });
    this.editorHost.appendChild(this.playbackCard);

    // 编辑操作栏（示例/清空 + PNG 导出）—— 次要操作，放卡片下一行。
    // 曲谱级导入/导出/删除 已移到项目面板。
    const editBar = document.createElement('div');
    editBar.className = 'edit-bar';
    const exampleBtn = mkBtn('示例：小星星', 'ghost', () => this.loadExample());
    const pngBtn = mkBtn('⬇ 导出 PNG', 'ghost', () => { void this.doExport(); });
    editBar.append(spacer(), exampleBtn, pngBtn);
    this.editorHost.appendChild(editBar);

    this.bindKeys();
    // 拖拽 .mscore 文件导入整曲(复用 importScoreFile 的解析+建曲谱逻辑)。
    let dragCounter = 0;
    this.root.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      dragCounter++;
      this.root.classList.add('drag-over');
    });
    this.root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    this.root.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; this.root.classList.remove('drag-over'); } });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      this.root.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) void file.text().then(t => this.importScoreText(t));
    });
    // 全局 mouseup 复位 isMouseDown(只在构造器绑一次,避免 bindCard 每张卡都累积 window 监听器)。
    window.addEventListener('mouseup', () => { this.isMouseDown = false; });
    this.render();
  }

  /** 按 viewMode 创建/重建卡片 DOM。treble/bass=1 卡,grand=2 卡,preview=预览卡(阶段5)。
   *  卡片 svgHost 挂在 stageWrap 内(statusEl 之前)。切模式时调用重建。 */
  private rebuildCards(): void {
    // 记录重建前的激活谱号:loadStaffConfig(含 rebuildToolbar→重建 MS 实例)仅在 staff 变化时才需要。
    // MeasureSelector 改范围时 activeCard.staff 不变,跳过 loadStaffConfig 可避免 MS 实例被重建
    // 打断吸附动画(rebuildToolbar 会销毁+重建整个工具盘)。见 onMeasureSelectorChange。
    const prevActiveStaff = this.activeCard?.staff ?? null;
    // 清旧卡片 DOM(同时取消进行中的高度动画 rAF,避免回调操作游离 DOM)
    for (const c of this.cards) {
      if (c.heightAnimFrame !== null) cancelAnimationFrame(c.heightAnimFrame);
      c.svgHost.remove();
    }
    this.cards = [];
    this.activeCard = null;
    // 清旧预览卡(radio 已移到 edit-toolbar 内,不再随模式重建)
    if (this.previewHost) { this.previewHost.remove(); this.previewHost = null; this.previewPlayheadEl = null; this.previewLayout = null; this.previewBassLayout = null; }
    this.stageWrap.querySelectorAll('.preview-bar').forEach(el => el.remove());
    // 预览模式:只读双谱表卡(radio 在 edit-toolbar 内,由 syncEditToolbar 切显隐)
    if (this.viewMode === 'preview') {
      this.previewHost = this.createPreviewHost();
      this.previewHost.classList.add('mode-enter');
      this.stageWrap.insertBefore(this.previewHost, this.statusEl);
      this.bindPreviewHost();
      this.syncEditToolbar();
      setTimeout(() => this.previewHost?.classList.remove('mode-enter'), 130);
      return;
    }
    this.syncEditToolbar();
    const staves: ('treble' | 'bass')[] = this.viewMode === 'bass' ? ['bass'] : this.viewMode === 'grand' ? ['treble', 'bass'] : ['treble'];
    for (const staff of staves) {
      const card = this.createCard(staff);
      card.svgHost.classList.add('mode-enter');
      this.cards.push(card);
      this.stageWrap.insertBefore(card.svgHost, this.statusEl);
      this.bindCard(card);
    }
    this.activeCard = this.cards[0] ?? null;
    // 激活态:piece.notes 指向激活卡的组 + 加载该谱号的输入配置(工具栏按钮跟随)
    if (this.activeCard) {
      this.piece.notes = this.activeCard.staff === 'bass' ? this.piece.bass : this.piece.treble;
      this.piece.clef = this.activeCard.staff;
      // 仅激活谱号变化时才同步工具栏(loadStaffConfig→rebuildToolbar 会重建 MS 实例,打断动画)。
      // staff 未变(如 MeasureSelector 改范围)时跳过。
      if (this.activeCard.staff !== prevActiveStaff) {
        this.loadStaffConfig(this.activeCard.staff);
      }
    }
    this.updateCardActiveVisual();
    // 模式切换动画结束后移除 mode-enter(允许下次切换重新触发)
    setTimeout(() => { for (const c of this.cards) c.svgHost.classList.remove('mode-enter'); }, 130);
  }
  /** 创建预览模式宿主(双谱表 + 右上角 radio 五线谱/简谱/两者 + 播放头层)。 */
  private createPreviewHost(): HTMLElement {
    const host = document.createElement('div');
    host.className = 'svg-host preview-host';
    return host;
  }

  /** 绑定预览卡点击/拖动 → seek(点击跳转 + 拖动连续 seek)。
   *  radio 按钮(五线谱/简谱/两者)在 previewHost 内,其点击需排除(不触发 seek)。
   *  window 的 mousemove/mouseup 采用"按下时绑定、抬起时解绑"模式,避免反复进出
   *  预览模式时 window 监听器累积泄漏(旧实现每次 bindPreviewHost 都永久注册一份)。 */
  private bindPreviewHost(): void {
    if (!this.previewHost) return;
    const host = this.previewHost;
    let dragging = false;
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const beat = this.beatFromPreviewX(e.clientX);
      if (beat !== null) this.seek(beat);
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    host.addEventListener('mousedown', (e: MouseEvent) => {
      // radio 按钮区域不触发 seek
      if ((e.target as HTMLElement).closest('.preview-radio')) return;
      dragging = true;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      const beat = this.beatFromPreviewX(e.clientX);
      if (beat !== null) this.seek(beat);
    });
  }

  /** 预览卡点击 x → beat(吸附到两组中绝对最近的音符中心,与播放头同基准)。
   *  双谱表下同一点击 x 对应两组各自一个最近音,取两组所有音符中中心 x 绝对最近者,
   *  返回该音的起点 beat。点击落在所有音符 x 范围之外(空白区)→ 退化为 beat 线性兜底。
   *  这样点击点与播放头落点用同一基准(noteX),不再出现"点击与落点对不上"的视觉错乱。 */
  private beatFromPreviewX(clientX: number): number | null {
    const lay = this.previewLayout;
    const bassLay = this.previewBassLayout;
    if (!lay || !this.previewHost) return null;
    const svg = this.previewHost.querySelector('svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    // SVG 内部 x 坐标(与 layout.noteX 同基准:SVG 内部 px)
    const svgX = (clientX - rect.left) / rect.width * lay.width;
    const beats = this.player.getTotalBeats() || 1;
    // 收集两组所有音符,找中心 x 绝对最近者。bestDist=Infinity 表示尚未命中任何音。
    let bestBeat = -1;
    let bestDist = Infinity;
    const trebleStarts = noteStartBeats({ ...this.piece, notes: this.piece.treble });
    const bassStarts = noteStartBeats({ ...this.piece, notes: this.piece.bass });
    const consider = (noteX: number[], starts: number[]) => {
      for (let i = 0; i < noteX.length && i < starts.length; i++) {
        const dist = Math.abs(noteX[i] - svgX);
        if (dist < bestDist) { bestDist = dist; bestBeat = starts[i]; }
      }
    };
    consider(lay.noteX, trebleStarts);
    if (bassLay) consider(bassLay.noteX, bassStarts);
    if (bestBeat >= 0) return Math.max(0, Math.min(bestBeat, beats));
    // 两组全空(无音):线性兜底
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * beats;
  }

  /** 渲染预览模式:双谱表 buildGrandSVG + 播放头。 */
  private renderPreview(): void {
    if (!this.previewHost) return;
    const width = Math.min(1200, Math.max(640, this.previewHost.clientWidth || 940));
    const treblePiece = { ...this.piece, clef: 'treble' as const, notes: this.piece.treble };
    const bassPiece = { ...this.piece, clef: 'bass' as const, notes: this.piece.bass };
    const trebleLayout = computeLayout(treblePiece, width, this.tool.duration);
    const bassLayout = computeLayout(bassPiece, width, this.tool.duration);
    const playingT = this.playState !== 'stopped' ? this.player.noteIndexAtBeatStaff(this.currentBeat, 'treble') : -1;
    const playingB = this.playState !== 'stopped' ? this.player.noteIndexAtBeatStaff(this.currentBeat, 'bass') : -1;
    const { svg, height } = buildGrandSVG(treblePiece, bassPiece, trebleLayout, bassLayout, {
      previewMode: this.previewMode, playingTrebleIdx: playingT, playingBassIdx: playingB,
    });
    this.previewLayout = trebleLayout;   // 存布局供 seek/playhead 换算
    this.previewBassLayout = bassLayout; // bass 布局供吸附 seek / 播放头跟随 bass 音
    this.previewHost.innerHTML = svg;
    this.previewHost.style.height = (height + 16) + 'px';   // 容器高度容纳双谱表(含 padding)
    const svgEl = this.previewHost.querySelector('svg');
    if (svgEl) {
      svgEl.setAttribute('width', '100%');
      svgEl.setAttribute('height', String(height));
      svgEl.setAttribute('preserveAspectRatio', 'none');
    }
    // 重挂播放头层(radio 已在卡片上方独立元素,不受 innerHTML 影响)。
    // display 统一由 updatePreviewPlayhead 控制(停止态也显示,作 seek 定位指示)。
    const phl = document.createElement('div');
    phl.className = 'playhead-layer';
    this.previewHost.appendChild(phl);
    this.previewPlayheadEl = null;
    this.updatePreviewPlayhead(trebleLayout, bassLayout);
  }

  /** 构造预览 radio(五线谱/简谱/两者)。每次 renderPreview 后重挂(innerHTML 清掉)。 */
  private makePreviewRadio(): HTMLElement {
    const radio = document.createElement('div');
    radio.className = 'preview-radio';
    for (const o of [{ v: 'staff', l: '五线谱' }, { v: 'jianpu', l: '简谱' }, { v: 'both', l: '两者' }] as const) {
      const b = document.createElement('button');
      b.className = 'seg-btn';
      b.textContent = o.l;
      if (this.previewMode === o.v) b.classList.add('active');
      b.onclick = () => {
        this.previewMode = o.v;
        this.render();
      };
      radio.appendChild(b);
    }
    return radio;
  }

  /** 用 layout 几何(而非 player.schedule)解析"beat 当前落在哪组哪个音"。
   *  返回该音在 noteX 数组中的 idx;返回 -1 表示该 beat 不在该组任何音的实际发声区间内
   *  (如该组较短,beat 已超过其末音的结束拍)。严格判断 [start, start+dur) 区间,使短组
   *  播完后不被误判为"仍在响",从而播放头能继续跟随另一组(修复"播完短组播放头不动")。
   *  之所以不用 player.noteIndexAtBeatStaff:停止态 schedule 为空时恒返回 -1,
   *  导致停止态 seek 后播放头走错误的线性兜底。layout.noteX + noteStartBeats
   *  只要谱面有音就有效,停止态/播放态一致,且与点击吸附用同一套几何基准。 */
  private noteIndexAtBeatLayout(beat: number, noteX: number[], starts: number[], notes: Note[]): number {
    if (noteX.length === 0 || starts.length === 0) return -1;
    // 找最后一个 startBeat <= beat 的音,再确认 beat 仍在该音实际持续区间 [start, start+dur) 内。
    // 和弦尾音 startBeat=首音 startBeat,dur 照算(尾音与首音同时响,区间重合无影响)。
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] > beat + 1e-9) break;   // 后面的音起点已超过 beat,停止
      const dur = durationBeats(notes[i]);
      if (beat < starts[i] + dur - 1e-9) return i;   // beat 仍在该音发声区间内
    }
    return -1;   // beat 超过该组所有音的发声区间(短组已播完)
  }

  /** 更新预览卡播放头:横向跟随当前发声音符(noteX),纵向顶满预览区(preview-host)上下两端。
   *  停止态也显示(seek 定位用):停在 currentBeat 处,不随时间移动(tickLoop 不跑)。 */
  private updatePreviewPlayhead(
    trebleLayout: ReturnType<typeof computeLayout>,
    bassLayout: ReturnType<typeof computeLayout>,
  ): void {
    if (!this.previewHost) return;
    const phl = this.previewHost.querySelector('.playhead-layer') as HTMLElement | null;
    if (!phl) return;
    phl.style.display = '';   // 停止态也显示(seek 定位指示)
    const svg = this.previewHost.querySelector('svg');
    if (!svg) return;
    // 横向:用 getBoundingClientRect(SVG 宽不受高度 transition 影响,实时准)
    const hostRect = this.previewHost.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const offsetX = ((svgRect.left - hostRect.left) / hostRect.width) * 100;
    const svgWPct = (svgRect.width / hostRect.width) * 100;
    // 横向定位:用 layout.noteX + noteStartBeats 自行解析 beat 落在哪组哪个音(不依赖
    // player.schedule,停止态也正确)。两组小节线 x 对齐,任一组 noteX 都对应同一全局 beat。
    //   - 任一组有音在响 → 用该组 noteX[idx](两组都在响取 treble,几何等价)
    //   - 两组都无音(空白区)→ beat 线性兜底
    const trebleStarts = noteStartBeats({ ...this.piece, notes: this.piece.treble });
    const bassStarts = noteStartBeats({ ...this.piece, notes: this.piece.bass });
    const tIdx = this.noteIndexAtBeatLayout(this.currentBeat, trebleLayout.noteX, trebleStarts, this.piece.treble);
    const bIdx = this.noteIndexAtBeatLayout(this.currentBeat, bassLayout.noteX, bassStarts, this.piece.bass);
    // 播放头宽 = 2*noteHeadHalf(符头宽+左右padding),与主卡/sms框一致,以 noteX 为中心盖住符头。
    const w = trebleLayout.noteHeadHalf * 2;
    const widthPct = w / trebleLayout.width * svgWPct;
    let x0: number;
    if (tIdx >= 0 && bIdx >= 0) {
      // 两组都在响:跟随时值更短的那组音。短音是节奏主驱动(更频繁切换),跟着它跳动
      // 最符合听觉节奏;长音是持续铺垫,无需播放头盯着。两组小节线 x 对齐但各自音符中心
      // x 不同,只跟一组才能让播放头平滑跳动。相同时值(如都是四分)→ 跟 treble(主旋律)。
      // 例:treble 1四分 + bass 2八分,八分更短 → 跟随 bass 在两八分间跳动(treble 长音不停留)。
      // durationBeats 已含连音缩放(三连音八分=1/3拍),连音天然比四分/八分更短,优先跟随。
      const tDur = durationBeats(this.piece.treble[tIdx]);
      const bDur = durationBeats(this.piece.bass[bIdx]);
      x0 = bDur < tDur ? bassLayout.noteX[bIdx] : trebleLayout.noteX[tIdx];
    } else if (tIdx >= 0) {
      x0 = trebleLayout.noteX[tIdx];
    } else if (bIdx >= 0) {
      x0 = bassLayout.noteX[bIdx];
    } else {
      // 两组都无音(空白区/谱面前后):按 beat 线性铺到谱面内容区。beats 用两组实际拍数 max,
      // 避免停止态 totalBeats=0 导致 ratio 异常。
      const beats = Math.max(totalBeatsBoth(this.piece), this.player.getTotalBeats()) || 1;
      const ratio = Math.max(0, Math.min(1, this.currentBeat / beats));
      x0 = trebleLayout.contentLeft + ratio * trebleLayout.contentWidth;
    }
    const leftPct = offsetX + (x0 - w / 2) / trebleLayout.width * svgWPct;
    // 高度:播放头顶到预览卡(preview-host,淡灰色背景区)上下两端。playhead-layer 用 inset:0
    // 覆盖 host padding box,故 top:0/height:100% 即覆盖整个淡灰色可见区。这样播放头在
    // 五线谱/简谱/两者 各模式下都贯通整个预览区,视觉醒目且无需随 mode 重算 y 范围。
    const topPct = 0;
    const heightPct = 100;
    if (!this.previewPlayheadEl || !phl.contains(this.previewPlayheadEl)) {
      this.previewPlayheadEl = document.createElement('div');
      this.previewPlayheadEl.className = 'pb-playhead';
      phl.appendChild(this.previewPlayheadEl);
    }
    const el = this.previewPlayheadEl;
    el.style.left = leftPct.toFixed(2) + '%';
    el.style.top = topPct.toFixed(2) + '%';
    el.style.width = widthPct.toFixed(2) + '%';
    el.style.height = heightPct.toFixed(2) + '%';
  }

  /** 创建一个卡片(svgHost + playheadLayer + CardState)。pieceView = {..piece, clef, notes: 对应组}。 */
  private createCard(staff: 'treble' | 'bass'): CardState {
    const svgHost = document.createElement('div');
    svgHost.className = 'svg-host';
    if (this.viewMode === 'grand') svgHost.classList.add('dual');
    const playheadLayer = document.createElement('div');
    playheadLayer.className = 'playhead-layer';
    playheadLayer.style.display = 'none';
    svgHost.appendChild(playheadLayer);
    // 双卡模式:加拖拽指示条(grand 模式 hover 显现,按住拖拽交换两卡顺序)
    if (this.viewMode === 'grand') {
      const handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.title = '拖拽交换顺序';
      svgHost.appendChild(handle);
    }
    const notes = staff === 'bass' ? this.piece.bass : this.piece.treble;
    return {
      staff, svgHost, playheadLayer, playheadEl: null,
      layout: null, lastLayout: null, lastNoteCount: 0, lastBeamGroups: [],
      heightAnimFrame: null, staffAnchorScreen: null,
      pieceView: { ...this.piece, clef: staff, notes },
    };
  }

  /** 更新卡片激活态视觉(active 卡正常,非 active 半透明 + 点击切换激活)。 */
  private updateCardActiveVisual(): void {
    for (const c of this.cards) {
      const isActive = c === this.activeCard;
      c.svgHost.classList.toggle('inactive', this.viewMode === 'grand' && !isActive);
    }
  }

  private isMouseDown = false;
  /** mousedown 时记录的音高:按下→抬起若跨多个音高,应按「按下音高」输入而非抬起音高。
   *  click 事件在 mouseup 后触发,其坐标是抬起位置,故改用 mousedown 记录的音高。 */
  private downMidi: number | null = null;

  /** 绑定单卡片的画布交互(mousedown/move/click)。card 决定坐标换算用哪个 layout/clef。
   *  click 时:grand 模式点非激活卡先切换激活;激活卡的 click 才追加音符。 */
  private bindCard(card: CardState): void {
    const host = card.svgHost;
    host.addEventListener('selectstart', (e) => e.preventDefault());
    host.addEventListener('dblclick', (e) => e.preventDefault());

    host.addEventListener('mousedown', (e: MouseEvent) => {
      this.isMouseDown = true;
      // grand 模式:点非激活卡 → 仅切换激活,不记录音高(避免切换瞬间误输入音)
      if (this.viewMode === 'grand' && card !== this.activeCard) {
        this.setActiveCard(card);
        this.downMidi = null;   // 切换激活的那次点击不输入
        return;
      }
      const { y, ok } = this.toSvgCoords(e, card);
      this.downMidi = ok && card.layout ? clickYToMidi(y, card.pieceView, card.layout) : null;
    });
    // 注:isMouseDown 的全局 mouseup 复位在构造器统一绑定(避免每张卡累积 window 监听器)。

    // mousemove → 悬停预览(仅激活卡)
    host.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isMouseDown) return;
      if (card !== this.activeCard) return;   // 非激活卡不预览
      const { y, ok } = this.toSvgCoords(e, card);
      if (!ok || !card.layout) { this.clearHover(); return; }
      const midi = clickYToMidi(y, card.pieceView, card.layout);
      if (this.hover && this.hover.midi === midi) return;
      this.hover = { midi, x: card.layout.nextSlotX };
      this.render();
      this.maybePreview(midi);
    });
    host.addEventListener('mouseleave', () => this.clearHover());

    // click → 追加音符(仅激活卡)
    host.addEventListener('click', () => {
      if (card !== this.activeCard) return;
      if (this.downMidi === null) return;
      const midi = this.downMidi;
      this.downMidi = null;
      this.appendNoteWithPitch(midi);
    });

    // 双卡模式:拖拽指示条 → 拖拽交换两卡 DOM 顺序(数据归属不变,只换视觉位置)
    const handle = host.querySelector('.drag-handle') as HTMLElement | null;
    if (handle) {
      handle.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();   // 不触发卡片的 mousedown(避免切换激活/记录音高)
        this.startCardDrag(card, e.clientY);
      });
    }
  }

  /** 把 this.tool 的输入配置(duration/dotted/accidental/tuplet/chord)存到对应谱号的配置。
   *  切换激活态前调用(保存当前谱号的配置)。 */
  private saveStaffConfig(staff: 'treble' | 'bass'): void {
    const cfg: StaffToolConfig = {
      duration: this.tool.duration, dotted: this.tool.dotted, accidental: this.tool.accidental,
      tupletMode: this.tool.tupletMode, chordMode: this.tool.chordMode,
    };
    if (staff === 'bass') this.bassTool = cfg; else this.trebleTool = cfg;
  }

  /** 把谱号配置恢复到 this.tool + 重建工具栏(让按钮高亮跟随)。 */
  private loadStaffConfig(staff: 'treble' | 'bass'): void {
    const cfg = staff === 'bass' ? this.bassTool : this.trebleTool;
    this.tool.duration = cfg.duration;
    this.tool.dotted = cfg.dotted;
    this.tool.accidental = cfg.accidental;
    this.tool.tupletMode = cfg.tupletMode;
    this.tool.chordMode = cfg.chordMode;
    this.rebuildToolbar();
  }

  /** 拖拽卡片:按住指示条 → 在原位留同高占位(防页面跳) + 卡片转 fixed 跟随鼠标 →
   *  鼠标越过另一卡中线时实时交换 DOM,另一卡用 FLIP 技术平滑滑动让位 → 松手归位。
   *  数据归属(treble/bass)不变,只换视觉排序。 */
  private startCardDrag(card: CardState, startY: number): void {
    if (this.cards.length < 2) return;
    const other = this.cards.find(c => c !== card);
    if (!other) return;
    const host = card.svgHost;
    const hostRect = host.getBoundingClientRect();
    const grabOffsetY = startY - hostRect.top;
    let lastMid = false;
    // 1) 原位占位:同高透明占位,撑住原位置(防页面高度跳变)
    const placeholder = document.createElement('div');
    placeholder.style.height = hostRect.height + 'px';
    placeholder.className = 'card-placeholder';
    host.parentNode!.insertBefore(placeholder, host);
    // 2) 卡片转 fixed 跟随(脱离流,占位顶替)
    host.classList.add('dragging');
    host.style.position = 'fixed';
    host.style.width = hostRect.width + 'px';
    host.style.left = hostRect.left + 'px';
    host.style.top = hostRect.top + 'px';
    host.style.zIndex = '50';
    host.style.pointerEvents = 'none';
    const onMove = (ev: MouseEvent) => {
      host.style.top = (ev.clientY - grabOffsetY) + 'px';
      const otherRect = other.svgHost.getBoundingClientRect();
      const otherMid = otherRect.top + otherRect.height / 2;
      const overMid = ev.clientY < otherMid;
      if (overMid !== lastMid) {
        lastMid = overMid;
        const stage = this.stageWrap;
        // FLIP 动画:记录另一卡交换前位置 → 移动 DOM → 算位移 → 反向 transform → 下帧归零
        const firstTop = other.svgHost.getBoundingClientRect().top;
        if (overMid) { stage.insertBefore(placeholder, other.svgHost); }
        else { stage.insertBefore(placeholder, other.svgHost.nextSibling); }
        const lastTop = other.svgHost.getBoundingClientRect().top;
        const dy = lastTop - firstTop;
        if (Math.abs(dy) > 0.5) {
          other.svgHost.style.transition = 'none';
          other.svgHost.style.transform = `translateY(${-dy}px)`;
          // 强制回流后开 transition 归零(FLIP 的 Play)
          void other.svgHost.offsetWidth;
          other.svgHost.style.transition = 'transform var(--anim-dur) var(--ease-out-cubic)';
          other.svgHost.style.transform = '';
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // 卡片归位:去掉 fixed,放回占位位置,然后移除占位
      host.style.position = '';
      host.style.width = '';
      host.style.left = '';
      host.style.top = '';
      host.style.zIndex = '';
      host.style.pointerEvents = '';
      host.classList.remove('dragging');
      stageWrap_insertAfter(host, placeholder);
      placeholder.remove();
      other.svgHost.style.transition = '';
      this.render();
    };
    const stageWrap_insertAfter = (el: Node, ref: Node) => {
      if (ref.parentNode) ref.parentNode.insertBefore(el, ref);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    void startY;
  }

  /** 切换激活卡(grand 模式)。保存旧谱号输入配置 + 恢复新谱号配置 +
   *  同步 piece.notes 指向新激活组 + 更新视觉。 */
  private setActiveCard(card: CardState): void {
    if (card === this.activeCard) return;
    // 保存当前谱号的输入配置,再加载目标谱号的(让工具栏按钮各自保留/恢复)
    if (this.activeCard) this.saveStaffConfig(this.activeCard.staff);
    this.activeCard = card;
    this.loadStaffConfig(card.staff);
    this.piece.notes = card.staff === 'bass' ? this.piece.bass : this.piece.treble;
    this.piece.clef = card.staff;
    this.hover = null;
    this.currentChordId = null;   // 切谱号时清掉和弦构建态(不同谱号的和弦不延续)
    this.tupletProgress = null;
    this.updateCardActiveVisual();
    this.render();
  }

  private lastPreviewMidi: number | null = null;
  private maybePreview(midi: number): void {
    if (!this.hoverSound) return;   // 默认关:只在用户开启时才 hover 试听
    if (this.lastPreviewMidi !== midi) {
      this.lastPreviewMidi = midi;
      this.player.preview(midi);
    }
  }

  private clearHover(): void {
    if (this.hover) { this.hover = null; this.render(); }
  }

  private toSvgCoords(e: MouseEvent, card: CardState): { x: number; y: number; ok: boolean } {
    const lay = card.layout;
    if (!lay) return { x: 0, y: 0, ok: false };
    // 用 svg 自身的 getBoundingClientRect(直接反映 svg 实际渲染位置,最准确)。
    const svg = card.svgHost.querySelector('svg');
    if (!svg) return { x: 0, y: 0, ok: false };
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * lay.width;
    const vbY0 = -lay.viewBoxYOffset;
    const y = ((e.clientY - rect.top) / rect.height) * lay.height + vbY0;
    return { x, y, ok: true };
  }

  private appendNoteWithPitch(midi: number): void {
    if (this.viewMode === 'preview') return;   // 预览只读
    const tuplet = this.computeTupletForNextNote();
    const note: Note = { midi, duration: this.tool.duration, dotted: this.tool.dotted, accidental: this.tool.accidental, tuplet };
    // 和弦模式:给音带上 chordId。若末尾音已是当前和弦组(首音),复用同 id → 这个音成为尾音(同时);
    // 否则生成新 id → 这个音成为新和弦首音。组内强制 duration 与首音一致(保证占一个时间位)。
    if (this.tool.chordMode) {
      const last = this.piece.notes[this.piece.notes.length - 1];
      if (last && last.chordId === this.currentChordId) {
        note.chordId = this.currentChordId!;
        note.duration = last.duration;   // 强制与组首音同时值
        note.dotted = last.dotted;
        // 尾音的 tuplet 也复用首音(一个和弦整体是一个时间位)
        note.tuplet = last.tuplet;
      } else {
        this.currentChordId = `chord-${++this.chordIdCounter}`;
        note.chordId = this.currentChordId;
      }
    }
    const ok = appendNote(this.piece, note);
    if (!ok) { this.flashOverfillRejected(); return; }
    this.advanceTupletProgress();
    this.afterEdit();
  }

  private appendRest(): void {
    if (this.viewMode === 'preview') return;   // 预览只读
    // 休止符占独立时间位,与和弦不兼容 → 输入休止时若在和弦模式,先关闭和弦(推进到新时间位)
    if (this.tool.chordMode) this.closeChordMode();
    const note: Note = { midi: null, duration: this.tool.duration, dotted: this.tool.dotted, accidental: null };
    const ok = appendNote(this.piece, note);
    if (!ok) { this.flashOverfillRejected(); return; }
    this.afterEdit();
  }

  /** 连音线(tie)动作:复制末尾音(同音高+同时值+同附点)追加进来,并自动在前后打 tieStart/tieEnd。
   *  - 单音:简单复制+配对
   *  - 和弦:复制整个和弦组(各声部),新组与旧组音高 multiset 天然全等 → 逐声部配对打 tie */
  private tieRepeat(): void {
    if (this.viewMode === 'preview') return;   // 预览只读
    const notes = this.piece.notes;
    if (notes.length === 0) { this.flash('前面没有可连音的音'); return; }
    // 和弦模式下的 tie 无意义(要在同时间位内延音)→ 先关闭
    if (this.tool.chordMode) this.closeChordMode();
    const last = notes[notes.length - 1];
    if (last.midi === null) { this.flash('前面是休止符,无法连音'); return; }
    // 找出末尾和弦组(若有)的范围 [start, end]
    let gStart = notes.length - 1;
    if (last.chordId) {
      while (gStart > 0 && notes[gStart - 1].chordId === last.chordId) gStart--;
    }
    const gEnd = notes.length - 1;
    // 逐声部复制:每个原音复制出一个新音(同 midi+duration+dotted+accidental),旧音打 tieStart、新音打 tieEnd
    // 复制的多个新音组成一个新和弦组(同 chordId),与原组一一对应
    const newGroupId = last.chordId ? `chord-${++this.chordIdCounter}` : undefined;
    for (let i = gStart; i <= gEnd; i++) {
      const src = notes[i];
      const dup: Note = {
        midi: src.midi,
        duration: src.duration,
        dotted: src.dotted,
        accidental: src.accidental,
        tuplet: src.tuplet,
        chordId: newGroupId,
        tieEnd: true,
      };
      const ok = appendNote(this.piece, dup);
      if (!ok) { this.flashOverfillRejected(); return; }
      src.tieStart = true;   // 源音作为 tie 起点
    }
    this.afterEdit();
  }

  /** 切换和弦模式开关(工具栏 chip / c 键)。开启后连续输入的音叠在同一时间位。
   *  关闭时,下个音不带 chordId → 新时间位。 */
  private onToggleChord(): void {
    if (!this.tool.chordMode) {
      // 关闭:清当前 chordId,下个音开新时间位
      this.currentChordId = null;
    }
    this.render();
  }

  /** 关闭和弦模式并同步 toolbar 高亮(内部用:休止/tie 等场景强制关闭) */
  private closeChordMode(): void {
    this.tool.chordMode = false;
    this.currentChordId = null;
    (this.toolsPanel as any)._setChordMode?.(false);
  }

  /** 计算下一个音的 tuplet 字段（若处于 tuplet 输入模式）。
   *  首个音时开新组（生成 groupId），返回 TupletInfo；非首音复用同 groupId。
   *  模式关闭或休止则返回 undefined。 */
  private computeTupletForNextNote(): Note['tuplet'] {
    const mode = this.tool.tupletMode;
    if (mode === 'off') return undefined;
    const cfg = TUPLET_CONFIG[mode];
    if (!this.tupletProgress) {
      // 开新组
      this.tupletProgress = {
        groupId: `tup-${++this.tupletIdCounter}`,
        count: 0,
        actual: cfg.actual,
        normal: cfg.normal,
      };
    }
    return { actual: this.tupletProgress.actual, normal: this.tupletProgress.normal, groupId: this.tupletProgress.groupId };
  }

  /** 输入一个音后推进 tuplet 进度：count++；达到 actual 则关闭模式、清进度。 */
  private advanceTupletProgress(): void {
    if (!this.tupletProgress) return;
    this.tupletProgress.count++;
    if (this.tupletProgress.count >= this.tupletProgress.actual) {
      // 组凑齐，关闭模式
      this.tupletProgress = null;
      this.tool.tupletMode = 'off';
      (this.toolsPanel as any)._setTupletMode?.('off');
    }
  }

  /** 切换连音组(tuplet)模式：点当前模式=关闭(off)；点其他模式=切换到该模式。
   *  切换/关闭时若当前组未凑齐，回滚这些已输入音的 tuplet 标记（避免不完整组），
   *  并清进度，下次开新组。 */
  private toggleTupletMode(mode: Exclude<TupletMode, 'off'>): void {
    const newMode = this.tool.tupletMode === mode ? 'off' : mode;
    if (newMode === 'off' && this.tupletProgress) {
      // 关闭且当前组未凑齐：回滚已输入音的 tuplet 标记
      const gid = this.tupletProgress.groupId;
      for (const n of this.piece.notes) {
        if (n.tuplet?.groupId === gid) n.tuplet = undefined;
      }
      this.tupletProgress = null;
    } else if (newMode !== 'off') {
      // 切到新模式：若当前有未凑齐组先回滚，再重置进度（下次首个音开新组）
      if (this.tupletProgress) {
        const gid = this.tupletProgress.groupId;
        for (const n of this.piece.notes) {
          if (n.tuplet?.groupId === gid) n.tuplet = undefined;
        }
        this.tupletProgress = null;
      }
    }
    this.tool.tupletMode = newMode;
    (this.toolsPanel as any)._setTupletMode?.(newMode);
    this.render();
  }

  /** appendNote 拒绝时给出精确提示：区分「整个谱写满」和「本小节放不下」 */
  private flashOverfillRejected(): void {
    if (remainingBeats(this.piece) < 1e-6) {
      this.flash(`已写满 ${this.piece.measureCount} 个小节`);
    } else {
      const rem = remainingBeatsInCurrentBar(this.piece);
      this.flash(rem < 1e-6 ? '本小节已满，请先删一个音符或换小节' : `本小节剩 ${rem.toFixed(2)} 拍，放不下此音符`);
    }
  }

  private afterEdit(): void {
    // 把范围视图 Piece 切回 score.measures(按小节拍边界),并标记 dirty 小节做 3 秒防抖落盘。
    this.syncRangePieceToScore();
    // 追加后重置一次性修饰（附点/升降/休止），符合行业惯例
    (this.toolsPanel as any)._resetModifiers?.();
    this.hover = null;
    this.syncPlayerAfterEdit();
    this.refreshMeasureSelector();   // 同步小节书签的内容指示点(输入/删除/连音后即时刷新)
    this.render();
  }

  /** 编辑后把范围视图 Piece 切回 this.score,并把范围内被改动的小节标记 dirty(3 秒防抖落盘)。
   *  切回后立即 rebuildRangePiece() 让 this.piece 重新指向 score 的最新数据(引用一致),
   *  避免 piece 与 score 脱节。 */
  private syncRangePieceToScore(): void {
    if (!this.score || !this.flusher) return;
    const start = this.currentStartMeasure;
    const count = this.piece.measureCount;
    // 切回前快照范围内旧小节,用于 dirty 对比(只落盘真正改动的小节)。
    const oldSnapshot: MeasureData[] = [];
    for (let i = start; i < start + count && i < this.score.meta.totalMeasures; i++) {
      const m = this.score.measures[i] || emptyMeasure();
      oldSnapshot.push({ treble: [...m.treble], bass: [...m.bass] });
    }
    pieceBackToScore(this.score, this.piece, start);
    // rebuildRangePiece 让 this.piece 重新指向 score 最新数据(保持引用一致)。
    // 注:此刻 viewMode/activeStaff 不变,直接复用。
    this.rebuildRangePiece();
    // 比对范围内各小节,改动则标记 dirty。
    for (let k = 0; k < count && start + k < this.score.meta.totalMeasures; k++) {
      const idx = start + k;
      const cur = this.score.measures[idx] || emptyMeasure();
      const old = oldSnapshot[k];
      if (!old || JSON.stringify(old) !== JSON.stringify(cur)) {
        this.flusher.markDirty(idx, { treble: cur.treble, bass: cur.bass });
      }
    }
  }

  /** 编辑（增删音）后同步 Player 的 schedule，避免播放头/高亮与新乐谱错位。
   *  - playing 态:按新 schedule 从当前 beat 无缝重调度；
   *  - paused 态:更新 schedule 与位置，播放头/高亮即时对齐（不发声）；
   *  - stopped 态:无需处理（下次 play 会重建 schedule）。
   *  当前 beat 夹在新 totalBeats 内，删除末音后不会越界。 */
  private syncPlayerAfterEdit(): void {
    if (this.playState === 'stopped') return;
    this.player.rebuildSchedule(this.piece);
    // currentBeat 与进度条/播放头对齐新的曲长
    this.currentBeat = this.player.getCurrentBeat();
    (this.playbackCard as any)._setProgress?.(this.currentBeat);
    this.updatePlayheadAndHighlight();
  }

  private onToolChange(): void {
    const oldTime = this.score ? `${this.score.meta.time.num}/${this.score.meta.time.den}` : `${this.piece.time.num}/${this.piece.time.den}`;
    const oldMeasureCount = this.piece.measureCount;
    const oldViewMode = this.viewMode;
    const oldKey = this.score ? this.score.meta.key.name : this.piece.key.name;
    const newTime = `${this.tool.time.num}/${this.tool.time.den}`;
    const newKey = this.tool.key;
    this.viewMode = this.tool.viewMode;

    // 调号/拍号变更:整曲级属性,更新 score.meta 并落盘。拍号变更会改变小节拍边界,
    // 故清空整曲所有小节(避免错位与节奏错乱)。
    if (this.score) {
      this.score.meta.key = KEYS[newKey];
      this.score.meta.time = { ...this.tool.time };
      this.score.meta.viewMode = this.tool.viewMode;
      // 同步 piece 视图的 key/time(rangeToPiece 会读 score.meta)。
      this.piece.key = this.score.meta.key;
      this.piece.time = this.score.meta.time;
      // 拍号变化:清空整曲小节(拍边界变了,旧音符会错位)。
      if (oldTime !== newTime) {
        for (let i = 0; i < this.score.meta.totalMeasures; i++) {
          this.score.measures[i] = emptyMeasure();
          if (this.flusher) this.flusher.markDirty(i, emptyMeasure());
        }
        this.currentStartMeasure = 0;
        this.playingIndex = -1;
        if (this.playState !== 'stopped') {
          this.player.stop();
          this.currentBeat = 0;
          this.playState = 'stopped';
          this.refreshCard();
        }
        // 异步落盘 meta(key/time/viewMode 改动)。
        void apiUpdateMeta(this.score.meta.id, {
          key: this.score.meta.key, time: this.score.meta.time, viewMode: this.score.meta.viewMode,
        }).catch(err => this.flash('保存设置失败:' + err.message));
      } else if (oldKey !== newKey || oldViewMode !== this.tool.viewMode) {
        // 仅调号/视图模式变:落盘 meta(不清音符)。
        void apiUpdateMeta(this.score.meta.id, {
          key: this.score.meta.key, viewMode: this.score.meta.viewMode,
        }).catch(err => this.flash('保存设置失败:' + err.message));
      }
    } else {
      // 无 score(内存模式):直接改 piece(向后兼容)。
      this.piece.key = KEYS[newKey];
      this.piece.time = { ...this.tool.time };
    }

    // 小节数(tool.measureCount)现在语义是「编辑区每行显示几个小节」(窗口大小),
    // 改它只重建范围视图(换显示哪几个),不清空、不动其它小节。
    if (oldMeasureCount !== this.tool.measureCount) {
      // 切窗口大小时先 flush 当前范围的改动,再重建。
      this.rebuildRangePiece();
      this.playingIndex = -1;
      if (this.playState !== 'stopped') {
        this.player.stop();
        this.currentBeat = 0;
        this.playState = 'stopped';
        this.refreshCard();
      }
    } else if (oldTime === newTime && this.score) {
      // key/viewMode 变了但 measureCount 没变:piece.key/time 已上面同步,这里确保 piece 视图刷新。
      this.rebuildRangePiece();
    }

    // 先保存当前谱号的输入配置(必须在 rebuildCards 之前,否则切模式时 loadStaffConfig
    // 读到的是旧配置),再重建卡片。数据(treble/bass 组)保留不清空。
    if (this.activeCard) this.saveStaffConfig(this.activeCard.staff);
    // 切视图模式:重建卡片布局(单卡↔双卡↔预览),重建时会 loadStaffConfig(新激活卡)
    if (oldViewMode !== this.viewMode) {
      this.rebuildCards();
    }
    // 窗口大小变了 → 书签条的 in-window 高亮范围变了,刷新 appbar。
    // 视图/调号/拍号也可能变了(toolbar 改),统一刷新 appbar(徽章 + 视图 active + 书签)。
    if (oldMeasureCount !== this.tool.measureCount || oldViewMode !== this.viewMode || oldKey !== newKey || oldTime !== newTime) {
      this.refreshEditorBar();
    }
    this.render();
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'SELECT' || tag === 'INPUT') return;
      // 预览模式只读:除空格(播放控制)外,禁止所有编辑类快捷键。
      if (this.viewMode === 'preview' && e.key !== ' ') return;
      switch (e.key) {
        case '1': this.changeDuration('whole'); break;
        case '2': this.changeDuration('half'); break;
        case '3': this.changeDuration('quarter'); break;
        case '4': this.changeDuration('eighth'); break;
        case '5': this.changeDuration('sixteenth'); break;
        case '6': this.changeDuration('thirtysecond'); break;
        case '.': this.tool.dotted = !this.tool.dotted; (this.toolsPanel as any)._resetModifiers?.(); this.render(); break;
        case 't': this.tieRepeat(); break;
        case 'c': this.toggleChordKey(); break;
        case 'r': this.toggleTupletMode('triplet'); break;
        case 'f': this.toggleTupletMode('quintuplet'); break;
        case 'x': this.toggleTupletMode('sextuplet'); break;
        case '0': this.appendRest(); break;
        case 'Backspace': this.deleteLastNote(); e.preventDefault(); break;
        case ' ': this.togglePlay(); e.preventDefault(); break;
      }
    });
  }

  /** 切换时值:同步工具栏高亮。在和弦模式中途换时值 → 关闭和弦(避免组内时值不一致) */
  private changeDuration(d: DurationValue): void {
    this.tool.duration = d;
    this.syncToolbarDurations();
  }

  /** c 键切换和弦模式:与工具栏 chip 共用同一开关逻辑 */
  private toggleChordKey(): void {
    this.tool.chordMode = !this.tool.chordMode;
    (this.toolsPanel as any)._setChordMode?.(this.tool.chordMode);
    this.onToggleChord();
  }

  /** 删除末尾音符(短信验证码式 backspace),并修正 tuplet/chord 状态。
   *  tuplet 修复(两个场景):
   *  - 输入中删除:回退 tupletProgress.count,让用户继续补齐该组
   *  - 完成后删除:组变残缺,重新进入该组输入模式(恢复 tupletProgress + toolbar 高亮),
   *    让用户补齐;若组删空则关闭模式
   *  chord:currentChordId 不在末尾时清掉避免误复用 */
  private deleteLastNote(): void {
    if (this.viewMode === 'preview') return;   // 预览只读
    const notes = this.piece.notes;
    if (notes.length === 0) return;
    // 抓删除前的末音(判断是否属于 tuplet 组)
    const removed = notes[notes.length - 1];
    const removedTup = removed.tuplet;
    popNote(this.piece);

    // tuplet 状态修正
    if (removedTup) {
      const gid = removedTup.groupId;
      // 组内剩余音数(同 groupId 且仍带 tuplet 标记)
      const remainInGroup = notes.filter(n => n.tuplet?.groupId === gid);

      if (remainInGroup.length === 0) {
        // 组删空:清模式 + 进度,toolbar 复位
        this.tupletProgress = null;
        this.tool.tupletMode = 'off';
        (this.toolsPanel as any)._setTupletMode?.('off');
      } else {
        // 组还有残音:恢复/回退 tupletProgress,让用户继续补齐
        const mode = tupletModeForActual(removedTup.actual);
        if (mode) {
          this.tool.tupletMode = mode;
          this.tupletProgress = {
            groupId: gid,
            count: remainInGroup.length,   // 已输入 = 剩余音数
            actual: removedTup.actual,
            normal: removedTup.normal,
          };
          (this.toolsPanel as any)._setTupletMode?.(mode);
        }
      }
    }

    // chord 状态修正(用户习惯:1残音也能补,都删干净才关模式):
    // 删除的和弦尾音,若组还有残音(哪怕只剩1个)→ 保留 currentChordId + 和弦模式,可继续补;
    // 组全删空 → 才关模式。剩1音时保留 chordId(它是和弦首音,继续补会成为完整和弦)。
    const removedChord = removed.chordId;
    if (removedChord) {
      const remainInChord = notes.filter(n => n.chordId === removedChord);
      if (remainInChord.length === 0) {
        // 组删空:才关模式
        this.currentChordId = null;
        this.tool.chordMode = false;
        (this.toolsPanel as any)._setChordMode?.(false);
      } else {
        // 还有残音(含只剩1个):恢复 currentChordId + 开和弦模式,可继续补声部。
        // 此时 nextSlot 锁回和弦首音位置(chordAnchor),指示器叠在和弦起始位,符合「继续补这个和弦」直觉。
        this.currentChordId = removedChord;
        this.tool.chordMode = true;
        (this.toolsPanel as any)._setChordMode?.(true);
      }
    } else {
      // 删的是普通音(非和弦成员):绝不恢复和弦模式。
      // 即使新末音属于某个已完成的和弦(如 (123) 1 删 1 后末音是 (123) 成员),
      // 该和弦已完成,用户在和弦之外编辑,nextSlot 应在该和弦之后(关模式)。
      // 只有「删和弦成员本身」(上面 removedChord 非空分支)才进入和弦编辑模式。
      this.currentChordId = null;
      if (this.tool.chordMode) {
        this.tool.chordMode = false;
        (this.toolsPanel as any)._setChordMode?.(false);
      }
    }
    // 删除后走与输入相同的同步路径:syncRangePieceToScore(把 piece 切回 score +
    // markDirty 落盘)+ syncPlayerAfterEdit + render。否则只 pop 了 piece.notes,
    // score.measures 未更新,一旦 rebuildRangePiece(切范围/视图/谱号等)被删音会复活。
    this.afterEdit();
  }

  /** 键盘改了 duration 后，把工具栏高亮同步过来 */
  private syncToolbarDurations(): void {
    const btns = this.toolbar.querySelectorAll<HTMLButtonElement>('.chip[data-dur]');
    btns.forEach(b => b.classList.toggle('active', b.dataset.dur === this.tool.duration));
    this.render();
  }

  private togglePlay(): void {
    if (this.piece.notes.length === 0) return;       // 空乐谱不播
    const s = this.playState;
    if (s === 'playing') {
      this.player.pause();
    } else if (s === 'paused') {
      this.player.resume();
    } else {
      this.player.setBpm(this.bpm);
      // 停止态:若已 seek 到中段(currentBeat>0),从 seek 处播放;否则从头。
      this.player.play(this.piece, this.currentBeat);
    }
  }

  /** ⏮ 回到起点：播放中→从头播；暂停/停止→归零并停在停止态 */
  private restart(): void {
    this.player.stop();
    this.playingIndex = -1;
    this.currentBeat = 0;
    this.playState = 'stopped';
    this.refreshCard();
    this.render();
  }

  /** seek:播放中→从该 beat 继续(重调度);暂停→定位保持暂停(不发声,但编辑区播放头/高亮同步);
   *  停止→记录 currentBeat 供下次播放参考(停止态不显示播放头,但记录位置)。
   *  关键:播放/暂停态都调 updatePlayheadAndHighlight,确保编辑区播放头+高亮同步(修复「暂停态 seek 不同步」)。 */
  private seek(beat: number): void {
    this.currentBeat = beat;
    if (this.playState === 'playing') {
      this.player.setBpm(this.bpm);
      this.player.seek(beat, true);
      // playing 态:onTick 会持续驱动,但 seek 瞬间补一次即时定位(避免等下一帧)
      this.updatePlayheadAndHighlight();
    } else if (this.playState === 'paused') {
      this.player.seek(beat, false);
      (this.playbackCard as any)._setProgress?.(beat);
      this.updatePlayheadAndHighlight();
    } else {
      // 停止态:记录位置,进度条同步显示。预览模式下也更新播放头(停止态 seek 定位指示)。
      (this.playbackCard as any)._setProgress?.(beat);
      if (this.viewMode === 'preview') this.updatePlayheadAndHighlight();
    }
  }

  /** BPM 变化：更新值，播放中无缝变速（重调度） */
  private changeBpm(bpm: number): void {
    this.bpm = bpm;
    this.player.setBpm(bpm);
    if (this.playState === 'playing') {
      const beat = this.player.getCurrentBeat();
      this.player.seek(beat, true);
    }
    this.refreshCard();
  }

  /** 构造给卡片的视图快照 */
  private playbackView(): PlaybackView {
    // totalBeats 统一用 totalBeatsBoth(两组 max),与 player.getTotalBeats() 一致。
    // playingIndexTreble/Bass:两组各自当前播放索引(键盘高亮用,与活跃组无关)。
    const playing = this.playState !== 'stopped';
    return {
      piece: this.piece,
      playState: this.playState,
      bpm: this.bpm,
      currentBeat: playing ? this.currentBeat : 0,
      totalBeats: totalBeatsBoth(this.piece),
      playingIndex: this.playingIndex,
      playingIndexTreble: playing ? this.player.noteIndexAtBeatStaff(this.currentBeat, 'treble') : -1,
      playingIndexBass: playing ? this.player.noteIndexAtBeatStaff(this.currentBeat, 'bass') : -1,
      fingering: this.fingering,
      show: this.show,
    };
  }

  private refreshCard(): void {
    (this.playbackCard as any)._refresh?.();
  }

  private clear(): void {
    if (this.viewMode === 'preview') return;   // 预览只读
    if (this.score) {
      // 清空当前范围(编辑区显示的几个小节)的音符,标记 dirty 落盘。其它小节保留。
      const start = this.currentStartMeasure;
      for (let i = start; i < start + this.tool.measureCount && i < this.score.meta.totalMeasures; i++) {
        this.score.measures[i] = emptyMeasure();
        if (this.flusher) this.flusher.markDirty(i, emptyMeasure());
      }
      this.rebuildRangePiece();
    } else {
      this.piece = createPiece();
      this.piece.key = KEYS[this.tool.key];
      this.piece.time = { ...this.tool.time };
      this.piece.measureCount = this.tool.measureCount;
    }
    this.playingIndex = -1;
    if (this.playState !== 'stopped') { this.player.stop(); this.currentBeat = 0; this.playState = 'stopped'; }
    this.rebuildCards();
    this.refreshMeasureSelector();   // 同步小节书签的内容指示点(清空后点点熄灭)
    this.render();
  }

  private loadExample(): void {
    // 小星星示例填到当前范围(tool.measureCount 个小节)。示例是单组 treble 旋律。
    const ex = twinkleExample(this.tool.measureCount);
    if (this.score) {
      const start = this.currentStartMeasure;
      for (let i = 0; i < this.tool.measureCount && start + i < this.score.meta.totalMeasures; i++) {
        // 示例按小节铺:第 i 小节的音符 = 示例在第 i 小节拍范围内的音。
        this.score.measures[start + i] = { treble: [], bass: [] };
      }
      // 示例 notes 是连续的,需按小节拍边界切分铺到范围内各小节。
      const fakePiece = ex;
      pieceBackToScore(this.score, fakePiece, start);
      // 标记范围内各小节 dirty。
      for (let i = start; i < start + this.tool.measureCount && i < this.score.meta.totalMeasures; i++) {
        const m = this.score.measures[i] || emptyMeasure();
        if (this.flusher) this.flusher.markDirty(i, { treble: m.treble, bass: m.bass });
      }
      this.rebuildRangePiece();
    } else {
      this.piece = ex;
      this.piece.key = KEYS[this.tool.key];
      this.piece.time = { ...this.tool.time };
      this.piece.measureCount = this.tool.measureCount;
    }
    this.rebuildCards();
    this.rebuildToolbar();
    this.render();
  }

  private rebuildToolbar(): void {
    const old = this.toolbar;
    this.toolbar = this.buildToolsPanelEl();
    old.replaceWith(this.toolbar);
  }

  /** 构建工具盘 el(buildToolsPanel)+ 挂载 MeasureSelector 到第三行宿主。
   *  rebuildToolbar/buildDOM 共用:每次重建工具盘都重建 MS 实例(状态由 refresh 注入)。 */
  private buildToolsPanelEl(): HTMLElement {
    this.msHandle = null;
    // 直接传 this.tool 引用:toolsPanel 改 duration/key/time 等会同步到 this.tool,
    // onToolChange 读 this.tool 即正确值(与原 toolbar 一致)。
    const panel = buildToolsPanel(this.tool, {
      onChange: () => this.onToolChange(),
      onRest: () => this.appendRest(),
      onTie: () => this.tieRepeat(),
      onToggleChord: () => this.onToggleChord(),
      onChangeViewMode: (v) => this.changeViewMode(v),
    });
    this.toolsPanel = panel;
    // 挂 MeasureSelector 到第三行宿主。
    const total = this.score?.meta.totalMeasures ?? 0;
    this.msHandle = buildMeasureSelector(
      { totalMeasures: total, start: this.currentStartMeasure, count: this.tool.measureCount, hasContent: this.measureHasContent() },
      {
        onChange: (start, count) => this.onMeasureSelectorChange(start, count),
        onDeleteMeasure: (idx) => void this.deleteMeasureAt(idx),
        onAddMeasure: () => void this.addMeasureAtEnd(),
      },
    );
    panel.measuresHost.appendChild(this.msHandle.el);
    this.updateRangeHint();
    return panel.el;
  }

  /** 更新工具盘「第 X–Y 小节」范围提示。 */
  private updateRangeHint(): void {
    if (!this.score || !this.editRangeEl) return;
    const start = this.currentStartMeasure;
    const count = Math.min(this.tool.measureCount, this.score.meta.totalMeasures - start);
    this.editRangeEl.innerHTML = `第 <b>${start + 1}–${start + count}</b> 小节`;
  }

  /** 切换 edit-toolbar 右侧内容:编辑模式显示退格/清空,预览模式显示 五线谱/简谱/两者 radio。
   *  在 rebuildCards(切模式)和 render(预览态 radio active 同步)后调用。 */
  private syncEditToolbar(): void {
    const isPreview = this.viewMode === 'preview';
    this.editActionsEl?.classList.toggle('hidden', isPreview);
    this.previewRadioEl?.classList.toggle('hidden', !isPreview);
  }

  /** MeasureSelector onChange:更新编辑区范围视图 + 轻量重渲(保留 MS 实例,不重建工具盘)。
   *  仅当 start/count 实际变化时才 rebuildCards + render(避免拖拽回弹/范围未变时无谓重建触发动画)。 */
  private onMeasureSelectorChange(start: number, count: number): void {
    if (!this.score) return;
    // 预览模式:允许切换小节范围(刷新预览区),但不触发 flush / 编辑状态清理(预览只读)。
    if (this.viewMode === 'preview') {
      const prevStart = this.currentStartMeasure;
      const prevCount = this.tool.measureCount;
      this.currentStartMeasure = start;
      this.tool.measureCount = count;
      if (start === prevStart && count === prevCount) return;   // 范围未变
      this.player.stop();
      this.playingIndex = -1;
      this.currentBeat = 0;
      this.playState = 'stopped';
      this.rebuildRangePiece();
      this.updateRangeHint();
      this.render();
      return;
    }
    void this.flusher?.flush();
    const prevStart = this.currentStartMeasure;
    const prevCount = this.tool.measureCount;
    this.currentStartMeasure = start;
    this.tool.measureCount = count;
    // start/count 未变(如拖拽回弹到原位、选框范围没变):只更新范围提示,不重建卡片。
    if (start === prevStart && count === prevCount) {
      this.updateRangeHint();
      return;
    }
    this.player.stop();
    this.playingIndex = -1;
    this.currentBeat = 0;
    this.playState = 'stopped';
    this.hover = null;
    this.currentChordId = null;
    this.tupletProgress = null;
    this.rebuildRangePiece();
    this.rebuildCards();
    this.updateRangeHint();
    this.render();
  }

  /** MeasureSelector onAddMeasure:末尾加空小节 + 落盘 + MS.refresh(新书签进场动画)。 */
  private async addMeasureAtEnd(): Promise<void> {
    if (this.viewMode === 'preview') return;   // 预览只读
    if (!this.score) return;
    if (this.score.meta.totalMeasures >= 256) { this.flash('已达最大小节数 256'); return; }
    try {
      const newTotal = this.score.meta.totalMeasures + 1;
      const meta = await apiUpdateMeta(this.score.meta.id, { totalMeasures: newTotal });
      this.score.meta = meta;
      this.score.measures.push(emptyMeasure());
      this.pieces = this.pieces.map(p => p.id === meta.id ? meta : p);
      this.rebuildRangePiece();
      this.refreshMeasureSelector();
      this.updateRangeHint();
      this.render();
    } catch (err) {
      this.flash('加小节失败:' + (err as Error).message);
    }
  }

  /** MeasureSelector onDeleteMeasure:删该小节音 + totalMeasures-1 + 落盘 + clamp + MS.refresh。 */
  private async deleteMeasureAt(idx: number): Promise<void> {
    if (this.viewMode === 'preview') return;   // 预览只读
    if (!this.score) return;
    if (this.score.meta.totalMeasures <= 1) { this.flash('至少保留 1 小节'); return; }
    const m = this.score.measures[idx];
    const hasContent = m && (m.treble.length > 0 || m.bass.length > 0);
    if (hasContent && !confirm(`删除第 ${idx + 1} 小节(含 ${m.treble.length + m.bass.length} 个音符)?后续小节前移。`)) return;
    try {
      // 删该小节:splice,然后 totalMeasures-1。各小节内容前移(已 splice)。落盘:删尾 + 后续小节重排需逐个 PUT。
      this.score.measures.splice(idx, 1);
      const newTotal = this.score.meta.totalMeasures - 1;
      const meta = await apiUpdateMeta(this.score.meta.id, { totalMeasures: newTotal });
      this.score.meta = meta;
      // 落盘被影响的小节(idx 之后的所有小节内容都前移了)。逐个 PUT(并发乱序,顺序 await)。
      for (let i = idx; i < newTotal; i++) {
        const mm = this.score.measures[i] || emptyMeasure();
        await putMeasure(this.score.meta.id, i, { treble: mm.treble, bass: mm.bass });
      }
      this.pieces = this.pieces.map(p => p.id === meta.id ? meta : p);
      // clamp start/count
      this.currentStartMeasure = Math.min(this.currentStartMeasure, Math.max(0, newTotal - this.tool.measureCount));
      this.tool.measureCount = Math.min(this.tool.measureCount, newTotal);
      this.tool.measureCount = Math.max(1, this.tool.measureCount);
      this.rebuildRangePiece();
      this.refreshMeasureSelector();
      this.updateRangeHint();
      this.render();
    } catch (err) {
      this.flash('删小节失败:' + (err as Error).message);
    }
  }

  /** 刷新 MeasureSelector 状态(保留实例,触发书签增删动画)。 */
  private refreshMeasureSelector(): void {
    if (!this.score || !this.msHandle) return;
    this.msHandle.refresh({
      totalMeasures: this.score.meta.totalMeasures,
      start: this.currentStartMeasure,
      count: this.tool.measureCount,
      hasContent: this.measureHasContent(),
    });
  }

  private async doExport(): Promise<void> {
    const card = this.activeCard ?? this.cards[0];
    if (!card || !card.layout) { this.flash('无可导出的乐谱'); return; }
    try { await exportPNG(card.pieceView, card.layout); this.flash('已导出 PNG'); }
    catch (err) { this.flash('导出失败：' + (err as Error).message); }
  }

  private flashTimer: number | undefined;
  private flash(msg: string): void {
    this.statusTextEl.textContent = msg;
    this.statusEl.classList.add('show', 'flash');
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => { this.statusEl.classList.remove('show', 'flash'); this.render(); }, 1600);
  }

  /** 渲染所有卡片 + 刷新状态栏/播放头。遍历 cards 调 renderCard。 */
  private render(): void {
    // 曲谱库一级页:不渲染编辑器(避免操作隐藏 DOM、白跑 rAF)。库自渲染。
    if (this.appView === 'library') return;
    // 预览模式:单独渲染双谱表预览卡,不走常规卡片流程
    if (this.viewMode === 'preview') {
      this.renderPreview();
      // 刷新预览 radio 的 active 状态(radio 在 edit-toolbar 内,onclick 只调 render
      // 不重建 radio → 切换后 active 停留旧值。此处每次 render 同步一次 active class)。
      this.previewRadioEl?.querySelectorAll('.seg-btn').forEach((btn, i) => {
        const modes = ['staff', 'jianpu', 'both'] as const;
        btn.classList.toggle('active', modes[i] === this.previewMode);
      });
      const total = this.piece.treble.length + this.piece.bass.length;
      const rem = remainingBeats(this.piece);
      const pct = Math.round((totalBeats(this.piece) / capacityBeats(this.piece)) * 100);
      this.statusTextEl.textContent = total + ' \u4e2a\u97f3\u7b26 \u00b7 \u5df2\u7528 ' + pct + '% \u00b7 \u9884\u89c8\u6a21\u5f0f';
      (this.toolsPanel as any)._refreshCapacity?.(remainingBeatsInCurrentBar(this.piece), rem);
      this.refreshCard();
      return;
    }
    // 同步每个 card 的 pieceView(切组/编辑后 piece 变了,pieceView 要重建)
    for (const c of this.cards) {
      const notes = c.staff === 'bass' ? this.piece.bass : this.piece.treble;
      c.pieceView = { ...this.piece, clef: c.staff, notes };
    }
    for (const c of this.cards) this.renderCard(c);
    // 状态栏(全局:两组音符总数)
    const total = this.piece.treble.length + this.piece.bass.length;
    const rem = remainingBeats(this.piece);
    const pct = Math.round((totalBeats(this.piece) / capacityBeats(this.piece)) * 100);
    this.statusTextEl.textContent = total + ' \u4e2a\u97f3\u7b26 \u00b7 \u5df2\u7528 ' + pct + '% \u00b7 \u8fd8\u80fd\u518d\u5199\u7ea6 ' + rem.toFixed(1) + ' \u62cd';
    (this.toolsPanel as any)._refreshCapacity?.(remainingBeatsInCurrentBar(this.piece), rem);
    this.refreshCard();
    this.updatePlayheadAndHighlight();
  }

  /** 渲染单卡片(高度动画 + SVG 重建 + 增删动画)。原 render() 的单卡逻辑,参数化为 card。 */
  private renderCard(card: CardState): void {
    const piece = card.pieceView;
    const width = Math.min(1200, Math.max(640, card.svgHost.clientWidth || 940));
    // 和弦输入中:nextSlot 锁定在当前和弦组首音起点(仅激活卡的和弦模式)
    let chordAnchor: number | undefined;
    let chordAnchorDur: DurationValue | undefined;
    if (card === this.activeCard && this.tool.chordMode && this.currentChordId) {
      const notes = piece.notes;
      const firstIdx = notes.findIndex(n => n.chordId === this.currentChordId);
      if (firstIdx >= 0) {
        chordAnchor = noteStartBeats(piece)[firstIdx];
        chordAnchorDur = notes[firstIdx].duration;
      }
    }
    const isCardActive = card === this.activeCard;
    const cardHover = isCardActive ? this.hover : null;
    card.layout = computeLayout(piece, width, this.tool.duration, chordAnchor, chordAnchorDur);
    const lay = card.layout;
    const oldLayout = card.lastLayout ?? lay;
    const off = lay.viewBoxYOffset;
    const offDelta = off - oldLayout.viewBoxYOffset;
    const jpDelta = lay.jianpuBaseline - oldLayout.jianpuBaseline;
    const jpExpand = (lay.jianpuBottom - lay.jianpuTop) - (oldLayout.jianpuBottom - oldLayout.jianpuTop);
    const prevStaffYScreen = this.measureStaffYScreen(card);
    const prevScrollY = window.scrollY;
    const startH = parseFloat(card.svgHost.style.height) || (lay.height + 16);
    const noteDelta = isCardActive ? (piece.notes.length - card.lastNoteCount) : 0;
    const oldNextSlotX = card.lastLayout ? card.lastLayout.nextSlotX : null;
    const oldSvgEl = card.svgHost.querySelector('svg') as SVGSVGElement | null;
    const svg = buildSVG(piece, lay, isCardActive ? this.playingIndex : -1, { hover: cardHover });
    card.svgHost.innerHTML = svg;
    const svgEl = card.svgHost.querySelector('svg') as SVGSVGElement | null;
    if (svgEl) {
      svgEl.setAttribute('width', '100%');
      svgEl.setAttribute('height', String(lay.height));
      svgEl.setAttribute('preserveAspectRatio', 'none');
    }
    const jg = card.svgHost.querySelector('.jianpu-group') as SVGGElement | null;
    const endH = lay.height + 16;

    const finalizeCard = () => {
      card.svgHost.appendChild(card.playheadLayer);
      // 双卡模式重挂拖拽指示条(innerHTML 替换会清掉它)
      if (this.viewMode === 'grand' && !card.svgHost.querySelector('.drag-handle')) {
        const handle = document.createElement('div');
        handle.className = 'drag-handle';
        handle.title = '拖拽交换顺序';
        handle.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault(); e.stopPropagation();
          this.startCardDrag(card, e.clientY);
        });
        card.svgHost.appendChild(handle);
      }
    };

    // 首次初始化:锁定屏幕锚点
    if (card.staffAnchorScreen === null) {
      card.svgHost.style.height = endH + 'px';
      if (svgEl) svgEl.style.transform = '';
      if (jg) jg.style.transform = '';
      card.staffAnchorScreen = this.measureStaffYScreen(card);
      card.lastLayout = lay;
      card.lastNoteCount = piece.notes.length;
      card.lastBeamGroups = computeBeams(piece).map(g => ({ startIdx: g.startIdx, endIdx: g.endIdx }));
      finalizeCard();
      return;
    }

    if (Math.abs(endH - startH) < 1) {
      card.svgHost.style.height = endH + 'px';
      if (svgEl) svgEl.style.transform = '';
      if (jg) jg.style.transform = '';
      card.lastLayout = lay;
      finalizeCard();
      if (isCardActive) this.applyNoteAnim(card, noteDelta, oldNextSlotX, oldSvgEl, svgEl, false);
      card.lastNoteCount = piece.notes.length;
      card.lastBeamGroups = computeBeams(piece).map(g => ({ startIdx: g.startIdx, endIdx: g.endIdx }));
      return;
    }

    // 统一动画:三路同步插值
    const targetScreen = Math.round(prevStaffYScreen);
    card.staffAnchorScreen = targetScreen;
    const hostTopDoc = card.svgHost.getBoundingClientRect().top + window.scrollY;
    const T0 = offDelta !== 0 ? (targetScreen - hostTopDoc + prevScrollY - 121 - off) : 0;
    const jpT0 = -jpDelta;
    card.svgHost.style.height = startH + 'px';
    if (svgEl) svgEl.style.transform = 'translateY(' + T0 + 'px)';
    if (jg) jg.style.transform = 'translateY(' + jpT0 + 'px)';
    if (card.heightAnimFrame) cancelAnimationFrame(card.heightAnimFrame);
    const startT = performance.now();
    card.heightAnimFrame = requestAnimationFrame((now: number) => {
      this.heightTick(card, now, startT, startH, endH, T0, jpT0, prevScrollY, offDelta, jpExpand, svgEl, jg);
    });
    card.lastLayout = lay;
    finalizeCard();
    if (isCardActive) this.applyNoteAnim(card, noteDelta, oldNextSlotX, oldSvgEl, svgEl, true);
    card.lastNoteCount = piece.notes.length;
    card.lastBeamGroups = computeBeams(piece).map(g => ({ startIdx: g.startIdx, endIdx: g.endIdx }));
  }

  /** 测量某卡五线谱 bottomLineY 当前屏幕 y(高度动画锚定) */
  private measureStaffYScreen(card: CardState): number {
    const svg = card.svgHost.querySelector('svg');
    if (!svg) return 0;
    const sr = svg.getBoundingClientRect();
    const vb = (svg as SVGSVGElement).viewBox.baseVal;
    return Math.round(sr.top + (121 - vb.y) * sr.height / vb.height);
  }

  /** 收集 lastIdx 所在连梁组的所有元素(供新音加入连梁组时整组刷新)。
   *  和弦尾音不在 BeamGroup(computeBeams 跳过 tail),需往前找同 chordId 的首音定位组。
   *  返回 {grp, beams, noteEls}:grp=组范围;beams=组内梁 polygon;noteEls=组内所有音符元素。
   *  grp=null 表示 lastIdx 不在任何连梁组里(非连梁时值或孤立音)。 */
  private collectBeamGroupEls(card: CardState, lastIdx: number): { grp: { startIdx: number; endIdx: number } | null; beams: SVGElement[]; noteEls: SVGElement[] } {
    const notes = card.pieceView.notes;
    let probeIdx = lastIdx;
    const last = notes[lastIdx];
    if (last?.chordId) {
      for (let i = lastIdx; i >= 0; i--) {
        if (notes[i].chordId === last.chordId && !(i > 0 && notes[i - 1].chordId === last.chordId)) {
          probeIdx = i; break;
        }
      }
    }
    const groups = computeBeams(card.pieceView);
    const grp = indexBeamMap(groups).get(probeIdx);
    if (!grp) return { grp: null, beams: [], noteEls: [] };
    const beams = Array.from(card.svgHost.querySelectorAll(`.beam-grp-${grp.startIdx}`)) as SVGElement[];
    const noteEls: SVGElement[] = [];
    for (let i = grp.startIdx; i <= grp.endIdx; i++) {
      noteEls.push(...Array.from(card.svgHost.querySelectorAll(`[data-idx="${i}"]`)) as SVGElement[]);
    }
    return { grp: { startIdx: grp.startIdx, endIdx: grp.endIdx }, beams, noteEls };
  }

  /** 从旧 svg 克隆「变化的连梁组」的老内容(梁 polygon + 组内音符),挂到 staff-group 做残影淡出。 */
  private cloneOldBeamGhost(card: CardState, oldSvgEl: SVGSVGElement | null): SVGElement[] {
    if (!oldSvgEl || !card.lastBeamGroups.length) return [];
    const staffGroup = card.svgHost.querySelector('.staff-group') as SVGGElement | null;
    if (!staffGroup) return [];
    const oldStaff = oldSvgEl.querySelector('.staff-group');
    if (!oldStaff) return [];
    const idxSet = new Set<number>();
    for (const g of card.lastBeamGroups) {
      for (let i = g.startIdx; i <= g.endIdx; i++) idxSet.add(i);
    }
    const sel: string[] = [`[class*="beam-grp-"]`];
    for (const i of idxSet) sel.push(`[data-idx="${i}"]`);
    const oldEls = Array.from(oldStaff.querySelectorAll(sel.join(','))) as SVGElement[];
    if (!oldEls.length) return [];
    const clones: SVGElement[] = [];
    for (const el of oldEls) {
      const c = el.cloneNode(true) as SVGElement;
      c.classList.add('beam-ghost');
      staffGroup.appendChild(c);
      clones.push(c);
    }
    return clones;
  }

  /** 增删音过渡动画注入(innerHTML 替换后调用,仅激活卡)。 */
  private applyNoteAnim(
    card: CardState, noteDelta: number, oldNextSlotX: number | null,
    oldSvgEl: SVGSVGElement | null, newSvgEl: SVGSVGElement | null,
    heightChanging: boolean,
  ): void {
    const piece = card.pieceView;
    // 删除:克隆旧 svg 残影淡出。高度变化时跳过
    if (noteDelta < 0 && oldSvgEl && !heightChanging) {
      const ghost = oldSvgEl.cloneNode(true) as SVGSVGElement;
      ghost.classList.add('fade-ghost');
      ghost.removeAttribute('width'); ghost.removeAttribute('height');
      ghost.setAttribute('width', '100%');
      card.svgHost.appendChild(ghost);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { ghost.classList.add('fade-ghost-out'); });
      });
      const removeGhost = () => { ghost.remove(); };
      ghost.addEventListener('transitionend', removeGhost, { once: true });
      window.setTimeout(removeGhost, 200);
    }

    if (noteDelta > 0 && newSvgEl) {
      const lastIdx = piece.notes.length - 1;
      const els = Array.from(card.svgHost.querySelectorAll(`[data-idx="${lastIdx}"]`)) as SVGElement[];
      const lastNote = piece.notes[lastIdx];
      const tieEls = lastNote?.tieEnd
        ? Array.from(card.svgHost.querySelectorAll('.tie-elem')) as SVGElement[]
        : [];
      const beam = this.collectBeamGroupEls(card, lastIdx);
      const jumpEls = beam.grp ? [...beam.noteEls, ...beam.beams] : els;
      const hoverLinkEls = els;
      const hoverSet = new Set<SVGElement>(els);
      const fadeInEls = [...tieEls, ...beam.beams, ...beam.noteEls].filter(el => !hoverSet.has(el as SVGElement));
      const oldBeamEls = (beam.grp && beam.beams.length)
        ? this.cloneOldBeamGhost(card, oldSvgEl)
        : [];

      hoverLinkEls.forEach(el => { el.style.opacity = '0.55'; });
      fadeInEls.forEach(el => { el.style.opacity = '0'; });
      const AMP = 4;
      if (this.noteAnimFrame) cancelAnimationFrame(this.noteAnimFrame);
      const noteStart = performance.now();
      const noteTick = (now: number) => {
        const t = Math.min(1, (now - noteStart) / 120);
        const eased = 1 - Math.pow(1 - t, 3);
        const ty = -AMP * Math.sin(t * Math.PI);
        const linkOp = 0.55 + 0.45 * eased;
        const fadeInOp = eased;
        const fadeOutOp = 1 - eased;
        hoverLinkEls.forEach(el => { el.style.opacity = String(linkOp); });
        fadeInEls.forEach(el => { el.style.opacity = String(fadeInOp); });
        oldBeamEls.forEach(el => { el.style.opacity = String(fadeOutOp); });
        jumpEls.forEach(el => { el.style.transform = ty !== 0 ? `translateY(${ty.toFixed(2)}px)` : ''; });
        if (t < 1) {
          this.noteAnimFrame = requestAnimationFrame(noteTick);
        } else {
          this.noteAnimFrame = null;
          hoverLinkEls.forEach(el => { el.style.opacity = ''; });
          jumpEls.forEach(el => { el.style.transform = ''; });
          fadeInEls.forEach(el => { el.style.opacity = ''; });
          oldBeamEls.forEach(el => { el.remove(); });
        }
      };
      this.noteAnimFrame = requestAnimationFrame(noteTick);
    }

    // 指示器平移:nextSlot 从旧位 slide 到新位
    const lay = card.layout;
    const slot = card.svgHost.querySelector('.next-slot') as SVGRectElement | null;
    if (slot && oldNextSlotX !== null && lay && !lay.isFull) {
      const dx = lay.nextSlotX - oldNextSlotX;
      if (Math.abs(dx) > 0.5) {
        slot.style.animation = 'none';
        slot.style.transform = `translateX(${-dx}px)`;
        if (this.slotAnimFrame) cancelAnimationFrame(this.slotAnimFrame);
        const slideStart = performance.now();
        const slideTick = (now: number) => {
          const t = Math.min(1, (now - slideStart) / 120);
          const eased = 1 - Math.pow(1 - t, 3);
          slot.style.transform = `translateX(${-dx * (1 - eased)}px)`;
          if (t < 1) {
            this.slotAnimFrame = requestAnimationFrame(slideTick);
          } else {
            this.slotAnimFrame = null;
            slot.style.transform = '';
            slot.style.animation = '';
          }
        };
        this.slotAnimFrame = requestAnimationFrame(slideTick);
      }
    }
  }

  /** 高度动画单帧:三路开环同步插值(与测试页 dev=0 方案完全一致)
   *  - height: startH → endH(卡片自然扩展)
   *  - scrollY: prevScrollY + (curH - startH),仅 offDelta≠0(让 svgHost 底部屏幕恒定)
   *  - svg transform: T0*(1-eased) → 0(开环,消除 viewBox 偏移)
   *  - jianpu-group transform: jpT0*(1-eased) → 0(简谱平滑过渡)
   *  开环在测试页验证 dev=0(scrollY 和 svg transform 同步抵消,五线谱屏幕恒定)。
   *  注:之前尝试闭环 scrollY 补偿反而引入抖动(读 rect 时序与 rAF 不同步),已回退。 */
  private heightTick(
    card: CardState, now: number, startT: number, startH: number, endH: number,
    T0: number, jpT0: number, prevScrollY: number, offDelta: number, jpExpand: number,
    svgEl: SVGSVGElement | null, jg: SVGGElement | null,
  ): void {
    const t = Math.min(1, (now - startT) / 120);
    const eased = 1 - Math.pow(1 - t, 3);
    // 1) height 插值
    const curH = startH + (endH - startH) * eased;
    card.svgHost.style.height = curH + 'px';
    // 2) scrollY 同步(仅 offDelta≠0:高音顶扩时滚动,保持五线谱屏幕恒定)。
    if (offDelta !== 0) {
      const curScrollY = prevScrollY + (curH - startH) - jpExpand * eased;
      window.scrollTo(0, Math.max(0, curScrollY));
    }
    // 3) svg transform: T0 → 0(开环,消除 viewBox 偏移)
    if (svgEl) svgEl.style.transform = 'translateY(' + (T0 * (1 - eased)) + 'px)';
    // 4) jianpu-group transform: jpT0 → 0(简谱平滑过渡)
    if (jg) jg.style.transform = 'translateY(' + (jpT0 * (1 - eased)) + 'px)';
    if (t < 1) {
      card.heightAnimFrame = requestAnimationFrame((n: number) =>
        this.heightTick(card, n, startT, startH, endH, T0, jpT0, prevScrollY, offDelta, jpExpand, svgEl, jg));
    } else {
      card.heightAnimFrame = null;
      if (svgEl) svgEl.style.transform = '';
      if (jg) jg.style.transform = '';
    }
  }

  private updatePlayheadAndHighlight(): void {
    const playing = this.playState !== 'stopped';
    // 预览模式:只更新高亮 class + 播放头位置(不重建 SVG)。
    //   乐谱 SVG 由 render()/radio切换/编辑后 调 renderPreview() 重建;onTick 每帧只切
    //   class 与播放头 left/top/width/height %,避免每帧 innerHTML 全量重建双谱表(旧实现
    //   在此调 renderPreview(),播放中每帧重建 SVG → 卡顿/闪烁/播放头跳变)。
    //   高亮/播放头横向定位统一用 layout.noteX + noteStartBeats 自行解析 beat→音 idx,
    //   不依赖 player.schedule(停止态 schedule 为空会恒返回 -1,导致 seek 后高亮/播放头错乱)。
    if (this.viewMode === 'preview') {
      if (this.previewHost) {
        // 清旧高亮
        this.previewHost.querySelectorAll('.note-elem.playing, .jp-elem.playing').forEach(el => el.classList.remove('playing'));
        // 用 layout 几何解析当前 beat 落在两组各哪个音(停止态/播放态一致)
        const tLay = this.previewLayout, bLay = this.previewBassLayout;
        const tNotes = this.piece.treble;
        const bNotes = this.piece.bass;
        const tStarts = noteStartBeats({ ...this.piece, notes: tNotes });
        const bStarts = noteStartBeats({ ...this.piece, notes: bNotes });
        const tIdx = tLay ? this.noteIndexAtBeatLayout(this.currentBeat, tLay.noteX, tStarts, tNotes) : -1;
        const bIdx = bLay ? this.noteIndexAtBeatLayout(this.currentBeat, bLay.noteX, bStarts, bNotes) : -1;
        const hiTreble = new Set<number>();
        if (tIdx >= 0) {
          const cid = tNotes[tIdx]?.chordId;
          if (cid) { for (let i = 0; i < tNotes.length; i++) if (tNotes[i].chordId === cid) hiTreble.add(i); }
          else hiTreble.add(tIdx);
        }
        const hiBass = new Set<number>();
        if (bIdx >= 0) {
          const cid = bNotes[bIdx]?.chordId;
          if (cid) { for (let i = 0; i < bNotes.length; i++) if (bNotes[i].chordId === cid) hiBass.add(i); }
          else hiBass.add(bIdx);
        }
        // 预览卡内 .grand-treble 和 .grand-bass 两组各自的 [data-idx]
        // (playing 或停止态 seek 都显示高亮,便于定位)
        this.previewHost.querySelectorAll<SVGElement>('.grand-treble [data-idx]').forEach(el => {
          if (hiTreble.has(parseInt(el.getAttribute('data-idx') || '-1', 10))) el.classList.add('playing');
        });
        this.previewHost.querySelectorAll<SVGElement>('.grand-bass [data-idx]').forEach(el => {
          if (hiBass.has(parseInt(el.getAttribute('data-idx') || '-1', 10))) el.classList.add('playing');
        });
      }
      // 更新播放头位置(用 renderPreview 缓存的 layout,不重建 SVG)
      if (this.previewLayout && this.previewBassLayout) {
        this.updatePreviewPlayhead(this.previewLayout, this.previewBassLayout);
      }
      return;
    }
    // 遍历每个卡片:清除高亮 + 按 staff 查当前音 + 高亮 + 定位播放头
    for (const card of this.cards) {
      const lay = card.layout;
      const notes = card.pieceView.notes;
      // 1. 清除该卡高亮
      card.svgHost.querySelectorAll('.note-elem.playing, .jp-elem.playing').forEach(el => el.classList.remove('playing'));
      // 2. 高亮当前音(按 staff 查 idx)
      let idx = -1;
      if (playing && notes.length > 0 && lay) {
        idx = this.player.noteIndexAtBeatStaff(this.currentBeat, card.staff);
        if (idx >= 0) {
          if (card === this.activeCard) this.playingIndex = idx;
          const chordId = notes[idx].chordId;
          const hiliteIdxs: number[] = [];
          if (chordId) {
            for (let i = 0; i < notes.length; i++) if (notes[i].chordId === chordId) hiliteIdxs.push(i);
          } else {
            hiliteIdxs.push(idx);
          }
          const idxSet = new Set(hiliteIdxs);
          card.svgHost.querySelectorAll<SVGElement>('[data-idx]').forEach(el => {
            const di = parseInt(el.getAttribute('data-idx') || '-1', 10);
            if (idxSet.has(di)) el.classList.add('playing');
          });
        }
      }
      // 3. 播放头定位
      if (!playing || notes.length === 0 || !lay || lay.noteX.length === 0 || idx < 0) {
        card.playheadLayer.style.display = 'none';
        continue;
      }
      card.playheadLayer.style.display = '';
      const x0 = lay.noteX[idx];
      // 播放头宽与时值相关:用 noteSlotW(四分宽、八分窄...),回退 2*noteHeadHalf。
      // 盖住整个时值 slot,直观体现音符持续长度。
      const w = lay.noteSlotW[idx] || lay.noteHeadHalf * 2;
      const hiliteIdxs: number[] = [idx];
      {
        const chordId = notes[idx].chordId;
        if (chordId) { hiliteIdxs.length = 0; for (let i = 0; i < notes.length; i++) if (notes[i].chordId === chordId) hiliteIdxs.push(i); }
      }
      // 播放头顶部对齐当前音最高点,含符干高度(stemUp 时符干顶端比符头高约 stemLen=3.5ss)。
      // stemDown 音符干向下,顶部即符头本身。step<=6 为 stemUp(与 computeStem 一致)。
      const headHalf = lay.staffSpace * 0.6;
      const stemLen = lay.staffSpace * 3.5;   // 标准符干长
      let staffTop0 = Infinity;
      for (const di of hiliteIdxs) {
        const n = notes[di];
        if (n.midi === null) continue;
        const step = resolvePitch(n.midi, card.pieceView.clef, this.piece.key, n.accidental).step;
        const y = lay.bottomLineY - step * lay.staffSpace / 2;
        const stemUp = step <= 6;
        // stemUp:顶部含符干(y - headHalf - stemLen);stemDown:顶部只到符头(y - headHalf)
        const top = stemUp ? y - headHalf - stemLen : y - headHalf;
        staffTop0 = Math.min(staffTop0, top);
      }
      const pad = 6;
      const y1 = (staffTop0 === Infinity ? lay.staffTop : staffTop0) - pad;
      const y2 = lay.jianpuBottom + pad;
      const svgEl = card.svgHost.querySelector('svg');
      if (svgEl) {
        const hostRect = card.svgHost.getBoundingClientRect();
        const svgRect = svgEl.getBoundingClientRect();
        const offsetX = ((svgRect.left - hostRect.left) / hostRect.width) * 100;
        const offsetY = ((svgRect.top - hostRect.top) / hostRect.height) * 100;
        const svgWPct = (svgRect.width / hostRect.width) * 100;
        const svgHPct = (svgRect.height / hostRect.height) * 100;
        // 播放头左缘对齐符头左缘(noteX - NOTE_HEAD_HALF=拍位起点),向右延伸 slotW。
        // 与符头/sms待输入框左对齐拍位起点一致,视觉统一(而非以noteX居中)。
        const leftPct = offsetX + (x0 - lay.noteHeadHalf) / lay.width * svgWPct;
        const widthPct = w / lay.width * svgWPct;
        const topPct = offsetY + y1 / lay.height * svgHPct;
        const heightPct = (y2 - y1) / lay.height * svgHPct;
        if (!card.playheadEl || !card.playheadLayer.contains(card.playheadEl)) {
          card.playheadEl = document.createElement('div');
          card.playheadEl.className = 'pb-playhead';
          card.playheadLayer.appendChild(card.playheadEl);
        }
        const el = card.playheadEl;
        el.style.left = leftPct.toFixed(2) + '%';
        el.style.top = topPct.toFixed(2) + '%';
        el.style.width = widthPct.toFixed(2) + '%';
        el.style.height = heightPct.toFixed(2) + '%';
      }
    }
    if (!playing) this.playingIndex = -1;
  }
}

function mkBtn(text: string, variant: 'primary' | 'ghost' | 'accent', onClick: () => void, extra?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn btn-${variant}` + (extra ? ` btn-${extra}` : '');
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function spacer(): HTMLElement {
  const s = document.createElement('div');
  s.className = 'spacer';
  return s;
}
