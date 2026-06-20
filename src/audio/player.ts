// 音频播放：Web Audio 合成钢琴音色 + 按拍调度 + 播放头回调

import { Piece, durationBeats } from '../core/types';
import { isChordTail } from '../core/model';

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
    const notes = piece.notes;

    // 预算每个音的「实际发声音长」：连音线(tie)把同音高音(可跨和弦声部)合并成一个长音。
    // tie 链的起点音吃掉整条链的总时长；链中每个 tieEnd 音发声音长=0（不重新起振，只推进时间）。
    // 配对按「时间位 + 同 midi」:前位的 tieStart 声部 ↔ 后位的 tieEnd 声部(同 midi 才连)。
    // 这同时支持单音 tie(相邻同音高)与和弦 tie(复制组各声部与源组对应声部 midi 全等)。
    const voiceDur = notes.map(n => durationBeats(n) * secPerBeat);
    // 切时间位:连续同 chordId 归一段;无 chordId 单音自成一段
    const slots: [number, number][] = [];
    for (let i = 0; i < notes.length;) {
      const cid = notes[i].chordId;
      let j = cid ? i : i + 1;
      if (cid) while (j < notes.length && notes[j].chordId === cid) j++;
      slots.push([i, j - 1]);
      i = j;
    }
    // 对每个 tieStart 声部,沿「后位同 midi tieEnd」向后累加时长(tie 链可能跨多个时间位)
    for (let si = 0; si < slots.length; si++) {
      const [a0, a1] = slots[si];
      for (let ai = a0; ai <= a1; ai++) {
        const a = notes[ai];
        if (!a.tieStart || a.midi === null) continue;
        // 沿后续时间位找同 midi 的 tieEnd 声部,累加其 voiceDur 到起点 a,并把它们置 0
        let acc = voiceDur[ai];
        let curSi = si + 1;
        let chainMidi = a.midi;
        // 链可能持续:后位的 tieEnd 同时又是再后位的 tieStart(同音高延续多段)
        while (curSi < slots.length) {
          const [b0, b1] = slots[curSi];
          // 找该位中 tieEnd 且 midi===chainMidi 的声部
          let matchedIdx = -1;
          for (let bi = b0; bi <= b1; bi++) {
            if (notes[bi].tieEnd && notes[bi].midi === chainMidi) { matchedIdx = bi; break; }
          }
          if (matchedIdx < 0) break;   // 后位无匹配 tieEnd → 链终止
          acc += voiceDur[matchedIdx];
          voiceDur[matchedIdx] = 0;
          // 若该匹配音同时也是下一段的 tieStart(且下一位同 midi),继续延长
          if (notes[matchedIdx].tieStart) {
            curSi++;
            chainMidi = notes[matchedIdx].midi!;   // 同音高链
          } else {
            break;
          }
        }
        voiceDur[ai] = acc;
      }
    }

    let t = ctx.currentTime + 0.08;
    this.playing = true;

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const dur = voiceDur[i];
      const tail = isChordTail(n, i > 0 ? notes[i - 1] : null);
      // 高亮回调（每个音都高亮，tie 两端与和弦各声部视觉上都该亮）
      const hi = window.setTimeout(() => {
        if (this.playing) this.cb.onNote(i);
      }, (t - ctx.currentTime) * 1000);
      this.timers.push(hi);
      if (n.midi !== null && dur > 0) {
        this.playNote(ctx, master, n.midi, t, dur);   // 和弦各声部同 t 触发 → 同时发声
      }
      // 时间轴推进:和弦尾音与首音同时,不推进;首音/普通音按其时值推进。
      if (!tail) {
        t += durationBeats(n) * secPerBeat;
      }
    }

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
