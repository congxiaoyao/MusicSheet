# ScoreSheet 组件设计（技术文档）

> 本文档供新 session 执行用。自包含——读完即可理解背景、目标、方案，无需翻阅设计对话。

---

## 一、项目现状

### 1.1 这是什么项目

MusicSheet 是一个**纯原生 TypeScript（零框架）**的五线谱↔简谱编辑与播放工具。自研 SVG 渲染引擎 + Web Audio 合成钢琴音色。

- 技术栈：原生 TS + Vite，无 React/Vue，全部手写 DOM + 内联 SVG
- 字体：Bravura（SMuFL 音乐符号字体），字形码点表在 `src/render/smufl-codepoints.json`
- 后端：纯 Node `http` 模块，文件系统存储
- 详细架构见 `docs/开发交接-曲谱项目管理重构.md`

### 1.2 现有页面结构

两级页面，靠显隐 DOM 容器实现（无前端路由库）：

```
曲谱库（一级页，library.ts）
  └─ 编辑器（二级页，app.ts）
       ├─ 编辑卡片（录入：点击五线谱落点，追加式录入）
       ├─ 工具盘（tools-panel.ts：时值/调号/拍号/MeasureSelector）
       └─ 放音卡片（playback-card.ts：播放控制+seek+键盘高亮）
```

### 1.3 现有的两种"谱面"能力（务必区分，ScoreSheet 只替代其中一种）

项目里有**两套互不相干的谱面系统**，极易混淆：

| | 整曲预览弹窗 | viewMode=preview 只读卡 |
|---|---|---|
| **文件** | `render/full-score.ts` + `ui/score-preview-modal.ts` | `app.ts` 内 `renderPreview()` + `render/export.ts:buildGrandSVG` |
| **形态** | 模态遮罩弹窗，点"预览"打开，多行纸质谱，点小节跳编辑区 | 编辑器内切换的只读双谱表卡 |
| **渲染** | `buildFullScoreSVG`（堆叠单行渲染器） | `buildGrandSVG`（treble+bass 双谱表 translate 堆叠） |
| **本组件是否动它** | **删掉，ScoreSheet 替代** | **不动**，属于另一套系统 |

> ⚠️ 执行删除时切勿误删 `buildGrandSVG` / `renderPreview()` / `previewHost`。它们是编辑器的 preview 视图模式，与 ScoreSheet 无关。

### 1.4 现有组件模式（ScoreSheet 必须遵循）

项目所有 UI 组件用**命令式工厂 + Handle** 模式：

```ts
// 工厂函数：接收数据 + 回调，返回 Handle
export function buildXxx(
  initial: XxxState,        // 或 getView: () => XxxState（拉取最新数据）
  cb: XxxCallbacks,         // 组件→外的事件回调
): XxxHandle {
  const el = h('div', 'xxx');
  // ... 建内部 DOM、绑事件 ...
  function refresh(data) { /* 推入新数据更新 */ }
  return { el, refresh, /* 其他命令式方法 */ };
}

// Handle 结构：el + refresh + 组件特定方法
export interface XxxHandle {
  el: HTMLElement;
  refresh: (data: XxxState) => void;
  // 命名约定：下划线前缀 = 细粒度钩子（如 _setProgress、_updateHighlight）
}
```

**关键约定**：
- 组件**不调用 App 方法**，只通过 callbacks 向外报告事件
- 数据流：App 持有权威数据 → `refresh()` 推入 或 getter 拉取
- 高频更新（如播放 onTick）走细粒度命令式方法，不走全量 refresh
- App 作为中心，在 onTick 里逐个调各组件的更新方法（不是观察者/广播）

详见 `ui/playback-card.ts`（最完整的组件范例）和 `ui/app.ts:147-172`（onTick 分发）。

### 1.5 现有渲染层的复用边界

ScoreSheet 要复用的渲染零件（执行前必读这些文件）：

| 文件 | 可复用部分 | 备注 |
|---|---|---|
| `render/glyphs.ts` | `G` 字形表、`ensureFontLoaded`、`advanceSS`、几何工具 | 100% 直接 import |
| `render/layout.ts` | `computeLayout`（单行布局）、`Layout` 类型 | **按行调用**（每行 treble/bass 各一次），本身不感知多行 |
| `render/jianpu.ts` | `renderJianpuSVG` | 简谱渲染，档2/档3 用 |
| `render/staff.ts` | 纯绘制子函数（`renderStaffLines`/`renderClef`/`renderNote`/`renderBeams` 等） | **参考自己组装**，不直接调（见下） |
| `core/model.ts` | `noteStartBeats`、`measureOfBeat`、`barLineBeats`、`snapBeat`/`BEAT_EPS` | 拍位计算 |
| `core/types.ts` | `beatsPerBar`、`durationBeats` | |

**关于 staff.ts 的复用策略**：`staff.ts` 的 `renderStaffSVG` 会画编辑专属的 `renderNextSlot`（下一个待输入位指示器）和 `renderHover`（悬停 ghost 音），练琴页不需要。ScoreSheet **自己组装** staff.ts 的纯绘制子函数的等价逻辑，跳过编辑耦合部分。**不侵入 staff.ts**（保持编辑层零回归）。这与 `full-score.ts` 当年的做法一致，`docs/整曲预览重做需求.md` 也明确"允许在新文件内重写部分渲染原语"。

---

## 二、练琴页：ScoreSheet 的归属

### 2.1 为什么要有练琴页

现有产品只有"编辑器"，定位是"把曲子做出来"。但没有"练琴"场景——编辑完一首曲子后，用户没有地方**沉浸地反复练**。

练琴页定位为**第三级页面**（曲谱库 → 编辑器 → 练琴），是编辑完成后的**主要练琴场景**。完整练琴页的需求见 `docs/练琴页需求.md`。

### 2.2 练琴页的核心形态：瀑布流 + 谱面融合

练琴页主视图是**音游式键位提示与纸质谱面的融合体**（不是并列，是叠加）：

```
┌──────────────────────────────────────────────┐
│ ← 曲名 调号 ⏸ ♩=100  AB 双手 ♪ 变速    ⚙   │ 顶栏
├──────────────────────────────────────────────┤
│  ▍当前行（清晰）—— 谱号 小节 音符            │
│   （半透明）后续行向下铺开                    │ ← ScoreSheet 管这块
│        ▓▓      ▓▓         方块向下掉落        │ ← 瀑布流组件（另一个）
│   ━━━━━━━━━━━━━ 判定线                      │
│   🎹🎹🎹🎹🎹🎹🎹  键盘                       │ ← 键盘组件（另一个）
└──────────────────────────────────────────────┘
```

- **谱面**（ScoreSheet）占据屏幕主体，多行纸质谱从上到下铺开
- **当前演奏行**清晰，其余行半透明（卡拉OK式聚焦）
- **瀑布流方块**从当前行底部开始，向下掉到键盘上方判定线
- **键盘**在屏幕底部

### 2.3 ScoreSheet 在练琴页中的角色

ScoreSheet 是练琴页的**核心组件**。它**不是**编辑器预览弹窗那种"附属查看器"，而是练琴主场景的视觉主体。

**它替代并删除现有的整曲预览弹窗**（`full-score.ts` + `score-preview-modal.ts`）。ScoreSheet 是项目里**唯一的多行谱面渲染层**——不存在"静态纸质谱"和"动态预览"之分，一个组件同时承担渲染和播放跟随。

> 注：练琴页其他组件（瀑布流方块、键盘、节拍器、PracticeApp controller）是**后续 plan 的范围**，不在本组件设计内。但 ScoreSheet 要为它们预留协调接口（见下"对外回调"）。

---

## 三、ScoreSheet 职责

### 3.1 核心职责

1. **渲染整个乐谱**：接收完整 Score 数据，渲染多行大谱表（三档可切）
2. **密度驱动的换行**：行内小节数按音符密度动态决定（见 §5）
3. **提词器式行滚动**：当前演奏行锁定顶部清晰带，换行平滑上推
4. **卡拉OK式渐变**：当前行清晰，后续行半透明
5. **高亮当前符头**：随播放高亮当前正在响的符头（= 谱面播放头，**必需**，见 §4）
6. **对外提供布局信息**：当前行底部位置等（供瀑布流组件对齐方块区上边界）

### 3.2 不在 ScoreSheet 范围

- 瀑布流方块、键盘、节拍器（独立组件）
- 播放引擎（复用现有 `audio/player.ts`）
- 练琴页顶栏控制
- PracticeApp controller（后续 plan）

---

## 四、谱面播放头（必需，不是可选）

### 4.1 形态：高亮当前符头

谱面播放头 = **高亮当前正在响的符头本身**（变色/放大/光环），**不是竖线**。

### 4.2 与瀑布流方块的分工

两者职责不重叠，这是设计的关键：

| | 瀑布流方块 | 谱面符头高亮 |
|---|---|---|
| 管什么 | "接下来按什么"（时间推进 + 预告） | "当前这个音在谱上哪个位置"（空间定位） |
| 维度 | 时间（往下掉） | 空间（谱面上的位置） |
| 服务的认知 | 按键提示 | 认谱/读谱定位 |

方块已管时间推进，谱面不再用竖线重复表达进度。谱面用**符头高亮**告诉用户"你弹到的这个音，在五线谱上是这个位置"——这正是帮助用户建立读谱能力的关键。

### 4.3 实现

onTick 时算出当前 beat 落在哪个音（用 `noteIndexAtBeat` 或等价拍位反查），给该符头加高亮 class，清除上一个。需要处理和弦（多个音同时响，都高亮）。

---

## 五、换行算法（密度驱动）

### 5.1 设计约束

**行宽固定（= 容器宽），行内小节数随密度变，小节宽度自适应填满行宽。**

这样滚动时行宽一致、不跳动。每行宽度相同，只是行内小节数不同。

### 5.2 算法：逐小节累加宽度，满了就换行

```
Step 1：估算每个小节的"理想宽度"
  理想宽度 = MIN_BAR_W
           + 该小节音符数 × NOTE_W_FACTOR
           + (有短时值音符[≤十六分] ? SHORT_BONUS : 0)

Step 2：逐小节累加
  currentWidth = 0
  对每个小节 i：
    if currentWidth + 小节i理想宽度 > 行宽上限:
        在 i 前断行 → i 成为下一行首小节
        currentWidth = 0
    currentWidth += 小节i理想宽度

Step 3：断行后，该行的小节按"理想宽度比例"分配实际行宽
  小节j实际宽度 = (小节j理想宽度 / 该行理想宽度总和) × 行宽
  → 音符密的小节占更宽，疏的占更窄，整行加起来 = 行宽
```

### 5.3 调校项

`MIN_BAR_W` / `NOTE_W_FACTOR` / `SHORT_BONUS` 三个常数需在实现时拿真实曲子试值。建议用小星星（疏）+ 一首密音符曲子做对照，调到视觉舒适。先给初始猜测值，再迭代。

### 5.4 为什么不用固定小节数/等分

固定每行 4 小节的问题是：疏的段落（全四分音符）浪费宽度显得空，密的段落（十六分音符）挤成一团。密度驱动让每行视觉密度均匀。

---

## 六、三档谱面布局（为读谱重新设计）

> ⚠️ 不要直接复用编辑器的简谱/双谱布局——那套是为"编辑录入"设计的（有交互容差、当前输入位等），搬到练琴页会丑。ScoreSheet 要为"读谱 + 跟随播放"重新设计。

### 6.1 档1：纯五线谱大谱表（staff）

```
  ⌒{ 𝄞 ♪♪♪♪│♪♪♪♪│   treble（高音谱号 + 五线 + 符头/连梁）
    ┃──────────────
    𝄢 ♪♪♪♪│♪♪♪♪│   bass（低音谱号 + 五线 + 符头/连梁）
  ─────────────────── （行间距）
  ⌒{ 𝄞 ...            （下一行 system）
```

- 每个 system = treble 五线 + bass 五线，左侧连谱号 `{` + 粗竖线连接
- 首行全前缀（谱号+调号+拍号），后续行仅谱号
- 终止线只在曲末

### 6.2 档2：纯简谱双行（jianpu）

```
  { 1 1 5 5│6 6 5 -│   treble 简谱
  ┃ 1   3 │5   1 -│   bass 简谱
  ─────────────────
  { ...              （下一行）
```

- treble 简谱 + bass 简谱上下成对，连谱号连接
- 紧凑，行高小，一屏多行

### 6.3 档3：五线+简谱对照（both）

```
  ⌒{ 𝄞 ♪♪♪♪│        treble 五线
    1 1 5 5│        treble 简谱（五线下方紧贴）
    ┃───────
    𝄢 ♪♪♪♪│        bass 五线
    1 3 5 1│        bass 简谱
```

- 每只手：五线谱 + 下方紧贴的简谱
- 信息最全，行高最大

### 6.4 关键约束：三档行高不同

档3（对照）行高最大，档2（简谱）最小。行滚动锁定位置和渐变范围**必须按当前 mode 的实际行高动态算**，不能写死。mode 切换时重新布局。

---

## 七、接口设计

```ts
export type ScoreMode = 'staff' | 'jianpu' | 'both';

export interface ScoreSheetInitial {
  score: Score;          // 完整乐谱数据（treble + bass）
  mode: ScoreMode;       // 初始谱面档
}

export interface ScoreSheetCallbacks {
  /** 当前行底部位置变化时通知。瀑布流组件据此算方块区上边界。 */
  onLineLayout?: (info: { lineBottomY: number; linePx: number }) => void;
  /** 点击某小节 → 跳转（进度融进谱面的交互）。 */
  onSeek?: (measure: number) => void;
}

export interface ScoreSheetHandle {
  /** 谱面 DOM（滚动容器 + 渐变遮罩）。 */
  el: HTMLElement;
  /** 播放驱动：算当前行→滚动；算当前音→符头高亮。由 controller 在 onTick 里调。 */
  onTick(beat: number): void;
  /** 切换三档（staff/jianpu/both）。切换后重新布局。 */
  setMode(mode: ScoreMode): void;
  /** 乐谱变更时重渲染。 */
  setScore(score: Score): void;
}
```

遵循项目 `buildXxx(initial, callbacks): Handle` 模式。

---

## 八、复用边界汇总

### 8.1 直接 import（零改动）

- `render/glyphs.ts`：`G` 字形表、`ensureFontLoaded`、`advanceSS`、几何工具
- `render/layout.ts`：`computeLayout`（按行调用）、`Layout` 类型
- `render/jianpu.ts`：`renderJianpuSVG`
- `core/model.ts`：`noteStartBeats`、`measureOfBeat`、`barLineBeats`、`snapBeat`/`BEAT_EPS`
- `core/types.ts`：`beatsPerBar`、`durationBeats`

### 8.2 参考自己组装（不直接调）

- `render/staff.ts` 的纯绘制子函数 → ScoreSheet 自己组装等价逻辑，跳过 `renderNextSlot`/`renderHover`
- `render/export.ts` 的 `buildGrandSVG` 双谱表 translate 堆叠模式 → 作为多行内 treble/bass 堆叠的参考

### 8.3 新写

1. **`planSystems(score)`**：密度切行算法（§5）
2. **`renderSystem(system, mode)`**：单行渲染（五线/简谱/对照 + 连谱号），复用 staff.ts 子函数绘制逻辑
3. **`renderBrace()`**：连谱号 `{`。项目无实现，全新写。需在 `glyphs.ts` 的 `G` 表补 `brace` 码点（U+E000，`smufl-codepoints.json` 已有）
4. **前缀分级**：首 system 全前缀、后续仅谱号
5. **终止线受控**：仅曲末 system 画终止线
6. **动态滚动 + 渐变**：onTick 驱动行滚动 + 卡拉OK渐变遮罩
7. **符头高亮**：onTick 算当前音 → 高亮符头

---

## 九、删除清单

### 9.1 整删文件

- `src/render/full-score.ts`
- `src/ui/score-preview-modal.ts`

### 9.2 app.ts 清理（4 处）

| 行号 | 内容 |
|---|---|
| L21 | `import { buildPreviewModal, PreviewModalHandle } from './score-preview-modal';` |
| L113 | `private previewModal: PreviewModalHandle \| null = null;` |
| L508-511 | `openPreview()` 方法体 |
| L541-545 | `this.previewModal = buildPreviewModal({...})` 构造 |

> 注：行号是当前快照，删除前以实际 grep 为准。`onOpenPreview` 入口（editor-bar 回调）保留或改指向练琴页入口（取决于后续入口设计）。

### 9.3 ⚠️ 不要删（另一套系统）

`app.ts` 的 `previewHost` / `previewLayout` / `previewBassLayout` / `previewMode` / `previewRadioEl` / `renderPreview()` / `buildGrandSVG` 调用——这些是 `viewMode=preview` 只读双谱表卡，**与 ScoreSheet 无关**。

### 9.4 废弃文档

`docs/整曲预览重做需求.md` 顶部标记废弃。其有效需求（前缀分级/终止线受控/连谱号/系统间距）已并入本文档。

---

## 十、文件结构

```
src/practice/
  └─ score-sheet.ts    ← ScoreSheet 组件（本设计范围）
```

入口接线、练琴页其他组件（瀑布流/键盘/节拍器/PracticeApp）是**后续 plan 的范围**，不在本组件设计内。

---

## 十一、实施步骤

### Step 1：删除旧代码 + 骨架
- 删 `full-score.ts`、`score-preview-modal.ts`，清理 `app.ts` 4 处引用
- 建 `src/practice/score-sheet.ts`，写空壳 `buildScoreSheet` 接口（§7）
- 验证编辑器仍能跑（`viewMode=preview` 那套没被破坏）

### Step 2：渲染层 — 档1 纯五线大谱表
- 实现 `planSystems`（§5 密度切行）
- 实现 `renderSystem`（单行 treble+bass 五线 + 连谱号，自己组装 staff.ts 子函数）
- 前缀分级 + 终止线受控
- 静态渲染：传入 score 产出多行 SVG

### Step 3：渲染层 — 档2/档3（简谱/对照）
- 档2：treble/bass 简谱双行 + 连谱号（紧凑布局）
- 档3：五线 + 简谱对照（每只手五线+下方简谱）
- 复用 `renderJianpuSVG`

### Step 4：动态层 — 滚动 + 渐变 + 符头高亮
- `onTick(beat)`：算当前行 → 行滚动锁定；算当前音 → 符头高亮（§4）
- 卡拉OK渐变遮罩（当前行清晰、后续半透明）
- `onLineLayout` 回调（通知瀑布流方块区上边界）

### Step 5：交互 + 联调
- 点击小节 → `onSeek` 回调
- `setMode` 三档切换
- 接 PracticeApp 的 onTick（后续 plan）

---

## 十二、关键风险

1. **连谱号字形**：U+E000 需在 `glyphs.ts` 的 `G` 表补，缩放/定位需调试（要跨两谱表高度）
2. **staff.ts 子函数可见性**：若未导出，则复制绘制代码段到 score-sheet.ts（符合"允许新文件重写渲染原语"约定）。先 grep 确认哪些是 export 的
3. **三档行高差异**：行滚动锁定位置 / 渐变范围必须按当前 mode 实际行高动态算，不能写死
4. **换行算法调校**：`MIN_BAR_W` / `NOTE_W_FACTOR` / `SHORT_BONUS` 需真实曲子试值
5. **computeLayout 的单行局限**：它每行等分小节宽度（`barWidth = contentWidth / measures`），密度驱动的"按比例分配行宽"需要 ScoreSheet 在拿到 computeLayout 后**覆盖小节 x 坐标**，或自己算小节宽度后传给渲染

---

## 附：关键文件速查

| 文件 | 作用 |
|---|---|
| `src/ui/playback-card.ts` | 最完整的组件范例（buildXxx 模式、细粒度 Handle） |
| `src/ui/app.ts:147-172` | onTick 分发模式（controller 怎么调组件） |
| `src/render/staff.ts` | 五线谱绘制子函数（参考自己组装） |
| `src/render/layout.ts` | `computeLayout` 单行布局（按行调用） |
| `src/render/glyphs.ts` | 字形表 + 几何工具（直接复用） |
| `src/render/export.ts:47` | `buildGrandSVG` 双谱表堆叠模板（参考） |
| `src/audio/player.ts` | 播放引擎（onTick 时钟源，后续接） |
| `docs/练琴页需求.md` | 完整练琴页产品需求 |
| `practice-prototype.html` | 早期原型（滚动+渐变的 JS 逻辑可参考，但渲染是假的） |
