---
name: pixel-verify
description: 像素级视觉自查工作流。用于验证任何屏幕渲染元素(网页/SVG/Canvas)是否符合几何预期——位置、尺寸、对齐、重叠、间距。当用户要检查渲染结果"画得对不对""看起来偏""验证一下对齐/位置/尺寸"时使用。用染色目标+画期望标记+截图+像素分析的闭环,替代肉眼猜测和不可靠的 DOM 反查。项目有 puppeteer/playwright + chrome 即可用。
---

# 像素级视觉自查工作流

验证屏幕渲染元素(网页/SVG/Canvas)是否符合几何预期。**不靠肉眼猜、不靠失真的 DOM API,用染色目标 + 画期望标记 + 像素扫描对比的闭环。**

完整案例见 `references/` 下各项目的实战记录(含踩坑过程)。当前有:
- `musicsheet-example.md` — 五线谱项目(brace 连谱号位置、小节线长度、符头重叠检测)

## 为什么需要这个工作流

肉眼判断不可靠(模型多次自信地说"对齐了"结果被打脸),而常用 DOM API 对渲染元素**返回失真数据**:

- `getBoundingClientRect()` / `getBBox()` 对 SVG `<text>` 返回**字体度量框**(含 line-height/ascent/descent 留白),不是字形墨迹。实际墨迹 28px,API 可能返回 185px。**基于它的"重叠/对齐"判断全是错的**。
- `measureText()` 返回 advance 宽度(字符格子宽),不是墨迹宽度。
- fullPage 截图时 `getBoundingClientRect` 的视口坐标会偏移。
- Canvas 2D 也有类似问题(`measureText` 同款)。

所以:**不要信任从 DOM 反查渲染元素的几何**。要么用纯函数正向算(见"优先方案"),要么用像素染色法实测墨迹。

## ⚠️ 铁律:标记本身必须经用户视觉核对

工作流里画"期望标记"(绿线)来标定元素**应该**到的位置,但**标记本身可能画错**(坐标系搞混、用了被测代码的值循环论证、参考基准选错)。标记错则像素分析全错,而模型会拿着错误的标记自信地报告"✅ 对齐"——这是本工作流**最严重、最高频**的失败模式。

**画完标记截图后,必须先 Read 给用户、请用户核对"绿标记本身画对了吗",用户确认前不得输出任何结论。** 详见步骤 2.5。

## 工作流(5 步)

### 1. 染色目标元素

给要验证的元素加 `class`(如 `my-brace`),在诊断 harness 里染成**纯红** `#ef4444`(R>180, G<100, B<100,像素扫描易识别)。

```js
svg.querySelectorAll('.my-brace').forEach(el => el.setAttribute('fill', '#ef4444'));
// Canvas: 用纯红重画该元素
ctx.fillStyle = '#ef4444';
```

若元素是组合体(如音符=符头+符干+加线),只染要验证的部分,避免误匹配。

### 2. 画期望标记

在元素**应该**到的位置画**纯绿** `#22c55e` 标记(横线/竖线/框/点)。绿色:G>150, R<100, 60<B<160。

**关键陷阱:期望标记必须独立于被测代码计算**,否则是循环论证(用代码算的值画标记,又拿标记验证代码,自然"对齐")。

- ❌ 错:期望标记用被测元素存的 `data-xxx` 属性(那是被测代码的输出)
- ✅ 对:期望标记用**另一个独立数据源**算——参考元素的坐标、规范文档给的绝对值、独立测量结果

### 2.5 ⚠️ 必须让用户视觉核对标记(强制 gate,不可跳过)

**这是整个工作流最易出错、后果最严重的一步。** 标记本身就是错的,会导致后续像素分析全错——而模型会拿着错误标记自信报告"✅ 对齐"。

画完标记、截图后,先 Read 截图给用户,明确说:
- "绿线/绿框是我画的期望位置,请你先核对绿标记本身画对了吗(位置、范围、参考基准)"
- "如果绿标记错了,后面的像素分析结果不可信"

**用户确认标记正确前,不输出任何对齐/偏差结论。**

### 3. 截图

用 puppeteer/playwright 截图:

- **fullPage**:内容超出视口用 `{ fullPage: true }`,但要先撑开滚动容器(`overflow: visible; height: auto`),否则内容被裁。
- **deviceScaleFactor=1** 做分析(像素坐标换算简单);**deviceScaleFactor=2** 给用户看(清晰)。
- fullPage 下 `getBoundingClientRect` 会偏移,像素扫描不依赖它。

```js
await page.evaluate(() => {
  document.querySelector('.scroll-container')?.style.setProperty('overflow', 'visible');
  document.body.style.height = 'auto';
});
await page.screenshot({ path: 'diag.png', fullPage: true });
```

### 4. 像素分析

用 pngjs(或 sharp/jimp)扫描截图,找红色(实际墨迹)和绿色(期望标记)的坐标,对比偏差。

```js
import { PNG } from 'pngjs';
const png = PNG.sync.read(fs.readFileSync('diag.png'));
const RED = (r,g,b) => r > 180 && g < 100 && b < 100;
const GREEN = (r,g,b) => g > 150 && r < 100 && b > 60 && b < 160;

const redYs = [], greenYs = [];
for (let y = 0; y < png.height; y++) {
  let hr = false, hg = false;
  for (let x = 0; x < scanWidth; x++) {       // scanWidth = 标记/目标所在 x 段
    const i = (png.width * y + x) * 4;
    if (RED(png.data[i], png.data[i+1], png.data[i+2])) hr = true;
    if (GREEN(png.data[i], png.data[i+1], png.data[i+2])) hg = true;
  }
  if (hr) redYs.push(y);
  if (hg) greenYs.push(y);
}
```

**聚类**:连续坐标(间隔 ≤4px)合成一段。但超大字形中间有镂空会被拆段——改用**按期望范围归并**:绿标记成对(顶/底/左/右),红像素在该范围内的 min/max 即实际边界。

```js
// 按绿标记期望范围归并红色(避免镂空拆段)
for (let i = 0; i < groups; i++) {
  const expStart = greenSegs[i*2], expEnd = greenSegs[i*2+1];
  // 与相邻组的中点为界(不跨组)
  const lo = i > 0 ? (greenSegs[(i-1)*2+1] + expStart) / 2 : expStart - 30;
  const hi = i < groups-1 ? (expEnd + greenSegs[(i+1)*2]) / 2 : expEnd + 30;
  const inRange = redYs.filter(y => y >= lo && y <= hi);
  const actStart = Math.min(...inRange), actEnd = Math.max(...inRange);
  const diff = actStart - expStart;   // 偏差,容差内(如 ±4px)= 对齐
}
```

### 5. 判定 + 交叉验证

输出每项偏差(px),容差内=✅。**把诊断截图 Read 给用户**(人类视觉交叉验证像素分析对不对)。

```
项0: 绿期望[0..266] 红实际[0..268] 偏差2px ✅
项1: 绿期望[290..557] 红实际[289..559] 偏差2px ✅
```

## 优先方案:纯函数正向算(不截图像素)

若渲染元素的几何可从已知数据正向算出,**优先写纯函数**,不依赖 DOM/像素。例:元素位置 = 已知的锚点坐标 + 偏移公式 + 实测尺寸比例。

**尺寸比例用 canvas 像素采样实测**(一次性标定):
```js
// 画字形/图标到 canvas,扫描非白像素 min/max → 墨迹宽高 → 除以单位得比例
ctx.fillText(glyph, x, baseline);
const img = ctx.getImageData(0,0,w,h).data;
// 扫描得 inkMinX/inkMaxX/inkMinY/inkMaxY → 墨迹宽高
```

纯函数适合:可从布局数据算的位置/间距/重叠。像素染色适合:装饰元素、字形、最终视觉验收。

## 常见陷阱(按严重程度排序)

1. **⚠️ 标记本身画错(最严重)**——坐标系搞混/循环论证/参考选错,标记在错误位置。模型拿错误标记判定"✅对齐"是最常见的自信翻车。**必须让用户视觉核对标记正确后再分析**(步骤 2.5)。
2. **SVG `<text>` 的 getBBox/getBoundingClientRect 返回字体度量框**——不是字形墨迹。永远不要用它判断字形重叠或尺寸。用纯函数算或像素染色测。
3. **期望标记循环论证**——用被测代码的输出画期望,再验证被测代码。期望必须来自独立数据源。
4. **fullPage 下 getBoundingClientRect 偏移**——视口滚动了。像素扫描不依赖它。
5. **超大字形镂空拆段**——聚类阈值会拆碎。改按期望范围归并 min/max。
6. **坐标系混淆**——SVG 内坐标 vs 屏幕像素 vs DOM rect,三者不同。明确当前用哪个,scale 换算一致。
7. **扫描范围错**——元素实际坐标可能不在预设范围。先 dump 实际坐标再定扫描范围。
8. **组合元素误匹配**——`text.note-elem` 含符头+符干+flag,不是纯符头。按属性(如 `text-anchor`)或字形码点过滤,或用纯函数算。

## 给用户看

每轮验证后,把截图 Read 给用户(用户看图,模型看数据,交叉验证)。诚实报告:**读不出图就明说**,不要编造视觉描述。像素数据客观,用户眼睛是最终裁判。

**步骤 2.5 的标记核对是强制 gate。** 不要跳过它直接给结论——"标记对了所以结论可信"和"标记错了所以结论作废"是两回事,只有用户能区分。
