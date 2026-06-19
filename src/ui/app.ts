// 应用装配：工具栏 ↔ 画布 ↔ 简谱 ↔ 播放 ↔ 导出 ↔ 快捷键
// 录入模型：追加式（短信验证码）—— 只能往末尾加，只能从末尾删。

import { Note, Piece } from '../core/types';
import { KEYS } from '../core/theory';
import { createPiece, appendNote, popNote, remainingBeats, remainingBeatsInCurrentBar, capacityBeats, totalBeats } from '../core/model';
import { computeLayout } from '../render/layout';
import { buildSVG, exportPNG } from '../render/export';
import { ensureFontLoaded } from '../render/glyphs';
import { clickYToMidi } from '../render/staff';
import { buildToolbar, defaultTool, ToolState } from './toolbar';
import { Player } from '../audio/player';
import { twinkleExample } from './examples';

interface HoverState { midi: number; x: number; }

export class App {
  private piece: Piece;
  private tool: ToolState;
  private root: HTMLElement;
  private svgHost!: HTMLElement;
  private statusEl!: HTMLElement;
  private bpm = 100;
  private playingIndex = -1;
  private player: Player;
  private toolbar!: HTMLElement;
  private hover: HoverState | null = null;
  private layout!: ReturnType<typeof computeLayout>;

  constructor(root: HTMLElement) {
    this.root = root;
    this.piece = createPiece();
    this.tool = defaultTool();
    this.player = new Player({
      onNote: (i) => { this.playingIndex = i; this.render(); },
      onEnd: () => { this.playingIndex = -1; this.render(); },
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

    this.toolbar = buildToolbar(this.tool, { onChange: () => this.onToolChange(), onRest: () => this.appendRest() });
    this.root.appendChild(this.toolbar);

    const stageWrap = document.createElement('div');
    stageWrap.className = 'stage';
    this.svgHost = document.createElement('div');
    this.svgHost.className = 'svg-host';
    stageWrap.appendChild(this.svgHost);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';
    stageWrap.appendChild(this.statusEl);

    this.root.appendChild(stageWrap);

    // 底栏
    const bottom = document.createElement('div');
    bottom.className = 'bottom-bar';

    const playBtn = mkBtn('▶ 播放', 'primary', () => this.togglePlay());
    const stopBtn = mkBtn('⏹', 'ghost', () => { this.player.stop(); this.playingIndex = -1; this.render(); }, 'icon');

    const bpmWrap = document.createElement('label');
    bpmWrap.className = 'bpm';
    const bpmLabel = document.createElement('span');
    bpmLabel.textContent = '速度';
    const bpmInput = document.createElement('input');
    bpmInput.type = 'range';
    bpmInput.min = '40'; bpmInput.max = '200'; bpmInput.value = String(this.bpm);
    const bpmVal = document.createElement('span');
    bpmVal.className = 'bpm-val'; bpmVal.textContent = `${this.bpm} BPM`;
    bpmInput.addEventListener('input', () => {
      this.bpm = parseInt(bpmInput.value);
      this.player.setBpm(this.bpm);
      bpmVal.textContent = `${this.bpm} BPM`;
    });
    bpmWrap.append(bpmLabel, bpmInput, bpmVal);

    const exampleBtn = mkBtn('示例：小星星', 'ghost', () => this.loadExample());
    const clearBtn = mkBtn('清空', 'ghost', () => this.clear());
    const exportBtn = mkBtn('⬇ 导出 PNG', 'accent', () => this.doExport());

    bottom.append(playBtn, stopBtn, bpmWrap, spacer(), exampleBtn, clearBtn, exportBtn);
    this.root.appendChild(bottom);

    this.bindCanvas();
    this.bindKeys();
    this.render();
  }

  private isMouseDown = false;

  private bindCanvas(): void {
    // 阻止双击/拖拽选中文本和音符（CSS user-select:none 的补充）
    this.svgHost.addEventListener('selectstart', (e) => e.preventDefault());
    this.svgHost.addEventListener('dblclick', (e) => e.preventDefault());

    // 记录鼠标按下状态：按下期间绝不重渲染，避免点击中途中断
    this.svgHost.addEventListener('mousedown', () => { this.isMouseDown = true; });
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

    // click → 追加音符。命中范围：整个 SVG 区域（追加式录入里 x 不影响落点，只用 y 决定音高）。
    this.svgHost.addEventListener('click', (e: MouseEvent) => {
      const { y, ok } = this.toSvgCoords(e);
      if (!ok) return;
      const midi = clickYToMidi(y, this.piece, this.layout);
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
    const y = ((e.clientY - rect.top) / rect.height) * this.layout.height;
    return { x, y, ok: true };
  }

  private appendNoteWithPitch(midi: number): void {
    const note: Note = { midi, duration: this.tool.duration, dotted: this.tool.dotted, accidental: this.tool.accidental };
    const ok = appendNote(this.piece, note);
    if (!ok) { this.flashOverfillRejected(); return; }
    this.afterEdit();
  }

  private appendRest(): void {
    const note: Note = { midi: null, duration: this.tool.duration, dotted: this.tool.dotted, accidental: null };
    const ok = appendNote(this.piece, note);
    if (!ok) { this.flashOverfillRejected(); return; }
    this.afterEdit();
  }

  /** appendNote 拒绝时给出精确提示：区分「整个谱写满」和「本小节放不下」 */
  private flashOverfillRejected(): void {
    if (remainingBeats(this.piece) < 1e-6) {
      this.flash('已写满 4 个小节');
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
    this.piece.clef = this.tool.clef;
    this.piece.key = KEYS[this.tool.key];
    this.piece.time = { ...this.tool.time };
    // 切换谱号 / 拍号：清空已输入的音符（避免错位与节奏错乱）
    const newTime = `${this.piece.time.num}/${this.piece.time.den}`;
    if (oldClef !== this.piece.clef || oldTime !== newTime) {
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
        case '1': this.tool.duration = 'whole'; this.syncToolbarDurations(); break;
        case '2': this.tool.duration = 'half'; this.syncToolbarDurations(); break;
        case '3': this.tool.duration = 'quarter'; this.syncToolbarDurations(); break;
        case '4': this.tool.duration = 'eighth'; this.syncToolbarDurations(); break;
        case '5': this.tool.duration = 'sixteenth'; this.syncToolbarDurations(); break;
        case '.': this.tool.dotted = !this.tool.dotted; (this.toolbar as any)._resetModifiers?.(); this.render(); break;
        case '0': this.appendRest(); break;
        case 'Backspace': popNote(this.piece); this.render(); e.preventDefault(); break;
        case ' ': this.togglePlay(); e.preventDefault(); break;
      }
    });
  }

  /** 键盘改了 duration 后，把工具栏高亮同步过来 */
  private syncToolbarDurations(): void {
    const btns = this.toolbar.querySelectorAll<HTMLButtonElement>('.chip[data-dur]');
    btns.forEach(b => b.classList.toggle('active', b.dataset.dur === this.tool.duration));
    this.render();
  }

  private togglePlay(): void {
    if (this.player.isPlaying()) {
      this.player.stop(); this.playingIndex = -1; this.render();
    } else {
      this.player.setBpm(this.bpm);
      this.player.play(this.piece);
    }
  }

  private clear(): void {
    this.piece = createPiece();
    this.piece.clef = this.tool.clef;
    this.piece.key = KEYS[this.tool.key];
    this.piece.time = { ...this.tool.time };
    this.playingIndex = -1;
    this.render();
  }

  private loadExample(): void {
    this.piece = twinkleExample();
    this.tool.clef = this.piece.clef;
    this.tool.key = this.piece.key.name;
    this.tool.time = { ...this.piece.time };
    this.rebuildToolbar();
    this.render();
  }

  private rebuildToolbar(): void {
    const old = this.toolbar;
    this.toolbar = buildToolbar(this.tool, { onChange: () => this.onToolChange(), onRest: () => this.appendRest() });
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
    this.layout = computeLayout(this.piece, width, this.tool.duration);
    const svg = buildSVG(this.piece, this.layout, this.playingIndex, { hover: this.hover });
    this.svgHost.innerHTML = svg;
    const svgEl = this.svgHost.querySelector('svg');
    if (svgEl) svgEl.setAttribute('width', '100%');
    // 状态
    const rem = remainingBeats(this.piece);
    const pct = Math.round((totalBeats(this.piece) / capacityBeats(this.piece)) * 100);
    this.statusEl.textContent = `${this.piece.notes.length} 个音符 · 已用 ${pct}% · 还能再写约 ${rem.toFixed(1)} 拍`;
    // 工具栏容量联动：disable 放不下的时值/附点按钮
    (this.toolbar as any)._refreshCapacity?.(remainingBeatsInCurrentBar(this.piece), rem);
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
