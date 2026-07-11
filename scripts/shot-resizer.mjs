import { launch } from 'puppeteer-core';
const b = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
await p.goto('file:///home/cong/AgentProjects/MusicSheet/practice-prototype.html', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 600));

// 场景1：hover 键盘底部（卡片不应显示）
const keys = await p.$('#keys');
const kbox = await keys.boundingBox();
await p.mouse.move(kbox.x + kbox.width/2, kbox.y + kbox.height - 20);
await new Promise(r => setTimeout(r, 300));
const open1 = await p.evaluate(() => document.getElementById('resizerCard').classList.contains('open'));
console.log('场景1 hover键盘底部 open=' + open1 + (open1 ? ' ✗' : ' ✓ 不显'));

// 场景2：hover 窄带（卡片显示）
const zone = await p.$('#resizeZone');
const zbox = await zone.boundingBox();
await p.mouse.move(zbox.x + zbox.width/2, zbox.y + zbox.height/2);
await new Promise(r => setTimeout(r, 300));
const open2 = await p.evaluate(() => document.getElementById('resizerCard').classList.contains('open'));
console.log('场景2 hover窄带 open=' + open2 + (open2 ? ' ✓ 显' : ' ✗ 不显'));

// 场景3：从窄带移到卡片上（不断区）
const card = await p.$('#resizerCard');
const cbox = await card.boundingBox();
await p.mouse.move(cbox.x + cbox.width/2, cbox.y + cbox.height/2);
await new Promise(r => setTimeout(r, 250));  // 超过 150ms 隐藏延迟
const open3 = await p.evaluate(() => document.getElementById('resizerCard').classList.contains('open'));
console.log('场景3 移到卡片 open=' + open3 + (open3 ? ' ✓ 不断区' : ' ✗ 断区'));

// 场景4：移开（离开整个区域后隐藏）
await p.mouse.move(100, 100);
await new Promise(r => setTimeout(r, 300));
const open4 = await p.evaluate(() => document.getElementById('resizerCard').classList.contains('open'));
console.log('场景4 移开 open=' + open4 + (open4 ? ' ✗ 不隐' : ' ✓ 隐藏'));

// 截图（hover 窄带状态）
await p.mouse.move(zbox.x + zbox.width/2, zbox.y + zbox.height/2);
await new Promise(r => setTimeout(r, 300));
await p.screenshot({ path: '/home/cong/AgentProjects/MusicSheet/practice-resizer.png', clip: { x: 480, y: 660, width: 480, height: 240 } });
await b.close();
console.log('done');
