# MusicSheet 项目实战案例

五线谱编辑/练琴工具(原生 TS + SVG + Web Audio)。本文件记录用 pixel-verify 工作流验证渲染元素的真实过程,含踩坑细节。

## 背景:项目渲染栈

- 五线谱用 SVG `<text>` 渲染 Bravura(SMuFL)音乐符号字体
- `staff space`(ss)= 五线谱相邻两线距离 = fontSize/4,是所有几何的单位
- 渲染层 `render/staff.ts` 用 `stepToY(step) = bottomLineY - step*ss/2` 算符头 y
- 符头墨迹比例实测(canvas 采样):半宽 0.58ss、半高 0.49ss

## 案例一:连谱号 brace 位置验证

**问题**:brace `{` 字形(U+E000)的缩放/定位是估算的,需验证它是否贴合 treble 五线第一线到 bass 五线第五线。

### 踩的坑

1. **字号瞎估**:最初 `fs = targetH * 0.42`,字形太小撑不满跨度。后用 canvas 实测:Bravura brace 墨迹高 ≈ font-size(不是 0.42×),修正为 `fs = targetH * 1.02`。
2. **baseline 算错**:实测墨迹中心在 baseline 上方 fs/2 处(不是 dominant-baseline=central 的假设),改为 `baselineY = cy + fs/2`。
3. **绿标记循环论证**:最初用 `data-top/data-bot` 属性画绿标记——那是被测代码存的值,自然"对齐"。用户指出后改用五线谱横线 y(独立数据源)画标记。

### 最终验证方法

```
染色:svg 'text.ss-brace' 染红 #ef4444
期望标记:treble 五线第一线 / bass 五线第五线 y 画绿线(从 staff-group line 的 y1 + transform 算,独立于 brace 代码)
截图:fullPage + 撑开 .score-sheet-scroll
像素分析:scan x<200,红=brace墨迹,绿=期望y,按 system 归并对比
```

结果(三档 staff/jianpu/both):
```
staff:  system1/2/3 顶差-2 底差2 ✅(system0 顶部测量误差)
jianpu: 全 ✅ 顶差2 底差-2
both:   system1/2 ✅
```

### 关键教训

- **字形几何必须 canvas 实测**,不能靠"墨迹高约 4-5em"这种猜测
- **期望标记必须独立**:用五线谱横线坐标,不用 brace 代码的输出值
- **首行(system0)的测量误差**:绿线画在 SVG y=0 正好在图像边缘,扫描精度下降。非真实偏差。

## 案例二:小节线长度对齐

**问题**:用户说"小节线长度没对齐五线谱"。

### 诊断过程

1. DOM 坐标对比(不截图,直接读 y1/y2 + transform):
   ```
   system0: 小节线[顶74.3 底277.2] 五线[treble顶75 bass底263.6] 底差13.6 ❌
   ```
   **根因**:`bassStaffBotY` 用了旧的 `bassTranslate = tVisH - bTop`,但 bass group 实际 transform 是新的 `bassTranslateY`(含 treble-bass 间距调整)。两者脱节 → 小节线底端比 bass 五线低 13.6px。

2. 修复:`bassStaffBotY` 改用 `bassTranslateY`。

3. 验证(三首×每行):
   ```
   小星星 sys0/1: 顶差-0.7 底差0.7 ✅
   欢乐颂 sys0/1: 顶差-0.7 底差0.7 ✅
   土耳其 sys0/1/2: 顶差-0.7 底差0.7 ✅
   ```
   (±0.7 是 lineExtend 半线宽,视觉对齐)

### 关键教训

- **变量改名后要全局同步**:引入新变量(`bassTranslateY`)时,所有用旧变量(`bassTranslate`)的地方都要更新,否则脱节
- **DOM 坐标直接对比比像素扫描更轻量**:当元素坐标是数值属性(y1/y2)时,直接读+换算比染色截图像素快

## 案例三:符头重叠检测 + noteHeadRects 基础设施

**问题**:treble-bass 间距固定(6ss),担心高音谱低音和低音谱高音会重叠。

### 诊断过程的坑(测量假象)

1. **getBoundingClientRect 返回 132px 高**:`text.note-elem` 的 rect.height=132,一个符头不可能这么高。是 SVG `<text>` 的字体度量框。
2. **getBBox 返回 185px 高**:同样问题,Bravura 字体 em 框含大量留白。
3. **误判"重叠 -43px"**:基于失真的 bbox 判断重叠,实际符头根本不重叠。

### 解决:noteHeadRects 纯函数

不再从 DOM 反查,用纯函数正向算:
```ts
export function noteHeadRects(piece, layout): (NoteHeadRect | null)[] {
  const halfW = 0.58 * layout.staffSpace;   // 实测
  const halfH = 0.49 * layout.staffSpace;
  return piece.notes.map((note, i) => {
    if (note.midi === null) return null;     // 休止符
    const cx = layout.noteX[i];              // 布局算好的中心 x
    const step = resolvePitch(note.midi, piece.clef, piece.key, note.accidental).step;
    const cy = layout.bottomLineY - step * layout.staffSpace / 2;  // stepToY
    return { cx, cy, halfW, halfH, top: cy-halfH, bottom: cy+halfH };
  });
}
```

墨迹比例(0.58ss/0.49ss)用 canvas 像素采样实测(font-size=200, ss=50):
```
noteheadBlack: 墨迹宽 58px(1.16ss), 高 49px(0.98ss)
→ 半宽 0.58ss, 半高 0.49ss
```

### 验证数据(纯函数算,准确)

```
欢乐颂: treble下伸1.5ss bass上伸0    默认6ss下gap=4.52ss ✅
土耳其: treble无下伸    bass无上伸    默认6ss下gap=7.52ss ✅
交叉:   treble下伸6.5ss bass上伸7.5ss 默认6ss下gap=-8ss  ❌→触发动态增大
```

动态防重叠:用 noteHeadRects 算重叠量,默认6ss下若重叠则增大 bassTranslateY。验证:欢乐颂 bassTranslateY=142.6(不变),交叉=218.27(+75.7px 补偿)。

### 关键教训(本案例最重要)

- **DOM API 对 SVG `<text>` 不可靠**:getBBox/getBoundingClientRect 返回字体度量框,不是墨迹。所有基于它的判断都是错的。
- **纯函数正向算最可靠**:符头位置 = noteX + stepToY + 实测墨迹比例,数据全部来自布局层已知值,不依赖 DOM。
- **尺寸比例用 canvas 一次性标定**:画字形到 canvas 扫描像素得墨迹宽高,转成 staff space 比例,写进纯函数。

## 案例四:密度预设调校(用 planSystems 日志)

**问题**:调换行算法常数,需快速看每行小节数。

### 方法

在 `planSystems` 加 `console.debug` 输出每行的小节范围 + 理想宽度占比:
```
[planSystems] "土耳其进行曲" 紧密 行宽940 → 4行: [0-2×3 810px/86%] [3-5×3 786px/84%] [6-7×2 418px/44%]
```

这是**非像素**的验证(纯逻辑数据),但属于同一思路:不靠肉眼看截图数小节,用日志数据客观判断排行是否合理。

### 关键教训

- **能从数据直接判断的,别截图**:小节数、行数、宽度占比这些纯逻辑值,日志比像素扫描快且准
- 像素验证留给"几何精度"类问题(位置/尺寸/对齐),逻辑验证用日志/断言

## 通用要点(从这些案例提炼)

1. **先判断该用哪种验证**:纯逻辑值(数量/比例)用日志;几何值(位置/尺寸)用纯函数或像素染色
2. **DOM 反查是下下策**:对 SVG/Canvas 渲染元素,优先纯函数正向算
3. **canvas 实测字形比例**:一次性标定,写进纯函数,避免每次渲染后反查
4. **染色法的期望标记必须独立**:用参考元素坐标,不用被测代码输出
5. **标记必须用户核对**:模型无法发现自己画的标记是错的
