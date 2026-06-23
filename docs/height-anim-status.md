# 编辑区高度动画方案 — 现状与难题(专家会诊用)

## 最终目标
输入/删除极端高音或低音时,编辑区高度平滑过渡(120ms),核心保证:
1. **五线谱物理位置恒定**(用户视觉上五线谱不动)
2. **不溢出卡片**(不压到上方 toolbar)
3. **动画平滑**(无瞬间跳变、连续操作不闪)

## 当前方案(commit 0ea1942)
SVG absolute bottom:0 居底 + JS rAF 动画 + scrollY 闭环补偿。

### 机制
- SVG `position:absolute; bottom:0` 居底在 svgHost 内
- svgHost `overflow:hidden` 裁掉 SVG 居底后顶部溢出
- render 时:
  1. innerHTML 前读 `prevStaffYScreen`(旧 SVG 的 staffY 屏幕,= 用户当前位置)
  2. innerHTML 替换新 SVG(viewBox/height 瞬间到最终值)
  3. svgHost height 保持旧值(startH),新 SVG 居底溢出被裁
  4. `staffAnchorScreen = prevStaffYScreen`(每次重新锁定)
  5. 同步帧:`scrollY += (measureStaffYScreen() - staffAnchorScreen)` 补偿 viewBox 变化导致的偏移
  6. JS rAF 动画 120ms:svgHost height 从 startH→endH 逐帧插值,每帧闭环读 staffY 屏幕,scrollY 补偿到 target

### 几何原理(居底)
SVG 居底时五线谱 bottomLineY 物理位置 = svgHost底 - SVG高 + 121 + viewBoxYOffset。
当 svgHost height 变化时,svgHost 底移动,SVG 跟随(bottom:0),五线谱物理位置随 height 变化。
scrollY 补偿这个变化量,让五线谱屏幕位置恒定。

## 遇到的问题(核心难题)

### 关键澄清:跳动来自 scrollY 代码,不是 SVG/卡片本身
SVG 是 `position:absolute`(不参与文档流)。只要 svgHost height 不变,SVG 高度变化(被裁剪)
页面布局**完全不动**——零跳动。跳动 100% 来自手动写的 `window.scrollTo()` 补偿代码。

因此存在两条路线:
- **A. 自然扩展(无 scrollY)**:svgHost height 动画 + SVG 居底。页面不跳、不溢出、平滑。
  但五线谱随 height 变化**平滑移动**(居底,height 增时五线谱下移)。非"绝对不动"。
- **B. scrollY 补偿(绝对不动)**:在 A 基础上加 scrollY 让五线谱屏幕恒定。
  但 scrollY 必然引入跳动(瞬间跳或 30px 偏移),无法两全。

用户要求"五线谱绝对不动"→ 选 B → 跳动问题。
若接受"五线谱平滑移动"→ 选 A → 无跳动,方案简单可靠。

### 问题 1:innerHTML 替换瞬间跳变(路线 B 的难题,未完全解决)
innerHTML 瞬间替换新 SVG(新 viewBox),新 SVG 在旧 startH 居底的 staffY ≠ 旧 SVG 的 staffY。
差值 = startAdjust(viewBox 变化导致)。

- **同步全补**(scrollY += startAdjust):staffY 屏幕 = target(dev=0),但 scrollY 瞬间跳 → 用户看到「页面立即滚到最终位置」
- **逐步补**(heightTick 里 startAdjust * eased):scrollY 平滑,但 #0 帧 dev=30(startAdjust),7帧内收敛 → 用户仍感觉偏移
- **不补**:dev=30 恒定,五线谱偏了

**本质矛盾**:innerHTML 替换瞬间新旧 SVG 的 staffY 不同(因 viewBox 变了),这个差无法在「不瞬间跳 scrollY」的前提下消除。

### 问题 2:scrollY 补偿影响用户滚动位置
heightTick 闭环每帧设 scrollY,改变了用户的滚动位置。用户手动滚到某处后,输入高音会触发 scrollY 补偿(向下滚),改变了用户的滚动位置。

### 问题 3:连续操作时序
连续输入/删除时,前一个动画未完成就触发新 render。staffAnchorScreen 在 innerHTML 前锁定,但如果动画中 height 还在变化,锁定的值可能不准。

## 已验证可行的部分
- SVG absolute bottom:0 居底:高音时五线谱物理恒定(居底+映射抵消)✅
- 低音(viewBox 0 起):顶部锚定天然不动 ✅(但和居底切换有跳变)
- 闭环 scrollY 补偿:每帧读 staffY 屏幕 → target,精确消除偏差 ✅
- hover(height 不变)不触发动画/scrollY ✅

## 尝试过的方案(都已回退)
1. transform 抵消映射:svgHost 上移溢出压 toolbar
2. padding-top 撑开卡片 + transform:padding 和映射各贡献一个 offset,transform 无法同时抵消
3. margin-top:影响布局流挤压下方
4. 开环 scrollY 公式:有映射偏差(hostTopDoc/svgH/off 读取时机)
5. 闭环 scrollY + 同步全补:瞬间跳变
6. 闭环 scrollY + 逐步补:#0 帧 dev=30

## 数学上的核心矛盾(已证明)
在单个 SVG + viewBox 机制下:
- 高音加线必须画在五线谱**上方**的物理空间
- 这个空间要么让五线谱下移让位(动),要么溢出容器(压 toolbar)
- viewBox 负 y 的映射 offset 无法被 transform/padding/margin 消除(暴力验证确认)
- 居底(bottom:0)能让五线谱物理恒定,但 height 变化时需要 scrollY 补偿,补偿量瞬间施加=跳变

## 可能的出路(待专家评估)
1. **双 SVG 层**:主层(五线谱+简谱,固定) + 扩展层(高音加线,独立向上扩展)。彻底避免 viewBox 映射问题。改动大。
2. **CSS Scroll-Driven Animations**:用浏览器的滚动锚定 API(scroll-into-view / CSS scroll-anchor)自动补偿,不手动设 scrollY。
3. **SVG 内部分层渲染**:viewBox 固定,五线谱和加线分别画在不同 y 范围,五线谱位置固定。
4. **接受折中**:五线谱随高度变化平滑移动(非绝对不动),不溢出卡片。放弃「绝对不动」。

## 关键代码位置
- `src/ui/app.ts`:render(810-880行) — SVG 居底 + height 动画 + scrollY 补偿
- `src/ui/app.ts`:heightTick(890-905行) — rAF 单帧插值 + 闭环 scrollY
- `src/ui/app.ts`:measureStaffYScreen(840行) — 读 staffY 屏幕位置
- `src/style.css`:.svg-host overflow hidden + svg absolute bottom:0(253-260行)
- `src/render/layout.ts`:computeLayout viewBoxYOffset 动态高度(155-190行)
- `src/render/export.ts`:buildSVG viewBox 动态起点(30-35行)

## 验证脚本
- `scripts/verify-dynamic-height.mjs`:数据层 32 项全过(扩展/删除回缩/和弦/hover/边界)
- puppeteer DOM 验证:staffY 屏幕 + scrollY + hostH 帧采样

## 当前分支
- main(已 hard reset 到 0ea1942)
- feat/height-anim-v2(实验分支,保留中间尝试)
