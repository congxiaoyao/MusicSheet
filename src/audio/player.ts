// 放音引擎：Web Audio 合成钢琴音色 + 基于 AudioContext 时钟的精确调度 + seek/pause-resume。
//
// 设计要点：
// - 状态机：'stopped' | 'playing' | 'paused'
// - 时间轴：每次 play/playFrom 预计算每个音的 [startBeat, endBeat]（含 tie 合并），
//   音频走 AudioContext 时钟，UI 高亮走 requestAnimationFrame 对照 ctx.currentTime，两者同源不漂移。
// - seek/pause/resume：本质都是「从某 beat 重新调度」。pause 记录当前 beat 再停 osc，
//   resume 从该 beat 重启；seek 直接 playFrom(beat)。

import { durationBeats, Piece } from '../core/types';
import { isChordTail } from '../core/model';

export type PlayState = 'stopped' | 'playing' | 'paused';

export interface PlayerCallbacks {
  onNote?: (index: number) => void;          // 进入新音区间时触发（符头高亮用）
  onTick?: (beat: number) => void;           // 播放中每帧推进（进度条/竖线用）
  onStateChange?: (state: PlayState) => void;
  onEnd?: () => void;
}

interface SchedEntry {
  index: number;          // notes 数组下标
  startBeat: number;
  endBeat: number;
  /** 实际发声时长（拍）。tie 链中起点音吃掉整链时长；链中 tieEnd 音为 0（不重新起振） */
  voiceBeats: number;
  /** tie 合并后该音实际要响的拍数（用于音色时长）。voiceBeats===0 则静默 */
}

export class Player {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private cb: PlayerCallbacks;

  private bpm = 100;
  private piece: Piece | null = null;
  private schedule: SchedEntry[] = [];
  private totalBeats = 0;

  private state: PlayState = 'stopped';
  /** 播放起点对应的 AudioContext 时间（秒）。调度时为 ctx.currentTime + 前瞻量 */
  private startCtxTime = 0;
  /** startCtxTime 对应的 score-beat（seek 后非 0） */
  private startBeat = 0;
  /** 已调度的活跃 oscillator 列表（用于 pause/stop 时清理） */
  private activeOscs: { osc: OscillatorNode; gain: GainNode; endAt: number }[] = [];
  private rafId = 0;
  private lastNoteIdx = -1;

  constructor(cb: PlayerCallbacks = {}) {
    this.cb = cb;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
  }

  getState(): PlayState { return this.state; }
  isPlaying(): boolean { return this.state === 'playing'; }
  getTotalBeats(): number { return this.totalBeats; }

  /** 当前 score-beat（播放/暂停态有效；停止态为 0） */
  getCurrentBeat(): number {
    if (this.state === 'stopped') return 0;
    if (this.state === 'paused') return this.startBeat;
    const ctx = this.ctx!;
    const elapsed = ctx.currentTime - this.startCtxTime;
    const beats = this.startBeat + elapsed * (this.bpm / 60);
    return Math.min(beats, this.totalBeats);
  }

  /** 计算时间轴：每个音的 [startBeat, endBeat] + tie 合并后的实际发声拍数。
   *  tie 规则：tieStart 音「吃掉」整条同音高链的时长（在其 voiceBeats 里累加链尾延音），
   *  链中的 tieEnd 音 voiceBeats=0（不重新起振）。时间轴本身仍按原始时值推进。 */
  private computeSchedule(piece: Piece): SchedEntry[] {
    const notes = piece.notes;
    // 先算每音 startBeat / endBeat。和弦(chord)尾音与首音同时:尾音 startBeat = 首音 startBeat,
    // 不推进时间轴 → 用 isChordTail 跳过推进。这样 playFrom 按 startBeat 调度时,和弦各声部同 t 触发。
    const raw: { start: number; end: number }[] = [];
    let acc = 0;
    let chordStartBeat = 0;   // 当前和弦组首音 startBeat(供尾音复用)
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const d = durationBeats(n);
      const tail = isChordTail(n, i > 0 ? notes[i - 1] : null);
      const startBeat = tail ? chordStartBeat : acc;
      raw.push({ start: startBeat, end: tail ? chordStartBeat + d : acc + d });
      if (!tail) {
        chordStartBeat = acc;
        acc += d;
      }
    }

    // tie 链:把「终点音」voiceBeats 清零、「起点音」吃掉整链时长。
    // 配对按「时间位 + 同 midi」(slots):前位 tieStart 声部 ↔ 后位 tieEnd 声部(同 midi 才连)。
    // 这同时支持单音 tie(相邻同音高)与和弦 tie(复制组各声部与源组对应声部 midi 全等)。
    const slots: [number, number][] = [];
    for (let i = 0; i < notes.length;) {
      const cid = notes[i].chordId;
      let j = cid ? i : i + 1;
      if (cid) while (j < notes.length && notes[j].chordId === cid) j++;
      slots.push([i, j - 1]);
      i = j;
    }
    // voiceBeats:先全部按原始时值
    const out: SchedEntry[] = notes.map((_, i) => ({
      index: i,
      startBeat: raw[i].start,
      endBeat: raw[i].end,
      voiceBeats: raw[i].end - raw[i].start,
    }));
    // tie 链遍历:对每个 tieStart 声部,沿后位同 midi tieEnd 累加(链可能跨多段)
    for (let si = 0; si < slots.length; si++) {
      const [a0, a1] = slots[si];
      for (let ai = a0; ai <= a1; ai++) {
        if (!notes[ai].tieStart || notes[ai].midi === null) continue;
        let addBeats = 0;
        let curSi = si + 1;
        let chainMidi = notes[ai].midi;
        while (curSi < slots.length) {
          const [b0, b1] = slots[curSi];
          let matchedIdx = -1;
          for (let bi = b0; bi <= b1; bi++) {
            if (notes[bi].tieEnd && notes[bi].midi === chainMidi) { matchedIdx = bi; break; }
          }
          if (matchedIdx < 0) break;
          addBeats += out[matchedIdx].voiceBeats;
          out[matchedIdx].voiceBeats = 0;   // tieEnd 声部静默
          if (notes[matchedIdx].tieStart) {  // 链延续(同音高多段)
            curSi++;
            chainMidi = notes[matchedIdx].midi!;
          } else break;
        }
        out[ai].voiceBeats += addBeats;
      }
    }
    return out;
  }

  /** 从指定 beat 开始调度播放。playingFrom() 核心实现。 */
  private playFrom(beat: number): void {
    if (!this.piece || this.schedule.length === 0) return;
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') void ctx.resume();

    // 清掉旧的调度与 rAF
    this.stopAllOscs();
    cancelAnimationFrame(this.rafId);

    this.startCtxTime = ctx.currentTime + 0.06;   // 60ms 前瞻缓冲
    this.startBeat = Math.max(0, Math.min(beat, this.totalBeats));
    const secPerBeat = 60 / this.bpm;
    const originCtxTime = this.startCtxTime - this.startBeat * secPerBeat; // beat=0 对应的 ctx 时间

    // 调度所有「在 beat 之后才结束」的音
    for (const e of this.schedule) {
      if (e.endBeat <= this.startBeat) continue;       // 已完全过去
      const n = this.piece.notes[e.index];
      if (n.midi === null || e.voiceBeats <= 0) continue; // 休止或 tie 静默段不发声

      // 该音实际起止（相对 origin）：被 seek 切开的音从 startBeat 处补发剩余部分
      const segStartBeat = Math.max(e.startBeat, this.startBeat);
      const segEndBeat = e.endBeat;
      const startCtx = originCtxTime + segStartBeat * secPerBeat;
      const durBeats = segEndBeat - segStartBeat;
      const durSec = durBeats * secPerBeat;
      if (durSec <= 0.01) continue;
      this.scheduleNote(ctx, this.master, n.midi, startCtx, durSec);
    }

    this.setState('playing');
    this.lastNoteIdx = -1;
    this.tickLoop(originCtxTime, secPerBeat);
  }

  /** rAF 循环：对照 ctx.currentTime 算当前 beat，推进 UI 回调 */
  private tickLoop(originCtxTime: number, secPerBeat: number): void {
    const ctx = this.ctx!;
    const step = () => {
      if (this.state !== 'playing') return;
      const elapsed = ctx.currentTime - originCtxTime;
      const beat = Math.max(0, elapsed / secPerBeat);

      // 高亮推进：检测进入新音区间
      const idx = this.noteIndexAtBeat(beat);
      if (idx !== this.lastNoteIdx && idx >= 0) {
        this.lastNoteIdx = idx;
        this.cb.onNote?.(idx);
      }

      // 结束判定
      if (beat >= this.totalBeats) {
        this.cb.onTick?.(this.totalBeats);
        this.finish();
        return;
      }
      this.cb.onTick?.(Math.min(beat, this.totalBeats));
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  /** 找 beat 落在哪个音区间内（返回 notes 下标；休止符区间也返回，让符头高亮随停顿移动） */
  private noteIndexAtBeat(beat: number): number {
    for (const e of this.schedule) {
      if (beat >= e.startBeat && beat < e.endBeat) return e.index;
    }
    return -1;
  }

  private finish(): void {
    cancelAnimationFrame(this.rafId);
    this.startBeat = 0;
    this.lastNoteIdx = -1;
    this.setState('stopped');
    this.cb.onEnd?.();
  }

  private setState(s: PlayState): void {
    this.state = s;
    this.cb.onStateChange?.(s);
  }

  // ── 公开控制 ──────────────────────────────────────

  /** 从头播放 */
  play(piece: Piece): void {
    this.piece = piece;
    this.schedule = this.computeSchedule(piece);
    this.totalBeats = this.schedule.length
      ? this.schedule[this.schedule.length - 1].endBeat
      : 0;
    this.playFrom(0);
  }

  /** seek：从指定 beat 开始（playing 态继续播，paused 态保持暂停但更新位置） */
  seek(beat: number, andPlay: boolean): void {
    if (!this.piece) return;
    if (andPlay) {
      this.playFrom(beat);
    } else {
      // 暂停态下只更新位置指针 + 清调度，不发声
      this.stopAllOscs();
      this.startBeat = Math.max(0, Math.min(beat, this.totalBeats));
      this.cb.onTick?.(this.startBeat);
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.startBeat = this.getCurrentBeat();
    this.stopAllOscs();
    cancelAnimationFrame(this.rafId);
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.playFrom(this.startBeat);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.stopAllOscs();
    // 快速淡出 master（若有），避免咔哒
    if (this.ctx && this.master) {
      const t = this.ctx.currentTime;
      try {
        this.master.gain.cancelScheduledValues(t);
        this.master.gain.setValueAtTime(this.master.gain.value, t);
        this.master.gain.linearRampToValueAtTime(0.0001, t + 0.05);
        this.master.gain.linearRampToValueAtTime(0.9, t + 0.08);
      } catch { /* ignore */ }
    }
    this.startBeat = 0;
    this.lastNoteIdx = -1;
    this.setState('stopped');
  }

  /** 单音预览（鼠标悬停时试听） */
  preview(midi: number): void {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + 0.02;
    this.scheduleNote(ctx, this.master, midi, t, 0.4);
  }

  // ── 合成音色（保留原有包络，仅改名） ──────────────────

  private scheduleNote(ctx: AudioContext, master: GainNode, midi: number, start: number, dur: number): void {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const attack = 0.006;
    const decay = 0.12;
    const sustainLevel = 0.35;
    const release = Math.min(0.25, dur * 0.5);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(1, start + attack);
    gain.gain.exponentialRampToValueAtTime(sustainLevel, start + attack + decay);
    gain.gain.setValueAtTime(sustainLevel, start + dur);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur + release);
    gain.connect(master);

    // 基波（三角波）
    const osc1 = ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.value = freq;
    osc1.connect(gain);
    osc1.start(start);
    osc1.stop(start + dur + release + 0.02);

    // 二次谐波（正弦，增加亮度）
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;
    const gain2 = ctx.createGain();
    gain2.gain.value = 0.18;
    osc2.connect(gain2);
    gain2.connect(gain);
    osc2.start(start);
    osc2.stop(start + dur + release + 0.02);

    const endAt = start + dur + release + 0.02;
    const entry = { osc: osc1, gain, endAt };
    this.activeOscs.push(entry);
    osc1.onended = () => {
      const k = this.activeOscs.indexOf(entry);
      if (k >= 0) this.activeOscs.splice(k, 1);
    };
    // osc2 不单独跟踪（随 gain 一起淡出）
  }

  private stopAllOscs(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const e of this.activeOscs) {
      try {
        e.gain.gain.cancelScheduledValues(now);
        e.gain.gain.setValueAtTime(Math.max(e.gain.gain.value, 0.0001), now);
        e.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
        e.osc.stop(now + 0.04);
      } catch { /* already stopped */ }
    }
    this.activeOscs = [];
  }
}
