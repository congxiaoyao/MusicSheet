import { launch } from 'puppeteer-core';

const browser = await launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
const ROOT = '/home/cong/AgentProjects/MusicSheet';
const url = 'file://' + ROOT + '/practice-prototype.html';
const OUT = ROOT;
await page.goto(url, { waitUntil: 'networkidle0' });

// 第1帧：第一行演奏中（约第6拍）
await new Promise(r => setTimeout(r, 3000));
await page.screenshot({ path: OUT + '/practice-shot-1.png' });

// 第2帧：换行滚动中（约第18拍，第二行）
await new Promise(r => setTimeout(r, 7000));
await page.screenshot({ path: OUT + '/practice-shot-2.png' });

// 第3帧：第三行（约第36拍）
await new Promise(r => setTimeout(r, 10000));
await page.screenshot({ path: OUT + '/practice-shot-3.png' });

await browser.close();
console.log('done');
