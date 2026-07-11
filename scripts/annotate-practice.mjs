import { launch } from 'puppeteer-core';
import { PNG } from 'pngjs';
import fs from 'fs';

const browser = await launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const ROOT = '/home/cong/AgentProjects/MusicSheet';
const url = 'file://' + ROOT + '/practice-prototype.html';
await page.goto(url, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 2500));

// 读取 DOM 里判定线、瀑布流区、键盘的几何信息
const geom = await page.evaluate(() => {
  const hit = document.getElementById('hit');
  const fall = document.getElementById('fall');
  const keys = document.getElementById('keys');
  const stage = document.querySelector('.pr-stage');
  const overlay = document.getElementById('overlay');
  const r = el => { const b = el.getBoundingClientRect(); return {top:b.top, bottom:b.bottom, left:b.left, right:b.right, h:b.height, w:b.width}; };
  // 找第一个可见块
  const blocks = [...document.querySelectorAll('.note')];
  let visBlock = null;
  for (const b of blocks){
    const op = parseFloat(b.style.opacity||'0');
    if (op > 0.05){ visBlock = r(b); visBlock.midi = b.textContent; break; }
  }
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    stage: r(stage),
    overlay: r(overlay),
    fall: r(fall),
    hit: r(hit),
    keys: r(keys),
    firstVisibleBlock: visBlock,
  };
});

console.log('=== 几何（视口坐标 px）===');
console.log(JSON.stringify(geom, null, 2));

// 截图并标注关键位置
await page.screenshot({ path: ROOT + '/practice-annotated.png' });

// 用 pngjs 在图上画标注线
const buf = fs.readFileSync(ROOT + '/practice-annotated.png');
const png = PNG.sync.read(buf);
const W = png.width, H = png.height;
function hline(y, [R,G,B]){
  for (let x=0;x<W;x++){
    const i = (png.width*y + x) << 2;
    png.data[i]=R; png.data[i+1]=G; png.data[i+2]=B; png.data[i+3]=255;
  }
}
// 标注：红=判定线，绿=瀑布流区顶(块掉落起点)，蓝=渐变开始/叠加层顶，橙=键盘顶
if (geom.hit) hline(Math.round(geom.hit.top), [239,68,68]);      // 红 判定线
if (geom.fall) hline(Math.round(geom.fall.top), [34,197,94]);    // 绿 瀑布流顶=块理论上限
if (geom.overlay) hline(Math.round(geom.overlay.top), [59,130,246]); // 蓝 叠加层顶=渐变开始
if (geom.keys) hline(Math.round(geom.keys.top), [249,115,22]);   // 橙 键盘顶
const out = PNG.sync.write(png);
fs.writeFileSync(ROOT + '/practice-annotated.png', out);

console.log('\n=== 标注说明 ===');
console.log('红线 = 判定线（块落点）');
console.log('绿线 = 瀑布流区顶部 = 块掉落的可见上限');
console.log('蓝线 = 底部叠加层顶部 = 渐变开始处');
console.log('橙线 = 键盘顶部');
console.log('\n=== 关键事实 ===');
if (geom.fall){
  console.log(`块掉落可见区域：从 y=${Math.round(geom.fall.top)} 到 判定线 y=${Math.round(geom.hit.top)}`);
  console.log(`块掉落可见高度：${Math.round(geom.hit.top - geom.fall.top)}px`);
}
if (geom.overlay){
  console.log(`渐变叠加层：y=${Math.round(geom.overlay.top)} ~ ${Math.round(geom.overlay.bottom)}，占视口 ${(geom.overlay.h/geom.viewport.h*100).toFixed(0)}%`);
}
if (geom.firstVisibleBlock){
  console.log(`第一个可见块：y=${geom.firstVisibleBlock.top}~${geom.firstVisibleBlock.bottom}，音=${geom.firstVisibleBlock.midi}`);
}

await browser.close();
