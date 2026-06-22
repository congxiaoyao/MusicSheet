# 重构方案:播放头 + 符头高亮同步(独立 DOM 层)

> 状态:方案已定,自主实施。存档供后续参考。
> 关联问题:播放头落后一个音符 / 暂停才刷新 / 暂停态 seek 不同步。

## 问题根因
1. **播放头滞后**:播放头(`injectPlayhead`)画在 SVG 字符串里,只在 `App.render()` 全量重建时刷新。而 `onTick`(每帧 rAF)只调 `_setProgress`(卡片进度条),不触发编辑区重绘 → 播放期间播放头卡死不动。
2. **「落后一个音符」**:`onNote` 在「进入新音区间」时触发 `render()`,而播放头用 `currentBeat` 找 idx。两者数据源/时机不同 → 高亮和播放头错位。
3. **暂停才刷新**:`onStateChange('paused')` 触发 render → 播放头终于画对。
4. **性能浪费**:`onNote` 每进一个新音就全量重建整个 SVG,和 mousemove hover 抢渲染。
5. **暂停态 seek 不同步**:seek 在停止/暂停态只更 `_setProgress`,编辑区播放头/高亮不更新。

## 方案:独立 DOM 覆盖层 + 符头 CSS 高亮

### 架构
```
stageWrap (position: relative)
├─ svgHost (现有,渲染五线谱+简谱,SVG 内不再画播放头)
│   └─ svg: 每个符头 <text> 加 class="note-head" + data-idx="i",
│            fill 改为 currentColor(颜色由 CSS class 控制)
├─ playheadLayer (新增,position:absolute, 覆盖 svgHost, pointer-events:none)
│   └─ <div class="pb-playhead"> (width/left/top/height 由 JS 定位)
```

### 改动点
- **style.css**:符头 `.note-head { color:#1f2430 }` + `.note-head.playing { color:#4f46e5 }`;播放头从 SVG `<rect>` 改 DOM `<div>`,百分比定位自适应缩放。
- **staff.ts**:`renderNote` 符头加 `class="note-head"`+`data-idx`+`fill="currentColor"`;**移除 highlight 参数对颜色的影响**(改由运行时 class);符干/符尾/附点/和弦符干同理。简谱侧 `renderJianpuSVG` 数字加 class+data-idx。
- **app.ts**:新增 `playheadLayer`;**`onTick` 重写为单一数据源**——`currentBeat=beat` → 算 idx → `updatePlayhead(idx)`(定位 div)+ `updateHighlight(idx)`(切换 .playing class,含和弦组);**移除 onNote 驱动高亮**;`onStateChange` 控制 playheadLayer 显隐;`render()` 不再 injectPlayhead;`seek` 各状态都调 updatePlayhead+updateHighlight。
- **player.ts**:暴露 `noteIndexAtBeat` 为 public。

### 和弦高亮
`updateHighlight(idx)` 查 `piece.notes[idx].chordId`,若有则给所有同 chordId 声部加 `.playing`。

### seek 同步
暂停态 seek → updatePlayhead+updateHighlight 用新 beat 重算。
停止态 seek → 记录 currentBeat,不显示播放头(停止=无播放头语义)。

### 验证(不靠视觉)
- puppeteer 抓 playheadLayer div 的 left,断言 onTick 前后变化
- 抓 `[data-idx].playing` 的 data-idx 等于预期当前音
- seek 暂停态后断言播放头 left 对应 beat 位置
- beam-test 全量回归(tint/0 issue)

### 决策(自主定)
- 简谱高亮一起 CSS 化(保持一致性)
- 停止态 seek 不显示播放头预览(保持原语义)
