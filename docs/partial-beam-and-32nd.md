# Partial Beam + 三十二分音符 全链路实施文档

> 供新会话直接照做。本文档包含背景、当前架构、源码索引、详细 plan、边界与风险。
> 项目路径:`/home/cong/AgentProjects/MusicSheet`,Vite + 原生 TS,dev: `npm run dev`(端口 5173)。

## 一、目标

1. **Partial Beam(混合连梁)**:连梁支持 eighth/sixteenth 混合。`8 16 16` 的八分音符应与后面两个十六分连成一组(八分用部分梁参与),而不是孤立带 flag。当前算法要求「同 duration 才连」,导致混合时值断开,不符合真实乐谱习惯。
2. **三十二分音符(thirtysecond)**:全链路支持——类型/工具栏/字形/渲染/连梁容量3/简谱下划线3道。

## 二、核心架构:梁容量模型

**每个音符的梁容量**(决定它参与几根梁):
| duration | 梁容量 |
|---|---|
| `eighth` | 1 |
| `sixteenth` | 2 |
| `thirtysecond` | 3 |

**每对相邻音符(i, i+1)间的梁数** = `min(beamCount[i], beamCount[i+1])`

**渲染规则**:主梁(第1根)贯穿整组;第k根梁(k≥2)只在「相邻两音都 ≥k 根容量」的连续段画。

### 举例验证(实施后必须都正确)
| pattern | 主梁(1) | 次梁(2) | 三梁(3) |
|---|---|---|---|
| `8 16 16` | 音1→3贯穿 | 音2→3 | 无 |
| `16 16 8` | 音1→3贯穿 | 音1→2 | 无 |
| `16 8 16` | 音1→3贯穿 | 无(八分夹中断) | 无 |
| `8 16 16 16` | 音1→4贯穿 | 音2→4 | 无 |
| `16 16 16 16` | 音1→4贯穿 | 音1→4贯穿 | 无 |
| `32 32 32 32` | 音1→4贯穿 | 音1→4贯穿 | 音1→4贯穿 |
| `16 32 32 16` | 音1→4贯穿 | 音1→4贯穿 | 音2→3 |
| `8 32 32 8` | 音1→4贯穿 | 音2→3 | 音2→3 |

## 三、源码索引(必读,行号截至本文档撰写时)

### 数据层
- **`src/core/types.ts:10`** — `DurationValue` 类型(当前无 thirtysecond,要加)
- **`src/core/types.ts:54-64`** — `durationBeats(d, dotted)` 映射(当前到 sixteenth:0.25,要加 thirtysecond:0.125)

### 连梁分组(改动核心1)
- **`src/render/beam.ts`** — 完整读。关键:
  - `:17` `BeamLevel = 'single' | 'double'`(level 概念要调整,见 plan)
  - `:37-43` `eighthCount(duration)` — 当前 eighth→1, sixteenth→0.5, default→-1。要加 thirtysecond→0.25
  - `:98` `sameDuration = notes[groupStart].duration === note.duration` — **这是 partial beam 的关键障碍,要去掉**
  - `:105` `if (sameDuration && sameBeatGroup && !crossesBar)` — 去掉 sameDuration 后改成 `if (sameBeatGroup && !crossesBar)`
  - `:92/:112` `groupLevel = ... === 'sixteenth' ? 'double' : 'single'` — level 逻辑要重做(见 plan)

### 渲染层(改动核心2,最大)
- **`src/render/staff.ts`** — 关键函数:
  - `computeStem(step, x, headHalfW, layout, beam)` — 符干几何。stemTop/stemBot 当前对齐到 `beam.stemEndY`。partial beam 下 stemEndY per-note 按梁容量算
  - `BeamCtx` 接口 `{ stemDir, stemEndY }` — 不变,但 stemEndY 值的计算改
  - `renderBeams(groups, piece, layout)` — **核心重构**。当前整组算 beamY1/beamY2 画 1/2 根等长梁。改成逐梁层级画
  - `drawBeam(x1, y1, x2, y2, thick)` — 画倾斜平行四边形,不变,被多次调用
  - `renderNote` 的休止符分支 — 加 rest32nd;孤立 flag 分支加 flag32nd
  - flag 选择处 `note.duration === 'eighth' ? flag8th : flag16th` — 加 thirtysecond → flag32nd
  - 常量区 `BEAM_THICKNESS/BEAM_GAP/STEM_MIN_BEAM/BEAM_OVERHANG/MAX_BEAM_SLOPE` — BEAM_OVERHANG 要动态化(按 maxCount)

### 字形层
- **`src/render/glyphs.ts`** `G` 对象 — 加 `flag32ndUp/flag32ndDown/rest32nd`(SMuFL 标准名)
- **`src/render/glyphs.ts`** `ADV` 表 — 加对应 advance 宽度(flag32nd≈1.16, rest32nd≈1.0,可参考 flag16th 的值)
- SMuFL 字形名(确认存在于 `src/render/smufl-codepoints.json`):`flag32ndUp`, `flag32ndDown`, `rest32nd`

### 工具栏 + 输入
- **`src/ui/toolbar.ts`** `DURATIONS` 数组 — 加 `{ value: 'thirtysecond', label: '𝅘𝅥𝅰', sub: '三十二分' }`
- **`src/ui/app.ts`** 快捷键(搜索 `case '5'` 附近,是 sixteenth) — 加 `case '6': thirtysecond`

### 简谱层(易漏!)
- **`src/render/jianpu.ts`** `underlineCount(duration, dotted)` — 当前 `else n=2`(把所有非 eighth 短时值当2道)。**三十二分要3道**,改成显式判断:`sixteenth→2, thirtysecond→3`
- 调用下游画线逻辑按 ucount 循环,自动支持3道,无需改

### 诊断层(无需改,自动覆盖)
- `src/render/diagnostics.ts` — 用 durationBeats/totalBeats,thirtysecond 加到 durationBeats 后自动覆盖
- `diagnosePitchRange/diagnoseOverfill` 等不依赖 duration 枚举

## 四、详细改动 Plan

### Step 1: 数据层(types.ts)
- `DurationValue` 加 `'thirtysecond'`
- `durationBeats` base 表加 `thirtysecond: 0.125`
- 改动:2 行

### Step 2: 字形层(glyphs.ts)
- `G` 加:`flag32ndUp: glyph('flag32ndUp')`, `flag32ndDown: glyph('flag32ndDown')`, `rest32nd: glyph('rest32nd')`
- `ADV` 加对应宽度(参考 flag16thUp≈1.116,rest16th 的值;若不确定用 1.2 兜底,advanceSS 默认 1.2)
- 改动:~3 行 G + ~3 行 ADV

### Step 3: 连梁分组(beam.ts)— partial beam 关键
- `eighthCount` 加 `case 'thirtysecond': return 0.25`
- **去掉 sameDuration 约束**(line 98 删除,line 105 的条件去掉 sameDuration)
- 新增导出函数:
  ```ts
  export function beamCountForNote(duration: Note['duration']): number {
    if (duration === 'eighth') return 1;
    if (duration === 'sixteenth') return 2;
    if (duration === 'thirtysecond') return 3;
    return 0; // 不参与连梁
  }
  ```
- `BeamGroup.level` 改含义:从 'single'/'double' 改成 `maxBeamCount: number`(组内最大梁容量,1/2/3)。或保留 level 但增加 maxBeamCount 字段。**推荐:level 改成 `maxBeamCount: number`**,渲染层按 per-note beamCount 算每根梁
- `computeBeams` 里 groupLevel 逻辑改成:`groupMaxCount = Math.max(组内各音 beamCountForNote)`,不再按 duration 单一判定

### Step 4: 渲染层(staff.ts)— 最大重构

#### 4a. 孤立 flag(renderNote)
- flag 选择加 thirtysecond: `eighth→flag8th, sixteenth→flag16th, thirtysecond→flag32nd`

#### 4b. renderBeams 逐梁层级(核心)
当前流程:整组算 beamY1/beamY2 → 画1或2根等长梁。
**新流程**:
```
对每个 BeamGroup:
  1. 算组内每个音符的 beamCount = beamCountForNote(duration)
  2. maxCount = max(组内 beamCount)
  3. 主梁(第1根)几何:沿用现有(首尾端点 + MAX_BEAM_SLOPE 封顶 + clamp)
     覆盖整组首到尾 stemX
  4. 对 k = 2..maxCount:
     扫描组内相邻对,找「min(beamCount[i], beamCount[i+1]) >= k」的连续段
     每段画一根第k梁:
       - 该段 y = 主梁 y 在该 x 处的值 + (k-1)*BEAM_GAP*ss(朝外偏移)
         (主梁 y 沿首尾连线线性插值,在段内各 stemX 处算)
       - x 覆盖该段首到尾 stemX
       - 用 drawBeam(x1, y1, x2, y2, thick) 画
```

#### 4c. stemEndY per-note
每个音符的符干延伸到它参与的**最外侧梁**:
- 算法:`stemEndY[i] = 主梁y[i] + (beamCount[i]-1) * BEAM_GAP*ss * (朝外方向)`
  - 朝上:减(梁在上方,y小);朝下:加
  - eighth(容量1):到主梁;thirtysecond(容量3):到第3梁(最远)
- BeamCtx.stemEndY 存这个 per-note 值(当前已是 per-note,改值的计算)

#### 4d. 休止符(renderNote 休止分支)
- 加 `thirtysecond → G.rest32nd`

#### 4e. clamp overhang 动态化
- 当前 `overhang = (BEAM_OVERHANG - (isDouble?BEAM_GAP:0)) * ss`
- 改成 `overhang = (BEAM_OVERHANG - (maxCount-1)*BEAM_GAP) * ss`,保证最外侧(第 maxCount 根)梁也在界内

### Step 5: 工具栏(toolbar.ts + app.ts)
- `DURATIONS` 加 thirtysecond 项
- app.ts 快捷键加 `'6'`

### Step 6: 简谱(jianpu.ts)
- `underlineCount` 改:显式 `sixteenth→2, thirtysecond→3`(当前 `else n=2` 会把三十二分错算成2道)

## 五、边界与风险

1. **次梁/三梁几何**:倾斜时每根梁 y = 主梁 y 在该 x 线性插值 + (k-1)*BEAM_GAP*ss。需保证 BEAM_GAP(0.8ss)足够,梁间不重叠
2. **clamp 边界**:主梁 clamp 后,第k梁 = 主梁 + (k-1)*offset,三梁比主梁远 1.6ss,overhang 要按 maxCount 动态减(Step 4e)
3. **符干长度不一致**:eighth 符干到主梁(短),thirtysecond 到三梁(长),组内符干长度不同——**这是正确的**(真实乐谱就这样),不是 bug
4. **最短符干约束**:当前只查首尾两端。partial beam 下每个音符到它最外侧梁的距离都要 ≥ STEM_MIN_BEAM。实施时改成 per-note 检查,不足则整体平移(但整体平移可能影响其他音——折中:只保证主梁的几何,各音符干长度自然由 beamCount 决定,接受 eighth 符干较短)
5. **`16 8 16`**:八分夹中间,次梁全断,只有主梁贯穿——符合记谱法
6. **回归**:纯 eighth 组(主梁1根)、纯 sixteenth 组(主梁+次梁都贯穿)的渲染必须与改动前一致。这是验证重构没破坏现有的关键

## 六、测试

### 自动验证
- 单测脚本:对各种 pattern 调 computeBeams + 检查梁段数
- `npx tsx scripts/verify-jianpu.mjs` 回归(简谱)
- `npx tsc --noEmit` 类型检查

### 测试页(src/beam-test/main.ts)
- **现有 24 用例回归**:纯 eighth/sixteenth 组渲染不变
- **新增 partial beam 用例**:
  - `8 16 16`(主梁贯穿+次梁仅16-16)
  - `16 16 8`(反向)
  - `16 8 16`(次梁全断)
  - `8 16 16 16`
- **新增三十二分用例**:
  - `32 32 32 32`(三梁贯穿)
  - `16 32 32 16`(三梁仅中段)
  - 孤立 32(flag32nd)
- **重点验证用例 24 小节3**(`8 16 16 ×4`):改动后八分应与十六分连成一组

### 截图验证
- `node shot-test.cjs`(测试页)+ `node shot-twinkle.cjs`(小星星回归)
- 用 puppeteer 截图读图核对每种梁组合

### diagnoseAll
- 所有新用例必须 0 issue(数据自洽)

## 七、实施顺序(建议)

1. types.ts: DurationValue + durationBeats 加 thirtysecond
2. glyphs.ts: flag32nd/rest32nd
3. beam.ts: 去 sameDuration + beamCountForNote + BeamGroup.maxBeamCount
4. staff.ts renderBeams: 逐梁层级重构(主梁/次梁/三梁)—— **核心,最易出错**
5. staff.ts stemEndY: per-note 按容量
6. staff.ts: 孤立flag + 休止符 rest32nd
7. staff.ts clamp: overhang 动态化
8. toolbar.ts + app.ts: 工具栏 + 快捷键
9. jianpu.ts: underlineCount 显式 thirtysecond→3
10. 测试用例(partial beam + 三十二分)
11. 截图 + 回归(24用例不变 + 小星星 + 0 issue)

## 八、背景:当前连梁架构(理解现状)

- `computeBeams(piece)` → `BeamGroup[]`,每个 group `{startIdx, endIdx, level}`
- `renderStaffSVG` 调 `renderBeams` 得到 `{svg, ctxByIdx}`,ctxByIdx 是 `Map<noteIdx, BeamCtx>`
- `BeamCtx = {stemDir, stemEndY}`,每个音符的符干对齐到 stemEndY
- `renderBeams`:对每个 group 算统一 stemDir(平均step)、beamY1/beamY2(倾斜)、画1或2根梁
- `drawBeam(x1,y1,x2,y2,thick)`:画倾斜平行四边形
- `computeStem`:符干几何,无 beam 时按自身音高,有 beam 时对齐 stemEndY

## 九、不改动(确认)
- diagnostics.ts(自动覆盖 thirtysecond)
- layout.ts
- model.ts(appendNote 等用 durationBeats,自动覆盖)
- 异常机制(onIssues/callbacks)

## 十、关键命令
- dev: `npm run dev`(端口 5173,host:true 支持 IP)
- 类型检查: `npx tsc --noEmit`
- 测试页: http://localhost:5173/beam-test.html
- 截图: `node shot-test.cjs`(测试页) / `node shot-twinkle.cjs`(小星星)
- 截图存放: `screenshots/`(gitignore)
