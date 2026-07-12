// 截图验证:score-sheet-demo.html 三档(staff/jianpu/both),重点看 both 档数字带。
import { launch } from 'puppeteer-core';

const OUT = '/home/cong/AgentProjects/MusicSheet-both-digits';
const URL = 'http://localhost:5211/score-sheet-demo.html';

const browser = await launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await new Promise(r => setTimeout(r, 800));

const clickBtn = async (label) => {
  await page.evaluate((lbl) => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.trim() === lbl);
    if (b) b.click();
  }, label);
  await new Promise(r => setTimeout(r, 500));
};

// both 档三首曲(小星星/欢乐颂/土耳其)
await clickBtn('对照');
await clickBtn('小星星');
await new Promise(r => setTimeout(r, 600));
await page.screenshot({ path: OUT + '/shot-both-twinkle.png' });
await clickBtn('欢乐颂');
await new Promise(r => setTimeout(r, 600));
await page.screenshot({ path: OUT + '/shot-both-ode.png' });
// 近景:欢乐颂第一行(看清数字对齐符头)
await page.screenshot({ path: OUT + '/shot-both-ode-row1.png', clip: { x: 0, y: 48, width: 1440, height: 540 } });
await clickBtn('土耳其');
await new Promise(r => setTimeout(r, 600));
await page.screenshot({ path: OUT + '/shot-both-turkish.png' });

// 回归:staff / jianpu 纯档(欢乐颂)
await clickBtn('五线谱');
await new Promise(r => setTimeout(r, 600));
await page.screenshot({ path: OUT + '/shot-staff-ode.png' });
await clickBtn('简谱');
await new Promise(r => setTimeout(r, 600));
await page.screenshot({ path: OUT + '/shot-jianpu-ode.png' });

await browser.close();
console.log('done: 6 shots saved');
