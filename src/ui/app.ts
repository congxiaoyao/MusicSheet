// 应用装配：工具栏 ↔ 画布 ↔ 简谱 ↔ 播放 ↔ 导出 ↔ 快捷键
// 录入模型：追加式（短信验证码）—— 只能往末尾加，只能从末尾删。

import { Note, Piece, DurationValue } from '../core/types';
import { KEYS } from '../core/theory';
import { createPiece, appendNote, popNote, remainingBeats, remainingBeatsInCurrentBar, capacityBeats, totalBeats, noteStartBeats } from '../core/model';
import { computeLayout } from '../render/layout';
import { buildSVG, exportPNG } from '../render/export';
import { ensureFontLoaded } from '../render/glyphs';
import { clickYToMidi } from '../render/staff';
import { buildToolbar, defaultTool, ToolState, TUPLET_CONFIG, TupletMode, tupletModeForActual } from './toolbar';
import { Player, PlayState } from '../audio/player';
import { buildPlaybackCard, loadFingering, loadShow, saveFingering, saveShow, Fingering, ShowFlags, PlaybackView } from './playback-card';
import { serialize, deserialize, sheetFileName, SHEET_EXTENSION } from '../core/serialize';
import { twinkleExample } from './examples';

interface HoverState { midi: number; x: number; }

export class App {
  private piece: Piece;
  private tool: ToolState;
  /** 连音组(tuplet)输入进度：开启 tuplet 模式后，追踪当前组已输入第几个、共用 groupId。
   *  输入第 actual 个后关闭模式并清空。null 表示不在组输入中。 */
  private tupletProgress: { groupId: string; count: number; actual: number; normal: number } | null = null;
  private tupletIdCounter = 0;
  /** 和弦(chord)输入:当前正在构建的和弦 chordId(和弦模式开且末尾音同此 id 时,下个音复用它做尾音)。
   *  null/不在和弦模式 → 下个音作为新和弦首音(或单音)。 */
  private currentChordId: string | null = null;
  private chordIdCounter = 0;
  private root: HTMLElement;
  private svgHost!: HTMLElement;
  /** 播放头覆盖层:独立 DOM div,叠在 svgHost 上,由 currentBeat 驱动定位(onTick 时更新) */
  private playheadLayer!: HTMLElement;
  private statusEl!: HTMLElement;
  private bpm = 100;
  private playingIndex = -1;
  private currentBeat = 0;
  private playState: PlayState = 'stopped';
  private fingering: Fingering;
  private show: ShowFlags;
  private player: Player;
  private toolbar!: HTMLElement;
  private playbackCard!: HTMLElement;
  private hover: HoverState | null = null;
  private layout!: ReturnType<typeof computeLayout>;

  constructor(root: HTMLElement) {
    this.root = root;
    this.piece = createPiece();
    this.tool = defaultTool();
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
    void ensureFontLoaded().then(() => this.render());
  }

  private buildDOM(): void {
    this.root.innerHTML = '';
    this.root.className = 'app';

    const header = document.createElement('header');
    header.className = 'app-header';
    header.innerHTML = `<h1>简谱翻译 <span class="dot">·</span> <em>MusicSheet</em></h1>
      <p class="hint">点击五线谱放音 → 下方实时显示简谱 · 类似短信验证码：只能往右追加，退格删除最后一个</p>`;
    this.root.appendChild(header);

    this.toolbar = buildToolbar(this.tool, {
      onChange: () => this.onToolChange(),
      onRest: () => this.appendRest(),
      onTie: () => this.tieRepeat(),
      onToggleChord: () => this.onToggleChord(),
    });
    this.root.appendChild(this.toolbar);

    const stageWrap = document.createElement('div');
    stageWrap.className = 'stage';
    this.svgHost = document.createElement('div');
    this.svgHost.className = 'svg-host';
    stageWrap.appendChild(this.svgHost);
    // 播放头覆盖层:叠在 svgHost 内,absolute 定位,pointer-events:none 不阻挡点击。
    // 由 currentBeat 驱动(onTick 时更新 left/width),不再画进 SVG 字符串。
    this.playheadLayer = document.createElement('div');
    this.playheadLayer.className = 'playhead-layer';
    this.playheadLayer.style.display = 'none';   // 默认隐藏,播放/暂停态才显示
    this.svgHost.appendChild(this.playheadLayer);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';
    stageWrap.appendChild(this.statusEl);

    this.root.appendChild(stageWrap);

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
    this.root.appendChild(this.playbackCard);

    // 编辑操作栏（示例/清空 + 导出/导入下拉）—— 次要操作，放卡片下一行
    const editBar = document.createElement('div');
    editBar.className = 'edit-bar';
    const exampleBtn = mkBtn('示例：小星星', 'ghost', () => this.loadExample());
    const clearBtn = mkBtn('清空', 'ghost', () => this.clear());
    editBar.append(spacer(), exampleBtn, clearBtn, this.buildExportImportMenu());
    this.root.appendChild(editBar);

    this.bindCanvas();
    this.bindKeys();
    this.bindDragDrop();
    this.render();
  }

  /** 构建「导出/导入」下拉按钮组：导出 PNG / 导出乐谱 / 导入乐谱 */
  private buildExportImportMenu(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'dropdown';

    const trigger = document.createElement('button');
    trigger.className = 'btn btn-accent export-trigger';
    trigger.type = 'button';
    trigger.innerHTML = '⬇ 导出/导入 <span class="caret"></span>';

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu anchored';

    const pngItem = document.createElement('button');
    pngItem.className = 'dropdown-item';
    pngItem.type = 'button';
    pngItem.textContent = '导出 PNG（图片）';
    pngItem.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); trigger.classList.remove('is-open'); void this.doExport(); });

    const sheetItem = document.createElement('button');
    sheetItem.className = 'dropdown-item';
    sheetItem.type = 'button';
    sheetItem.textContent = '导出乐谱（.msheet）';
    sheetItem.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); trigger.classList.remove('is-open'); this.doExportSheet(); });

    const importItem = document.createElement('button');
    importItem.className = 'dropdown-item';
    importItem.type = 'button';
    importItem.textContent = '导入乐谱…（也可拖拽文件）';
    importItem.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); trigger.classList.remove('is-open'); this.openImportPicker(); });

    menu.append(pngItem, sheetItem, importItem);
    // 菜单挂 body 下，fixed 定位脱离工具栏流避免被裁切
    document.body.appendChild(menu);

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('open');
      trigger.classList.toggle('is-open', open);
      if (open) {
        const r = trigger.getBoundingClientRect();
        // 边界感知定位(水平 + 垂直):
        // 水平:默认右对齐(菜单右边贴按钮右边),若左侧空间不足则左对齐
        // 垂直:默认向下展开,若下方空间不足则向上展开(避免被视口底/页底裁切)
        const menuW = 200;
        const margin = 8;
        let left: number;
        if (r.right - menuW >= margin) {
          left = r.right - menuW;            // 左侧够:右对齐
        } else {
          left = margin;                      // 左侧不够:贴左边
        }
        menu.style.left = `${left}px`;
        menu.style.minWidth = `${menuW}px`;
        // 先设 top(向下),测高度后判断是否需向上
        menu.style.top = `${r.bottom + 6}px`;
        // 用 rAF 等渲染后测实际高度,若超出视口底部则向上展开
        requestAnimationFrame(() => {
          const menuH = menu.getBoundingClientRect().height;
          const spaceBelow = window.innerHeight - r.bottom;
          if (menuH + margin > spaceBelow && r.top > menuH + margin) {
            // 下方不够且上方够:向上展开
            menu.style.top = `${r.top - menuH - 6}px`;
          }
        });
      }
    });
    // 点外部关闭
    document.addEventListener('click', () => { menu.classList.remove('open'); trigger.classList.remove('is-open'); });

    wrap.append(trigger, menu);
    return wrap;
  }

  /** 导出乐谱为 .msheet 文件 */
  private doExportSheet(): void {
    if (this.piece.notes.length === 0) { this.flash('乐谱为空，无内容可导出'); return; }
    try {
      const text = serialize(this.piece);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sheetFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.flash(`已导出 ${this.piece.notes.length} 个音符`);
    } catch (err) {
      this.flash('导出失败：' + (err as Error).message);
    }
  }

  /** 打开文件选择器导入乐谱 */
  private openImportPicker(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = SHEET_EXTENSION + ',application/json';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) void this.doImportSheet(f);
    });
    input.click();
  }

  /** 读取文件并导入：校验 + 覆盖确认 + 替换 piece */
  private async doImportSheet(file: File): Promise<void> {
    if (this.piece.notes.length > 0) {
      if (!confirm('当前乐谱已有内容，导入将覆盖。确定继续吗？')) return;
    }
    try {
      const text = await file.text();
      const piece = deserialize(text);
      this.applyImportedPiece(piece);
      this.flash(`已导入 ${piece.notes.length} 个音符`);
    } catch (err) {
      this.flash('导入失败：' + (err as Error).message);
    }
  }

  /** 应用导入的 piece：同步 tool 状态 + 重建工具栏 + 重置播放 + render */
  private applyImportedPiece(piece: Piece): void {
    this.piece = piece;
    // 同步工具栏选项到导入的乐谱
    this.tool.clef = piece.clef;
    this.tool.key = piece.key.name;
    this.tool.time = { ...piece.time };
    this.tool.measureCount = piece.measureCount;
    // 重置播放/输入状态
    this.player.stop();
    this.playingIndex = -1;
    this.currentBeat = 0;
    this.playState = 'stopped';
    this.hover = null;
    this.currentChordId = null;
    this.tupletProgress = null;
    this.rebuildToolbar();
    this.render();
  }

  /** 拖拽导入：整个 app 容器接收文件拖放 */
  private bindDragDrop(): void {
    let dragCounter = 0;
    this.root.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      dragCounter++;
      this.root.classList.add('drag-over');
    });
    this.root.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.root.addEventListener('dragleave', () => {
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; this.root.classList.remove('drag-over'); }
    });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      this.root.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) void this.doImportSheet(file);
    });
  }

  private isMouseDown = false;
  /** mousedown 时记录的音高:按下→抬起若跨多个音高,应按「按下音高」输入而非抬起音高。
   *  click 事件在 mouseup 后触发,其坐标是抬起位置,故改用 mousedown 记录的音高。 */
  private downMidi: number | null = null;

  private bindCanvas(): void {
    // 阻止双击/拖拽选中文本和音符（CSS user-select:none 的补充）
    this.svgHost.addEventListener('selectstart', (e) => e.preventDefault());
    this.svgHost.addEventListener('dblclick', (e) => e.preventDefault());

    // mousedown:记录按下状态 + 按下位置的音高(用于 click 时按按下音高输入)
    this.svgHost.addEventListener('mousedown', (e: MouseEvent) => {
      this.isMouseDown = true;
      const { y, ok } = this.toSvgCoords(e);
      this.downMidi = ok ? clickYToMidi(y, this.piece, this.layout) : null;
    });
    window.addEventListener('mouseup', () => { this.isMouseDown = false; });

    // mousemove → 悬停预览。仅当音高真正变化（吸附后的 midi 不同）才重渲染，
    // 既省性能，又避免每次微小移动都重建 SVG 把点击打断。
    this.svgHost.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isMouseDown) return; // 按下期间不重渲染
      const { y, ok } = this.toSvgCoords(e);
      if (!ok) { this.clearHover(); return; }
      const midi = clickYToMidi(y, this.piece, this.layout);
      if (this.hover && this.hover.midi === midi) return; // 音高没变，不重渲染
      this.hover = { midi, x: this.layout.nextSlotX };
      this.render();
      this.maybePreview(midi);
    });
    this.svgHost.addEventListener('mouseleave', () => this.clearHover());

    // click → 追加音符。用 mousedown 时记录的音高(按下位置),而非 click 事件坐标
    // (click 在 mouseup 后触发,坐标是抬起位置;按下→抬起跨音高应按按下音高输入)。
    this.svgHost.addEventListener('click', () => {
      if (this.downMidi === null) return;
      const midi = this.downMidi;
      this.downMidi = null;
      this.appendNoteWithPitch(midi);
    });
  }

  private lastPreviewMidi: number | null = null;
  private maybePreview(midi: number): void {
    if (this.lastPreviewMidi !== midi) {
      this.lastPreviewMidi = midi;
      this.player.preview(midi);
    }
  }

  private clearHover(): void {
    if (this.hover) { this.hover = null; this.render(); }
  }

  private toSvgCoords(e: MouseEvent): { x: number; y: number; ok: boolean } {
    const svg = this.svgHost.querySelector('svg');
    if (!svg) return { x: 0, y: 0, ok: false };
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.layout.width;
    // y 映射要考虑 viewBox 的 y 起点(-viewBoxYOffset):SVG 物理顶对应 viewBox y=-offset,
    // 故内部 y = (距物理顶比例) * viewBox高 + viewBoxY起点。margin-top 上移不影响(rect 已反映真实位置)。
    const vbY0 = -this.layout.viewBoxYOffset;
    const y = ((e.clientY - rect.top) / rect.height) * this.layout.height + vbY0;
    return { x, y, ok: true };
  }

  private appendNoteWithPitch(midi: number): void {
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
    (this.toolbar as any)._setChordMode?.(false);
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
      (this.toolbar as any)._setTupletMode?.('off');
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
    (this.toolbar as any)._setTupletMode?.(newMode);
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
    // 追加后重置一次性修饰（附点/升降/休止），符合行业惯例
    (this.toolbar as any)._resetModifiers?.();
    this.hover = null;
    this.render();
  }

  private onToolChange(): void {
    const oldClef = this.piece.clef;
    const oldTime = `${this.piece.time.num}/${this.piece.time.den}`;
    const oldMeasureCount = this.piece.measureCount;
    this.piece.clef = this.tool.clef;
    this.piece.key = KEYS[this.tool.key];
    this.piece.time = { ...this.tool.time };
    this.piece.measureCount = this.tool.measureCount;
    // 切换谱号 / 拍号 / 小节数：清空已输入的音符（避免错位与节奏错乱）
    const newTime = `${this.piece.time.num}/${this.piece.time.den}`;
    if (oldClef !== this.piece.clef || oldTime !== newTime || oldMeasureCount !== this.piece.measureCount) {
      this.piece.notes = [];
      this.playingIndex = -1;
    }
    this.render();
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'SELECT' || tag === 'INPUT') return;
      switch (e.key) {
        case '1': this.changeDuration('whole'); break;
        case '2': this.changeDuration('half'); break;
        case '3': this.changeDuration('quarter'); break;
        case '4': this.changeDuration('eighth'); break;
        case '5': this.changeDuration('sixteenth'); break;
        case '6': this.changeDuration('thirtysecond'); break;
        case '.': this.tool.dotted = !this.tool.dotted; (this.toolbar as any)._resetModifiers?.(); this.render(); break;
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
    (this.toolbar as any)._setChordMode?.(this.tool.chordMode);
    this.onToggleChord();
  }

  /** 删除末尾音符(短信验证码式 backspace),并修正 tuplet/chord 状态。
   *  tuplet 修复(两个场景):
   *  - 输入中删除:回退 tupletProgress.count,让用户继续补齐该组
   *  - 完成后删除:组变残缺,重新进入该组输入模式(恢复 tupletProgress + toolbar 高亮),
   *    让用户补齐;若组删空则关闭模式
   *  chord:currentChordId 不在末尾时清掉避免误复用 */
  private deleteLastNote(): void {
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
        (this.toolbar as any)._setTupletMode?.('off');
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
          (this.toolbar as any)._setTupletMode?.(mode);
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
        (this.toolbar as any)._setChordMode?.(false);
      } else {
        // 还有残音(含只剩1个):恢复 currentChordId + 开和弦模式,可继续补声部
        this.currentChordId = removedChord;
        this.tool.chordMode = true;
        (this.toolbar as any)._setChordMode?.(true);
      }
    } else {
      // 删的是普通音(非和弦)。若删除后新末音属于某个和弦组,恢复该组模式
      // (让 nextSlot 回到和弦位置且宽度跟随和弦时值,符合「删回到和弦位置继续编辑」直觉)。
      const last = notes[notes.length - 1];
      if (last && last.chordId) {
        this.currentChordId = last.chordId;
        this.tool.chordMode = true;
        (this.toolbar as any)._setChordMode?.(true);
      } else {
        // 新末音非和弦:清掉 currentChordId 避免误复用
        this.currentChordId = null;
      }
    }
    this.render();
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
      this.player.play(this.piece);
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
      // 停止态:记录位置,不显示播放头(停止语义)。进度条同步显示位置。
      (this.playbackCard as any)._setProgress?.(beat);
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
    // 用 totalBeats()(跳过和弦尾音),与 player 的 schedule 一致。
    // 旧实现 reduce(durationBeats) 没跳尾音,含和弦的乐谱进度比例会偏大。
    return {
      piece: this.piece,
      playState: this.playState,
      bpm: this.bpm,
      currentBeat: this.playState === 'stopped' ? 0 : this.currentBeat,
      totalBeats: totalBeats(this.piece),
      playingIndex: this.playingIndex,
      fingering: this.fingering,
      show: this.show,
    };
  }

  private refreshCard(): void {
    (this.playbackCard as any)._refresh?.();
  }

  private clear(): void {
    this.piece = createPiece();
    this.piece.clef = this.tool.clef;
    this.piece.key = KEYS[this.tool.key];
    this.piece.time = { ...this.tool.time };
    this.piece.measureCount = this.tool.measureCount;
    this.playingIndex = -1;
    this.render();
  }

  private loadExample(): void {
    this.piece = twinkleExample(this.tool.measureCount);
    // 保留用户当前选择的调号与拍号（示例用绝对 MIDI 音高，调号只影响显示与简谱）
    this.piece.clef = this.tool.clef;
    this.piece.key = KEYS[this.tool.key];
    this.piece.time = { ...this.tool.time };
    this.piece.measureCount = this.tool.measureCount;
    this.rebuildToolbar();
    this.render();
  }

  private rebuildToolbar(): void {
    const old = this.toolbar;
    this.toolbar = buildToolbar(this.tool, {
      onChange: () => this.onToolChange(),
      onRest: () => this.appendRest(),
      onTie: () => this.tieRepeat(),
      onToggleChord: () => this.onToggleChord(),
    });
    old.replaceWith(this.toolbar);
  }

  private async doExport(): Promise<void> {
    try { await exportPNG(this.piece, this.layout); this.flash('已导出 PNG'); }
    catch (err) { this.flash('导出失败：' + (err as Error).message); }
  }

  private flashTimer: number | undefined;
  private flash(msg: string): void {
    this.statusEl.textContent = msg;
    this.statusEl.classList.add('show', 'flash');
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => { this.statusEl.classList.remove('show', 'flash'); this.render(); }, 1600);
  }

  private render(): void {
    const width = Math.min(1200, Math.max(640, this.svgHost.clientWidth || 940));
    // 和弦输入中:nextSlot 锁定在当前和弦组首音起点,让用户知道「还在这个位置加声部」,
    // 且 slot 宽度跟随和弦首音时值(删除到和音位置时不沿用工具栏可能已切换的时值)。
    // 关和弦后不传 anchor,nextSlot 才跳到 totalBeats(首音结束处)。
    let chordAnchor: number | undefined;
    let chordAnchorDur: DurationValue | undefined;
    if (this.tool.chordMode && this.currentChordId) {
      const notes = this.piece.notes;
      const firstIdx = notes.findIndex(n => n.chordId === this.currentChordId);
      if (firstIdx >= 0) {
        chordAnchor = noteStartBeats(this.piece)[firstIdx];
        chordAnchorDur = notes[firstIdx].duration;
      }
    }
    // 布局高度只由实际 notes 决定,不含 hoverMidi。
    // 之前传 hoverMidi 导致鼠标上下移动时 hover 预览音高变化 → layout 高度随鼠标 y 实时跳变(乱跳)。
    // hover 预览符头若超出当前布局范围,接受可能的边缘裁切(预览是临时的,鼠标移走即恢复),
    // 不应为临时预览而频繁改变整个编辑区高度。
    this.layout = computeLayout(this.piece, width, this.tool.duration, chordAnchor, chordAnchorDur);
    const svg = buildSVG(this.piece, this.layout, this.playingIndex, { hover: this.hover });
    // SVG 内不再画播放头(改由独立 DOM 覆盖层 playheadLayer 驱动)。
    // 注意:innerHTML 会清空 svgHost 所有子元素(含 playheadLayer),需重新 append 回去。
    this.svgHost.innerHTML = svg;
    const svgEl = this.svgHost.querySelector('svg');
    if (svgEl) svgEl.setAttribute('width', '100%');
    // ── 高度动画:svgHost transform 抵消五线谱下移,.stage overflow visible 容纳上移 ──
    // 顶部扩展(offset+):viewBox y起点变负,staffTop 映射物理位置下移 offset。
    // svgHost transform = -offset 上移抵消,五线谱屏位恒定。
    // svgHost 上移后顶部溢出 .stage padding 区(白色),.stage overflow visible 让其可见(不裁)。
    // 不用 padding/margin 撑开卡片:那些会引入额外 offset 无法抵消。transform-only 最干净。
    this.svgHost.style.transform = `translateY(${-this.layout.viewBoxYOffset}px)`;
    this.svgHost.style.height = `${this.layout.height + 16}px`;
    this.svgHost.appendChild(this.playheadLayer);
    // 状态
    const rem = remainingBeats(this.piece);
    const pct = Math.round((totalBeats(this.piece) / capacityBeats(this.piece)) * 100);
    this.statusEl.textContent = `${this.piece.notes.length} 个音符 · 已用 ${pct}% · 还能再写约 ${rem.toFixed(1)} 拍`;
    // 工具栏容量联动：disable 放不下的时值/附点按钮
    (this.toolbar as any)._refreshCapacity?.(remainingBeatsInCurrentBar(this.piece), rem);
    // 卡片随 render 刷新（音域/高亮/状态可能变）
    this.refreshCard();
    // render 后用当前 currentBeat 同步播放头/高亮(SVG 刚重建,.playing class 需重打)
    this.updatePlayheadAndHighlight();
  }

  /** 单一数据源同步:由 currentBeat → 算当前音 idx → 更新播放头位置 + 符头/简谱高亮。
   *  在 onTick(每帧)、onStateChange、onEnd、seek、render 后调用,保证播放头/高亮/进度条三者同步。
   *  - 停止态:隐藏播放头,清除所有 .playing 高亮
   *  - 播放/暂停态:显示播放头,定位到 currentBeat 对应音,高亮该音(和弦组全部声部) */
  private updatePlayheadAndHighlight(): void {
    const lay = this.layout;
    const notes = this.piece.notes;
    const playing = this.playState !== 'stopped';

    // 1. 高亮:先清除所有 .playing,再给当前音(含和弦组)加上
    this.svgHost.querySelectorAll('.note-elem.playing, .jp-elem.playing').forEach(el => el.classList.remove('playing'));
    if (playing && notes.length > 0) {
      const idx = this.player.noteIndexAtBeat(this.currentBeat);
      if (idx >= 0) {
        this.playingIndex = idx;
        // 收集需高亮的 idx:和弦组 = 同 chordId 所有声部;单音 = 仅 idx
        const chordId = notes[idx].chordId;
        const hiliteIdxs: number[] = [];
        if (chordId) {
          for (let i = 0; i < notes.length; i++) if (notes[i].chordId === chordId) hiliteIdxs.push(i);
        } else {
          hiliteIdxs.push(idx);
        }
        const idxSet = new Set(hiliteIdxs);
        // 五线谱:每个 idx 的 note-elem;简谱:jp-elem data-idx 是首音,首音必在 idxSet 内
        this.svgHost.querySelectorAll<SVGElement>('[data-idx]').forEach(el => {
          const di = parseInt(el.getAttribute('data-idx') || '-1', 10);
          if (idxSet.has(di)) el.classList.add('playing');
        });
      }
    } else {
      this.playingIndex = -1;
    }

    // 2. 播放头定位(播放/暂停态)
    if (!playing || notes.length === 0 || lay.noteX.length === 0 || !lay) {
      this.playheadLayer.style.display = 'none';
      this.playheadLayer.innerHTML = '';
      return;
    }
    const idx = this.player.noteIndexAtBeat(this.currentBeat);
    if (idx < 0) { this.playheadLayer.style.display = 'none'; this.playheadLayer.innerHTML = ''; return; }
    this.playheadLayer.style.display = '';
    const x0 = lay.noteX[idx];
    const w = lay.noteSlotW[idx] || 24;
    // SVG 在 svgHost 的 padding(8px 4px)内,playheadLayer 覆盖 padding box(inset:0)。
    // 播放头百分比相对 layout.width(SVG viewBox 宽),需把 SVG 的 padding 偏移算进去。
    // SVG width=100%(填 content box),content box 宽 = svgHost clientWidth - 左右 padding。
    // 简化:用 SVG 元素相对 svgHost 的偏移 + 尺寸定位播放头,精确对齐。
    const svgEl = this.svgHost.querySelector('svg');
    if (svgEl) {
      const hostRect = this.svgHost.getBoundingClientRect();
      const svgRect = svgEl.getBoundingClientRect();
      // SVG 相对 svgHost 的左/上偏移(px)与宽高,转成百分比供 .pb-playhead 使用
      const offsetX = ((svgRect.left - hostRect.left) / hostRect.width) * 100;
      const offsetY = ((svgRect.top - hostRect.top) / hostRect.height) * 100;
      const svgWPct = (svgRect.width / hostRect.width) * 100;
      const svgHPct = (svgRect.height / hostRect.height) * 100;
      // 播放头 left% = SVG偏移 + (noteX/viewBox宽)*SVG宽%
      const leftPct = offsetX + (x0 - w / 2) / lay.width * svgWPct;
      const widthPct = w / lay.width * svgWPct;
      // top/height:覆盖五线谱顶到简谱底(y1=staffTop-8 → y2=jianpuBottom+8)
      const y1 = lay.staffTop - 8;
      const y2 = lay.jianpuBottom + 8;
      const topPct = offsetY + y1 / lay.height * svgHPct;
      const heightPct = (y2 - y1) / lay.height * svgHPct;
      this.playheadLayer.innerHTML = `<div class="pb-playhead" style="left:${leftPct.toFixed(2)}%;top:${topPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;height:${heightPct.toFixed(2)}%"></div>`;
    }
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
