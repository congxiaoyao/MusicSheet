import { launch } from 'puppeteer-core';

const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1440,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('file:///home/cong/AgentProjects/MusicSheet/practice-prototype.html', { waitUntil: 'networkidle0' });

// 读 .pr-overlay 的实际渐变背景，以及各元素几何
const data = await page.evaluate(() => {
  const overlay = document.getElementById('overlay');
  const cs = getComputedStyle(overlay);
  const ob = overlay.getBoundingClientRect();
  const stage = document.querySelector('.pr-stage').getBoundingClientRect();
  const fall = document.getElementById('fall').getBoundingClientRect();
  const keys = document.getElementById('keys').getBoundingClientRect();
  return {
    overlay: { top: ob.top, height: ob.height, bottom: ob.bottom,
               bg: cs.backgroundImage, bgColor: cs.backgroundColor },
    stage: { top: stage.top, height: stage.height },
    fall: { top: fall.top, height: fall.height, bottom: fall.bottom },
    keys: { top: keys.top, height: keys.height },
    viewport: window.innerHeight,
  };
});

console.log('=== 渐变叠加层 ===');
console.log('overlay top(视口)=' + data.overlay.top + ' height=' + data.overlay.height);
console.log('占视口: ' + (data.overlay.height/data.viewport*100).toFixed(0) + '%');
console.log('渐变 CSS:');
console.log(data.overlay.bg);
console.log('\n=== 各区域视口坐标 ===');
console.log('舞台: ' + data.stage.top + ' ~ ' + (data.stage.top+data.stage.height));
console.log('叠加层: ' + data.overlay.top + ' ~ ' + data.overlay.bottom);
console.log('瀑布流区(fall): ' + data.fall.top + ' ~ ' + data.fall.bottom + ' (高' + data.fall.height + ')');
console.log('键盘(keys): ' + data.keys.top + ' ~ ' + data.keys.bottom);
console.log('\n=== 渐变区间分析 ===');
// overlay 顶部到键盘顶 = 渐变可见区
const gradTop = data.overlay.top;
const keysTop = data.keys.top;
const fallH = data.fall.height;
console.log('渐变可见区(叠加层顶→键盘顶): ' + gradTop + ' ~ ' + keysTop + ' = ' + (keysTop-gradTop) + 'px');
console.log('其中瀑布流块区高: ' + fallH + 'px');

await browser.close();
