# 叠音/和弦(Chord)功能 — 背景知识指导

> 本文档为新 agent 而写。读完后再去探索代码、与用户讨论需求细节。
> **项目根**:`/home/cong/AgentProjects/MusicSheet`(main 分支,已含 partial beam / tie / tuplet 三大功能)。

## 一、需求是什么

「叠音」(本项目中指**和弦 chord**):同一时间点同时发声多个音高(如 C+E+G 同时弹)。
**不是** tuplet(连音组),也**不是** tie(同音高延音线)。三者区别:

| 功能 | 含义 | 数据 | 已实现 |
|---|---|---|---|
| **tie 连音线** | 两个**同音高**音弧线连,时值相加,第二个不重弹 | `Note.tieStart/tieEnd` | ✅ main |
| **tuplet 连音组** | N 个音塞进 M 音的时长(三连音) | `Note.tuplet?:{actual,normal,groupId}` | ✅ main |
| **chord 叠音(本次)** | 同一时间点**多个音高**同时发声 | 待定(见下) | ❌ 待实现 |

> ⚠️ 用户原话用的词是「叠音」。在中文音乐语境里「叠音」有时也指装饰音(appoggiatura/装饰性的快速音),但**本项目用户已确认**指的是和弦(同时按下多音)。新 agent 若有疑问可与用户复核,但默认按「和弦」理解。

## 二、项目架构速览(必读)

### 录入模型:追加式(短信验证码式)
- `src/core/model.ts:1-4` 注释明确:**只能往末尾追加音符,只能从末尾删除,没有任意光标**。下一个待输入位置永远是 `notes.length`。
- 鼠标点击的 **x 坐标不影响落点**,只用 y 决定音高(`src/ui/app.ts` 点击 → `clickYToMidi` → `appendNoteWithPitch`)。
- **和弦的最大挑战**:当前每个音符独立占一个时间位(线性累加时值)。和弦要多个音**共享同一时间位**,这与「一个 Note = 一个时间位」的根本假设冲突。

### 数据模型(types.ts)
```ts
export interface Note {
  midi: number | null;        // 音高;null=休止符
  duration: DurationValue;
  dotted: boolean;
  accidental: Accidental;
  tieStart?: boolean;         // tie(已实现)
  tieEnd?: boolean;
  tuplet?: TupletInfo;        // tuplet(已实现)
  // ❌ 没有 chord 相关字段
}
export interface Piece {
  clef; key; time;
  measureCount: number;
  notes: Note[];              // 扁平数组,按时间顺序
}
```
`Piece.notes` 是**扁平数组**。Note 之间没有任何关系字段(无 groupId/chordId/next)。

### 时值模型(关键!和弦必须改这里)
**全项目唯一的「时值→拍数」真值来源是 `durationBeats(note)`**(`src/core/types.ts`):
```ts
export function durationBeats(note: Note): number {
  let v = noteValueBeats(note.duration, note.dotted);
  if (note.tuplet) v = v * note.tuplet.normal / note.tuplet.actual;
  return v;
}
```
**`noteStartBeats` / `totalBeats` 是线性累加**(`src/core/model.ts`):
```ts
// totalBeats: sum(durationBeats(n))  —— 每个音占一个时间位
// noteStartBeats: acc += durationBeats(n)  —— 拍位线性累加
```
**和弦的核心矛盾**:和弦的多个音同 startBeat,但当前累加会把一个和弦算成多个连续音(时长翻倍)。**未来加和弦时,这两个函数要改成「同 startBeat 的音只算一次时长」**。这是和弦引入时无论如何都要改的,与 tuplet 怎么设计无关(本项目实现 tuplet 时已确认这点,在 `Note.tuplet` 的 `actual` 字段注释里预留了「时间位数」语义:和弦时一个时间位可含多个音,actual 仍按位数算)。

### 渲染层
- **五线谱** `src/render/staff.ts`:`renderStaffSVG` 主流程,顺序为 staffLines→clef→key→time→barlines→nextSlot→hover→**beams**→notes→**ties**→**tuplets**。每个音符用 `renderNote` 画符头/符干/符尾,`x = layout.noteX[i]`,`y = stepToY(step)`。**和弦要多个符头叠在同一 x**——当前 `noteX[i]` 每个音一个 x,和弦需让多个音共享 x(或重叠)。
- **连梁** `src/render/beam.ts`:`computeBeams` 扫描扁平 notes 按 beatGroup 分组。和弦的多个音如何参与连梁是设计点(通常和弦只连最外声部,或整组当一个单位)。
- **简谱** `src/render/jianpu.ts`:简谱和弦用「叠数字」或「纵排数字」表示。
- **播放** `src/audio/player.ts`:`play()` forEach 逐音 `playNote(midi, t, dur)`,`t += dur`。和弦要多个音**同一 t 触发**(t 不各自推进)。
- **布局** `src/render/layout.ts`:`positionInBar` 按时值占比算 x(`slotW = dur/bpb*barWidth`)。和弦共享时间位,布局需把同位多音叠放。

### 输入层
- `src/ui/app.ts`:`appendNoteWithPitch(midi)` 构造 Note → `appendNote`(model.ts)push 到末尾。**点击/键盘都只加单音**。
- `src/ui/toolbar.ts`:`ToolState`(`duration/dotted/accidental/tieNext/tupletMode/clef/key/time/measureCount`)。已有修饰符模式可参考:dotted(附点 chip)、tieNext(t 键)、tupletMode(模式开关)。
- 快捷键已占用:`1-6`(时值)、`.`(附点)、`t`(tie)、`r/f/x`(三/五/六连音)、`0`(休止)、`Backspace`、`Space`。

## 三、实现 tuplet 时已确认的设计原则(适用于 chord)

1. **保持 `Piece.notes` 扁平数组**,不引入嵌套结构。和弦用「多个 Note 共享同一 startBeat」实现(或在 Note 上加可选关系字段)。
2. **actual/normal 语义为「时间位数」**:和弦时一个时间位可含多个音,tuplet 的 actual 仍按位数算。这意味着 chord 与 tuplet **可叠加**(一个三连音位上可以是个和弦)。
3. **tie 与 chord 正交**:tie 是同音高延续,chord 是同时多音,独立。
4. 改动锚点是 `noteStartBeats`/`totalBeats` 的累加逻辑(去重同 startBeat),与 tuplet/tie 无关。

## 四、建议的探索路径(给新 agent)

1. **先读** `src/core/types.ts`(Note/Piece/durationBeats)、`src/core/model.ts`(noteStartBeats/totalBeats/appendNote/popNote)。理解「时间位 = 线性累加」的根本假设。
2. **读** `src/render/layout.ts` 的 `positionInBar`(line ~159)和 `noteX` 计算(line ~114),理解 x 怎么按时值分配——和弦要多个音共享 x。
3. **读** `src/render/staff.ts` 的 `renderNote`(line ~227)和 `renderStaffSVG` 主流程,理解单音怎么画——和弦要多个符头叠放 + 共享符干/反向符干。
4. **读** `src/audio/player.ts` 的 `play()`(line ~41),理解逐音触发——和弦要同 t 多触发。
5. **grep** `noteStartBeats|totalBeats` 看所有消费者(布局/诊断/播放/连梁都依赖拍位)。
6. 关注 `scripts/verify-jianpu.mjs`(简谱回归)和 `src/beam-test/main.ts`(测试用例)这两个验证工具。

## 五、worktree 工作流(本项目惯例)

- 用 git worktree 隔离功能开发:`git worktree add ../MusicSheet-chord -b chord`
- worktree 软链主仓库 node_modules:`ln -s ../MusicSheet/node_modules node_modules`
- **验证命令务必带 `cd worktree` 或 `git -C worktree` 或 `npx tsc -p worktree/tsconfig.json`**——Bash 工具每条命令 working directory 默认在主仓库,不带前缀会跑错地方(本项目踩过多次坑)。
- dev server 避开 5173(可能有别的 agent 在用),用 5180+。
- 截图用 puppeteer-core(主仓库 node_modules 有),从主仓库目录跑 `node 脚本.cjs`,脚本里访问 worktree 的 vite server。

## 六、关键文件清单(绝对路径)

| 文件 | 作用 | 和弦相关点 |
|---|---|---|
| `src/core/types.ts` | Note/Piece/durationBeats | 加 chord 字段 |
| `src/core/model.ts` | noteStartBeats/totalBeats/appendNote | **核心**:同 startBeat 去重 |
| `src/render/layout.ts` | positionInBar/noteX | 和弦共享 x |
| `src/render/staff.ts` | renderNote/renderStaffSVG | 多符头叠放+共享符干 |
| `src/render/beam.ts` | computeBeams | 和弦参与连梁 |
| `src/render/jianpu.ts` | 简谱渲染 | 纵排数字 |
| `src/audio/player.ts` | play() | 同 t 多触发 |
| `src/ui/app.ts` | appendNoteWithPitch/bindKeys | 和弦输入交互 |
| `src/ui/toolbar.ts` | ToolState | 和弦模式 |
| `scripts/verify-jianpu.mjs` | 简谱回归 | 防回归 |
| `src/beam-test/main.ts` | 测试用例 | 加和弦用例 |

## 七、待与用户讨论的设计点(新 agent 用 AskUserQuestion 确认)

1. **数据模型**:Note 加 `chordId?` 字段(同和弦共享)还是用「相邻同 startBeat」隐式分组?
2. **输入交互**:怎么输入和弦?逐个音加入当前时间位,还是「和弦模式」开关?
3. **符干方向**:同和弦多音符干方向(同向共用一根?反向两根?)
4. **MVP 范围**:双音(音程)起步,还是直接多音和弦?
5. **与连梁/tuplet 叠加**:和弦音能否参与连梁/三连音?
