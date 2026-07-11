# PracticeApp + 顶栏 + 节拍器设计（技术文档）

> 本文档供新 session 执行用。自包含——读完即可理解背景、目标、方案。
>
> 配套文档：`docs/练琴页需求.md`（产品需求）、`docs/ScoreSheet组件设计.md`（谱面）、`docs/钢琴与方块组件设计.md`（键盘+方块）。

---

## 一、背景

### 1.1 练琴页整体架构

练琴页由一个 controller（PracticeApp）和若干组件构成：

```
PracticeApp（controller）
  ├─ 创建并持有 Player（新建，不共享编辑器的）
  ├─ 创建并持有各组件（持有 handle）
  │   ├─ ScoreSheet（谱面，已完成）
  │   ├─ Keyboard（键盘+高亮，开发中）
  │   ├─ Waterfall（方块掉落，开发中）
  │   ├─ PracticeControls（顶栏控制，本文档）
  │   └─ Metronome（节拍器脉冲，本文档）
  ├─ 持有乐谱数据 Score
  ├─ 持有练琴状态（handFilter / abRange / metroOn / speed）
  └─ player.onTick(beat) → 分发给所有组件
```

### 1.2 本文范围

本文定义三个还缺的部分：
- **PracticeApp**：练琴页的 controller，串起所有组件 + Player
- **PracticeControls**：顶栏控制组件（播放/变速/AB/单手/节拍器/设置）
- **Metronome**：节拍器脉冲组件

键盘和方块的设计见 `docs/钢琴与方块组件设计.md`，不在本文展开。

### 1.3 组件模式

遵循项目的命令式工厂 + Handle 模式（详见 `src/ui/playback-card.ts`）：
- `buildXxx(initial, callbacks): Handle`
- Handle = `{ el, onTick(beat)?, ...命令式方法 }`
- 组件不调 App 方法，只通过 callbacks 报告事件
- App 持有数据，onTick 里逐个调各组件的更新方法

---

## 二、PracticeApp（controller）

### 2.1 职责

1. **创建 Player**：新建独立 Player 实例（不共享编辑器的），绑定 onTick/onStateChange/onEnd 回调
2. **创建并装配组件**：构建 ScoreSheet/Keyboard/Waterfall/PracticeControls/Metronome，挂到 DOM
3. **事件分发**：onTick(beat) 里逐个调各组件的 onTick/更新方法
4. **算"当前响的音"**：从 beat + score 算出当前正在响的原始 midi 集合，喂给键盘
5. **练琴状态管理**：handFilter / abRange / metroOn / speed / playState
6. **AB 循环**：onTick 里检测播放越过 B 点 → 自动 seek 到 A
7. **持久化**：键宽/高度/变速等设置存 localStorage

### 2.2 新建 Player（不复用编辑器的）

练琴页新建自己的 Player 实例。理由：
- 练琴页和编辑器生命周期不同（进练琴页时编辑器暂停，返回时恢复）
- AB 循环/变速是练琴页专属状态，不污染编辑器的 Player
- AudioContext 可以共用浏览器的（不冲突），但 Player 状态独立

PracticeApp 构造时：
```ts
this.player = new Player({
  onTick: (beat) => this.onTick(beat),
  onStateChange: (s) => this.onStateChange(s),
  onEnd: () => this.onEnd(),
});
this.player.setPiece(...);  // 用整曲 rangeToPiece 设置
```

### 2.3 onTick 事件分发

```
onTick(beat):
  this.currentBeat = beat                        // 单一数据源

  // AB 循环检测（详见 §2.5）
  if (this.abRange && beat >= this.abRange.b) {
    this.player.seek(this.abRange.a);
    return;  // seek 后等下一帧
  }

  // 分发给各组件
  this.scoreSheet.onTick(beat);                  // 谱面：行滚动 + 符头高亮
  this.waterfall.onTick(beat);                   // 方块：位置 + 命中
  this.keyboard.setActiveMidis(                  // 键盘：点灯
    this.computeActiveMidis(beat)                //   ← controller 算原始 midi
  );
  this.metronome.onTick(beat);                   // 节拍器：脉冲
  this.controls.setProgress(beat);               // 顶栏：状态更新
```

### 2.4 "当前响的音"谁算

**PracticeApp 算**，不算在键盘组件里。

从 `playback-card.ts:377-397` 的 `computeActiveMidis` 抽出逻辑，改成纯函数：

```ts
// src/practice/active-midis.ts
/** 从 beat + score 算出当前正在响的原始 midi 集合（含和弦组）。
 *  从 playback-card.ts:computeActiveMidis 抽出，去掉 getView() 耦合。 */
export function computeActiveMidis(
  beat: number,
  trebleNotes: Note[],
  bassNotes: Note[],
): number[]
```

PracticeApp.onTick 里调它，把结果（原始 midi）传给 `keyboard.setActiveMidis`。键盘自己根据指法模式映射后点灯。

### 2.5 AB 循环（放 PracticeApp，不改 Player）

AB 循环是练琴页专属逻辑，放 PracticeApp 的 onTick 里检测：

```
onTick(beat):
  if (this.abRange && beat >= this.abRange.b) {
    this.player.seek(this.abRange.a);
    return;
  }
  ...
```

不改 Player——保持 Player 通用。AB 的 A/B 点是 PracticeApp 持有的状态（小节号），onTick 里换算成 beat 比较。

**AB 区间来源**：进度融进谱面（点击谱面小节 = 设 A/B 点），不在进度条上拖滑块。详见 `docs/练琴页需求.md` §3.3。

### 2.6 onStateChange / onEnd

```
onStateChange(state):
  this.playState = state
  if (state === 'stopped') {
    this.currentBeat = 0
    this.keyboard.clearHighlight()
    this.scoreSheet.onTick(0)   // 重置谱面高亮
  }
  this.controls.setState(state)  // 更新顶栏播放按钮图标

onEnd():
  this.playState = 'stopped'
  this.keyboard.clearHighlight()
  this.controls.setState('stopped')
```

### 2.7 组件间协调

PracticeApp 作为中心，协调组件间的数据流：

| 协调点 | 触发 → 消费 | 数据 |
|---|---|---|
| 方块区上边界 | ScoreSheet `onLineLayout` 回调 → PracticeApp → `waterfall.setBounds` | 当前行底部 y、行高 |
| 键盘高度变化 | Keyboard `onHeightChange` → PracticeApp → `waterfall.setBounds` | 新高度（判定线移动） |
| 键宽变化 | Keyboard `onRangeChange` → PracticeApp → `waterfall.setRange` | 新音域（midiToX 重算） |
| 单手切换 | Controls `onHand` → PracticeApp → `waterfall.setHandFilter` + 键盘高亮过滤 | handFilter |
| AB 设置 | 谱面点击 → PracticeApp → 存储 abRange | A/B 小节号 |
| 变速 | Controls `onSpeed` → PracticeApp → `player.setBpm` | speed 倍率 |

### 2.8 接口设计

```ts
export interface PracticeAppInitial {
  score: Score;              // 完整乐谱（从编辑器传入，见 §2.9 数据传递）
  root: HTMLElement;         // 练琴页挂载点（练琴页 host 元素）
  savedSettings?: PracticeSettings;  // 持久化设置（键宽/高度/标注等，见 §3.5）
}

export interface PracticeSettings {
  keyWidth?: number;         // 白键宽 px（键盘组件用）
  keyboardHeight?: number;   // 键盘高度 px
  labels?: 'name' | 'solfege' | 'octave' | 'none';
  fingering?: 'cfixed' | 'follow';
  mode?: 'staff' | 'jianpu' | 'both';  // 谱面档
}

export class PracticeApp {
  constructor(initial: PracticeAppInitial);
  /** 挂载到 DOM（装配所有组件） */
  mount(): void;
  /** 卸载（离开练琴页时清理：停播放、移除 DOM、释放资源） */
  destroy(): void;
  /** 获取当前设置（离开时存 localStorage 用） */
  getSettings(): PracticeSettings;
}
```

PracticeApp 不返回 Handle——它是最外层 controller，被入口代码（app.ts 的视图切换）直接持有。

### 2.9 入口接线（数据传递 + 返回状态恢复）

#### 三级页面结构

app.ts 现有两级（library → editor）。练琴页加为第三级：

```
appView: 'library' | 'editor' | 'practice'
```

app.ts `buildDOM()` 增加 `practiceHost`（第三级宿主，初始 hidden）。

#### 数据传递：进练琴页

从编辑器进入练琴页时，**直接传引用，不重新加载**：

```
openPractice():
  this.player.stop()           // 停编辑器播放
  this.practiceApp = new PracticeApp({
    score: this.score,          // 直接传编辑器的 Score 引用（只读使用）
    root: this.practiceHost,
    savedSettings: loadPracticeSettings(),  // localStorage 读
  })
  this.practiceApp.mount()
  switchToPractice()            // 隐藏 editor，显示 practice
```

PracticeApp 只读使用 Score，不改它（练琴页不改谱）。返回后编辑器的 Score 完好。

#### 状态恢复：返回编辑器

练琴页"返回"按钮：

```
onBack():
  this.practiceApp.destroy()             // 停练琴页播放、移除 DOM
  savePracticeSettings(this.practiceApp.getSettings())  // 存设置到 localStorage
  this.practiceApp = null
  switchToEditor()                        // 隐藏 practice，显示 editor
  // 编辑器恢复：播放已停、视图不变、Score 完好
```

destroy 必须做的事：
- `player.stop()`（停练琴页的 Player）
- `player.disconnect()`（释放 AudioContext 资源）
- 移除 practiceHost 的 innerHTML
- 清除所有事件监听（resize、快捷键等）

#### 练琴设置持久化

```ts
// localStorage key: "practiceSettings"
// 结构：PracticeSettings（见 §2.8）
// 存取时机：进练琴页时读、返回时写
function loadPracticeSettings(): PracticeSettings { ... }
function savePracticeSettings(s: PracticeSettings): void { ... }
```

设置是**全局的**（不分曲子）——用户的键宽/高度/标注偏好，换曲子也保持。

---

## 三、PracticeControls（顶栏控制组件）

### 3.1 职责

承载练琴页所有控制，单行布局。形态参考 `practice-prototype.html` 的 `.pr-bar`（已验证的布局）。

### 3.2 布局（单行，参考原型）

```
┌──────────────────────────────────────────────────────────┐
│ ← 小星星 C大调 4/4  ⏸  AB循环 双手/右手/左手 ♪  ♩=100  ⚙ │
└──────────────────────────────────────────────────────────┘
 左：返回+曲名+调号拍号  中右：练习模式+变速+设置
```

| 位置 | 元素 | 说明 |
|---|---|---|
| 左 | 返回、曲名、调号拍号 | 静态信息 |
| 中左 | 播放/暂停（小圆按钮，克制） | 最高频操作；停止靠快捷键 |
| 中右 | AB循环（胶囊开关）、单手（分段控件）、节拍器（带脉冲点开关） | 练习模式，频繁切换 |
| 右 | 变速滑块 + BPM数字、设置(⚙) | 变速常驻（降速是核心）；设置含键盘音域/键面标注 |

### 3.3 进度控制：融进谱面（不在顶栏）

进度条不做独立控件。进度 = 谱面当前小节高亮；跳转 = 点击谱面小节；AB 标记标在谱面对应小节。详见 `docs/练琴页需求.md` §3.3。

### 3.4 接口设计

```ts
export interface PracticeControlsInitial {
  title: string;
  keyLabel: string;        // 如 "C 大调"
  timeSig: string;         // 如 "4/4"
  bpm: number;
  handFilter: 'both' | 'R' | 'L';
  metroOn: boolean;
  abOn: boolean;
  speed: number;           // 变速倍率
}

export interface PracticeControlsCallbacks {
  onBack: () => void;
  onTogglePlay: () => void;
  onHand: (hand: 'both' | 'R' | 'L') => void;
  onMetro: (on: boolean) => void;
  onAb: (on: boolean) => void;
  onSpeed: (speed: number) => void;
  onOpenSettings: () => void;
}

export interface PracticeControlsHandle {
  el: HTMLElement;
  setState(state: 'stopped' | 'playing' | 'paused'): void;  // 更新播放按钮图标
  setBpm(bpm: number): void;
}
```

### 3.5 设置面板(⚙)

点顶栏 ⚙ 展开浮层面板，收纳"配一次不常动"的选项。面板可参考 `practice-prototype.html` 的 `.pr-settings`（点 ⚙ 切换 open class，点外部关闭）。

**面板内容**：

| 选项 | 控件 | 说明 |
|---|---|---|
| 谱面模式 | 分段控件（五线谱/简谱/双谱） | 切换 ScoreSheet 的 mode。切换后行高变，渐变/方块区跟着重算 |
| 键盘音域 | 文字提示（如"C3–C5 · 自动"）+ 可选手动调 | 实际调整通过浮空卡片（见键盘组件文档 §3.3），面板里只显示当前值或提供快捷预设 |
| 键面标注 | 分段控件（音名/唱名/关闭） | 切换键盘的 labels |
| 指法模式 | 分段控件（固定C调/跟随调号） | 切换键盘的 fingering（cfixed/follow） |

**面板行为**：
- 点 ⚙ 切换 `open` class（显/隐）
- 点面板外部关闭（document click 检测）
- 面板里的选项变化立即生效（通过 callbacks 通知 PracticeApp → 分发到对应组件）
- 所有选项的变化要持久化（PracticeApp 存 localStorage，见 §2.9）

**注意**：变速滑块不放设置面板——它是练琴核心控制（降速练），常驻顶栏。设置面板只放低频选项。
```

---

## 四、Metronome（节拍器脉冲组件）

### 4.1 职责

视觉打拍：判定线随节拍脉冲闪烁 + 顶栏节拍器开关的指示点同步脉冲。

### 4.2 脉冲逻辑

```
onTick(beat):
  beatFloor = Math.floor(beat)
  if (beatFloor !== lastBeatFloor) {
    lastBeatFloor = beatFloor
    pulse()  // 判定线 + 指示点闪一下（100ms）
  }
```

每整数拍触发一次脉冲。脉冲是短暂的视觉效果（100ms 内亮起再消退）。

### 4.3 两个脉冲点

1. **判定线**（`.pr-hit`）：键盘上方的判定线随拍闪烁
2. **顶栏指示点**（`.pr-metro .dot`）：节拍器开关里的圆点同步闪烁

两者由 Metronome 组件统一驱动（Metronome 持有这两个 DOM 元素的引用）。

### 4.4 开关

节拍器可开关。关闭时不脉冲。开关在顶栏 PracticeControls 里，但脉冲逻辑在 Metronome 组件里（PracticeControls 只管 UI 状态，Metronome 管"打拍"）。

### 4.5 可选：打点音

未来可加 click 音（Web Audio 合成短促音）。MVP 只做视觉脉冲，不打点音。

### 4.6 接口设计

```ts
export interface MetronomeInitial {
  hitEl: HTMLElement;     // 判定线元素
  dotEl: HTMLElement;     // 顶栏指示点元素
  enabled: boolean;
}

export interface MetronomeHandle {
  onTick(beat: number): void;
  setEnabled(on: boolean): void;
}
```

Metronome 没有 callbacks（它只接收驱动，不向外报告）。没有 el（它操作的是外部传入的 DOM 元素）。

---

## 五、文件结构

```
src/practice/
  ├─ score-sheet.ts        ← 已完成
  ├─ score-sheet.css       ← 已完成
  ├─ key-coords.ts         ← 开发中（键盘方块新 session）
  ├─ keyboard.ts           ← 开发中
  ├─ waterfall.ts          ← 开发中
  ├─ active-midis.ts       ← 本文：computeActiveMidis 纯函数
  ├─ practice-app.ts       ← 本文：controller
  ├─ practice-controls.ts  ← 本文：顶栏
  └─ metronome.ts          ← 本文：节拍器
```

---

## 六、实施步骤

### Step 1：active-midis 纯函数
- 建 `src/practice/active-midis.ts`
- 从 `playback-card.ts:377-397` 抽出 computeActiveMidis，去掉 getView() 耦合
- 改成接收 beat + trebleNotes + bassNotes 的纯函数
- 验证：传入 beat，正确返回当前响的 midi 集合（含和弦组）

### Step 2：Metronome 组件
- 建 `src/practice/metronome.ts`
- 实现 onTick（整数拍脉冲）、setEnabled
- 验证：播放时判定线 + 指示点随拍闪烁

### Step 3：PracticeControls 组件 + 设置面板
- 建 `src/practice/practice-controls.ts`
- 参考原型 `.pr-bar` 的布局和样式（单行，返回+曲名+播放+练习模式+变速+设置）
- 实现所有控件 + callbacks
- **设置面板(⚙)**：谱面模式分段、键面标注分段、指法模式分段、键盘音域显示（§3.5）
- 设置面板行为：点 ⚙ 切换、点外部关闭、变化立即生效
- 验证：播放/暂停切换、AB/单手/节拍器开关、变速滑块、设置面板各项生效

### Step 4：PracticeApp 骨架
- 建 `src/practice/practice-app.ts`
- 新建 Player，绑定回调
- 装配所有组件（键盘方块用占位/真实 handle）
- 实现 onTick 分发、onStateChange、onEnd
- 实现 AB 循环检测
- 实现 getSettings（收集各组件当前设置）
- 验证：整页跑通——播放驱动谱面滚动 + 方块掉落 + 键盘点灯 + 节拍器脉冲

### Step 5：入口接线（数据传递 + 状态恢复）
- app.ts 加 `practiceHost`（第三级宿主）+ `appView: 'practice'`
- `openPractice()`：停编辑器播放 → 传 Score 引用 → 创建 PracticeApp → mount → 切视图
- 练琴页"返回"：destroy（停播放+移除DOM+释放资源）→ 存设置 → 切回编辑器
- `loadPracticeSettings()` / `savePracticeSettings()`：localStorage 读写
- 验证：进练琴页拿到正确 Score、播放正常；返回后编辑器完好、设置已存；再次进入设置恢复

---

## 七、关键风险

1. **组件接口对齐**：PracticeApp 装配时依赖 ScoreSheet/Keyboard/Waterfall 的真实接口。如果它们的接口和各自设计文档有偏差，controller 装配会出问题。实施前要确认三个组件的实际接口（ScoreSheet 已完成可读代码确认，键盘方块等开发完确认）。
2. **AB 循环的 beat 换算**：AB 点是小节号（用户点谱面小节设的），onTick 里要换算成 beat（`measure × beatsPerBar`）。浮点比较要用 BEAT_EPS 容差。
3. **computeActiveMidis 的和弦逻辑**：和弦组（同 chordId）的音都要返回。从 playback-card 抽时要完整搬，不能简化（playback-card L384-388 的 chordId 遍历逻辑）。
4. **destroy 清理**：离开练琴页时要停播放、移除 DOM、释放 AudioContext 资源（如果有）。不能泄漏。
5. **变速的实现**：变速是改 Player 的 BPM（`player.setBpm(baseBpm × speed)`），不是改 onTick 的 dt。要用 Player 的官方 API。
6. **节拍器脉冲的性能**：脉冲是 setTimeout 100ms 清除 class，每拍一次。频率不高，但要确保不堆积（清除上一次的定时器）。
7. **Score 引用传递的只读安全**：PracticeApp 直接持有编辑器的 Score 引象，**绝不能改它**。如果 ScoreSheet/Keyboard 内部有修改乐谱的操作（不应该有），会污染编辑器。要确保组件只读使用 Score。
8. **设置面板联动行高**：切换谱面模式（staff/jianpu/both）时行高变，ScoreSheet 的 onLineLayout 回调要重新触发，PracticeApp 要转发给 Waterfall 更新方块区上边界。不能漏。
9. **返回时的编辑器恢复**：返回后编辑器的播放已停（进练琴页时停的），但视图状态（当前编辑区、书签等）应该不变。不要在进出练琴页时动编辑器的编辑状态。

---

## 附：关键文件速查

| 文件 | 作用 |
|---|---|
| `src/audio/player.ts` | 播放引擎（onTick 时钟源） |
| `src/ui/playback-card.ts:377-397` | computeActiveMidis 来源（抽到 active-midis.ts） |
| `src/ui/app.ts:147-172` | 现有 onTick 分发模式（PracticeApp 参考） |
| `practice-prototype.html` | 原型（顶栏布局 + 节拍器脉冲逻辑参考） |
| `docs/练琴页需求.md` | 整体产品需求 |
| `docs/ScoreSheet组件设计.md` | 谱面组件（已完成） |
| `docs/钢琴与方块组件设计.md` | 键盘+方块组件（开发中） |
