import { launch } from 'puppeteer-core';
const b = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
await p.goto('file:///home/cong/AgentProjects/MusicSheet/practice-prototype.html', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 600));

// 场景1：hover 键盘底部（不应展开）
const keys = await p.$('#keys');
const kbox = await keys.boundingBox();
await p.mouse.move(kbox.x + kbox.width/2, kbox.y + kbox.height - 20);
await new Promise(r => setTimeout(r, 300));
const open1 = await p.evaluate(() => document.getElementById('resizerWrap').classList.contains('open'));
console.log('场景1 hover键盘底部 展开=' + open1 + (open1 ? ' ✗ 误展' : ' ✓ 不展'));

// 场景2：hover 窄带（应展开）
const zone = await p.$('#resizeZone');
const zbox = await zone.boundingBox();
await p.mouse.move(zbox.x + zbox.width/2, zbox.y + zbox.height/2);
await new Promise(r => setTimeout(r, 300));
const open2 = await p.evaluate(() => document.getElementById('resizerWrap').classList.contains('open'));
console.log('场景2 hover窄带 展开=' + open2 + (open2 ? ' ✓ 展开' : ' ✗ 不展'));

// 场景3：鼠标从窄带移到工具条上（应保持展开，不断区）
const track = await p.$('.pr-resizer-track');
if (track) {
  const tbox = await track.boundingBox();
  await p.mouse.move(tbox.x + tbox.width/2, tbox.y + tbox.height/2);
  await new Promise(r => setTimeout(r, 250));  // 在 120ms 隐藏延迟之后
  const open3 = await p.evaluate(() => document.getElementById('resizerWrap').classList.contains('open'));
  console.log('场景3 移到工具条 展开=' + open3 + (open3 ? ' ✓ 不断区' : ' ✗ 断区'));
}

// 截图（场景2/3状态，展开的工具条）
await p.mouse.move(zbox.x + zbox.width/2, zbox.y + zbox.height/2);  // 回到窄带保持展开
await new Promise(r => setTimeout(r, 200));
await p.screenshot({ path: '/home/cong/AgentProjects/MusicSheet/practice-resizer.png', clip: { x: 400, y: 740, width: 640, height: 160 } });
await b.close();
console.log('done');
