import { launch } from 'puppeteer-core';

const browser = await launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const url = 'file:///home/cong/AgentProjects/MusicSheet/practice-prototype.html';
await page.goto(url, { waitUntil: 'networkidle0' });
// 等到第二行演奏（约第18拍 ≈ 11秒 @100bpm）再量
await new Promise(r => setTimeout(r, 11000));

// 量当前演奏行的符头实际屏幕位置
const data = await page.evaluate(() => {
  const stage = document.querySelector('.pr-stage').getBoundingClientRect();
  const overlay = document.getElementById('overlay').getBoundingClientRect();
  const hit = document.getElementById('hit').getBoundingClientRect();
  const score = document.getElementById('score');
  const heads = [...document.querySelectorAll('.sn[data-hand="R"] ellipse')];
  const headRects = heads.map(h => {
    const r = h.getBoundingClientRect();
    return { y: r.top + r.height/2 };
  });
  return {
    stageTop: stage.top, stageH: stage.height,
    overlayTop: overlay.top, overlayH: overlay.height,
    hitTop: hit.top,
    scoreScrollTop: score.scrollTop,
    headRects,
  };
});
console.log(`scrollTop=${data.scoreScrollTop} | 符头总数=${data.headRects.length}`);
console.log(`符头 y 范围：${Math.min(...data.headRects.map(h=>h.y)).toFixed(0)} ~ ${Math.max(...data.headRects.map(h=>h.y)).toFixed(0)}`);
console.log(`第一行(0-3): ${data.headRects.slice(0,4).map(h=>h.y.toFixed(0)).join(', ')}`);
console.log(`第二行(4-7): ${data.headRects.slice(4,8).map(h=>h.y.toFixed(0)).join(', ')}`);
console.log(`第三行(8-11): ${data.headRects.slice(8,12).map(h=>h.y.toFixed(0)).join(', ')}`);
console.log('视口坐标：');
console.log(`  舞台 y=${data.stageTop|0}~${(data.stageTop+data.stageH)|0} (高${data.stageH|0})`);
console.log(`  叠加层 y=${data.overlayTop|0}~${(data.overlayTop+data.overlayH)|0}`);
console.log(`  判定线 y=${data.hitTop|0}`);
console.log(`  0.62 位置 y=${(data.stageTop + data.stageH*0.62)|0}`);
await browser.close();
await browser.close();
