// 音频播放：Web Audio 合成钢琴音色 + 按拍调度 + 播放头回调

import { Piece, durationBeats } from '../core/types';

export interface PlayerCallbacks {
  /** 播放到第 index 个音符时回调（用于高亮） */
  onNote: (index: number) => void;
  /** 播放结束 */
  onEnd: () => void;
}

export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timers: number[] = [];
  private playing = false;
  private bpm = 100;
  private cb: PlayerCallbacks;

  constructor(cb: PlayerCallbacks) {
    this.cb = cb;
  }

  setBpm(bpm: number): void {
    this.bpm = bpm;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** 预览单个音符（点击五线谱时立刻试听） */
  preview(midi: number | null): void {
    const ctx = this.ensureCtx();
    if (midi === null) return;
    const now = ctx.currentTime;
    this.playNote(ctx, this.master!, midi, now, 0.45);
  }

  /** 从头播放整曲 */
  play(piece: Piece): void {
    if (this.playing) this.stop();
    const ctx = this.ensureCtx();
    const master = this.master!;
    const secPerBeat = 60 / this.bpm;
    let t = ctx.currentTime + 0.08;
    this.playing = true;

    piece.notes.forEach((n, i) => {
      const beats = durationBeats(n.duration, n.dotted);
      const dur = beats * secPerBeat;
      // 高亮回调
      const hi = window.setTimeout(() => {
        if (this.playing) this.cb.onNote(i);
      }, (t - ctx.currentTime) * 1000);
      this.timers.push(hi);
      if (n.midi !== null) {
        this.playNote(ctx, master, n.midi, t, dur);
      }
      t += dur;
    });

    // 结束回调
    const end = window.setTimeout(() => {
      this.playing = false;
      this.cb.onEnd();
    }, (t - ctx.currentTime) * 1000 + 50);
    this.timers.push(end);
  }

  stop(): void {
    this.timers.forEach((id) => clearTimeout(id));
    this.timers = [];
    this.playing = false;
    if (this.master) {
      // 快速淡出，避免咔哒
      try {
        this.master.gain.cancelScheduledValues(this.ctx!.currentTime);
        this.master.gain.setValueAtTime(this.master.gain.value, this.ctx!.currentTime);
        this.master.gain.linearRampToValueAtTime(0.0001, this.ctx!.currentTime + 0.05);
        this.master.gain.linearRampToValueAtTime(0.9, this.ctx!.currentTime + 0.08);
      } catch {
        /* noop */
      }
    }
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** 合成一个钢琴味的单音：基波 + 倍频，加 ADSR */
  private playNote(ctx: AudioContext, dest: GainNode, midi: number, start: number, dur: number): void {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const attack = 0.006;
    const decay = 0.12;
    const sustainLevel = 0.35;
    const release = Math.min(0.25, dur * 0.5);
    const peak = 0.6;

    const voiceGain = ctx.createGain();
    voiceGain.connect(dest);

    // 基波（三角波，柔和）
    const osc1 = ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.value = freq;
    osc1.connect(voiceGain);

    // 二倍频（正弦，少量，增加亮度）
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    osc2.connect(g2);
    g2.connect(voiceGain);

    // ADSR
    const g = voiceGain.gain;
    g.setValueAtTime(0.0001, start);
    g.exponentialRampToValueAtTime(peak, start + attack);
    g.exponentialRampToValueAtTime(Math.max(sustainLevel * peak, 0.001), start + attack + decay);
    const end = start + dur;
    g.setValueAtTime(Math.max(sustainLevel * peak, 0.001), Math.max(end, start + attack + decay));
    g.exponentialRampToValueAtTime(0.0001, end + release);

    osc1.start(start);
    osc2.start(start);
    osc1.stop(end + release + 0.02);
    osc2.stop(end + release + 0.02);
  }
}
