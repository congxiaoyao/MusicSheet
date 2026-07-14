// Metronome —— 节拍器视觉脉冲组件。
//
// 职责:每整数拍触发一次短暂脉冲，让「判定线」和「顶栏节拍器指示点」同步闪一下。
// 设计文档:docs/PracticeApp与顶栏节拍器设计.md §4。
//
// 模式:命令式工厂 + Handle。无 callbacks(只接收驱动)、无 el(操作外部传入的两个 DOM 元素)。
// - onTick(beat):controller 每帧调；内部 Math.floor(beat) 整数拍变化时 pulse。
// - setEnabled(on):开关。关闭时不脉冲。
// 脉冲复刻 prototype L814-821:setTimeout 100ms 移除 class。
// 关键:每拍先 clear 上一 timer，防止连过数拍时 timer 堆积(文档风险 §6)。

import './metronome.css';

export interface MetronomeInitial {
  /** 判定线元素(键盘上方那条线，随拍闪烁)。由 PracticeApp 创建并定位。 */
  hitEl: HTMLElement;
  /** 顶栏节拍器开关里的指示点(.pr-metro .dot)。同步闪烁。由 PracticeControls 创建，引用传入。 */
  dotEl: HTMLElement;
  /** 初始开关。 */
  enabled: boolean;
}

export interface MetronomeHandle {
  /** controller 每帧调:整数拍变化时触发脉冲。 */
  onTick(beat: number): void;
  /** 开关。关闭时不脉冲。 */
  setEnabled(on: boolean): void;
}

const PULSE_MS = 100;

/** 构建节拍器脉冲组件。返回 Handle。 */
export function buildMetronome(initial: MetronomeInitial): MetronomeHandle {
  let enabled = initial.enabled;
  let lastBeatFloor = -1;
  /** 是否已与播放节拍同步过(避免构造后首次 onTick 就闪一下虚假脉冲)。 */
  let primed = false;
  /** 重启节拍器后置位:下次 onTick 即使 floor 没变也强制脉冲一次(给用户重启反馈)。 */
  let needsKick = false;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;

  function pulse(): void {
    // 先清上一拍遗留的 timer，防止连过数拍时 timer 堆积。
    if (pulseTimer !== null) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
    initial.hitEl.classList.add('pulse');
    initial.dotEl.classList.add('pulse');
    pulseTimer = setTimeout(() => {
      initial.hitEl.classList.remove('pulse');
      initial.dotEl.classList.remove('pulse');
      pulseTimer = null;
    }, PULSE_MS);
  }

  return {
    onTick(beat: number) {
      if (!enabled) return;
      const bf = Math.floor(beat);
      if (bf !== lastBeatFloor) {
        lastBeatFloor = bf;
        // 首次同步只记录拍、不脉冲(避免进练琴页第一次 onTick 的虚假闪烁)。
        if (primed) pulse();
        else needsKick = false;   // 已有新拍，重启 kick 作废
        primed = true;
      } else if (needsKick) {
        // floor 没变但刚重启过:强制脉冲一次。
        pulse();
        needsKick = false;
      }
    },
    setEnabled(on: boolean) {
      const wasOff = !enabled;
      enabled = on;
      if (!on) {
        // 关闭时立即清除残留脉冲。
        if (pulseTimer !== null) {
          clearTimeout(pulseTimer);
          pulseTimer = null;
        }
        initial.hitEl.classList.remove('pulse');
        initial.dotEl.classList.remove('pulse');
      } else if (wasOff) {
        // 重新启用:置 kick，下次 onTick(无论是否换拍)立刻脉冲一次作反馈。
        needsKick = true;
      }
    },
  };
}
