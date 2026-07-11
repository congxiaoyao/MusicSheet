import { launch } from 'puppeteer-core';
const b = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
await p.goto('file:///home/cong/AgentProjects/MusicSheet/practice-prototype.html', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 500));

// 场景1：hover 键盘中下部（不应该出卡片）
const keys = await p.$('#keys');
const kbox = await keys.boundingBox();
await p.mouse.move(kbox.x + kbox.width/2, kbox.y + kbox.height - 20);  // 键盘底部
await new Promise(r => setTimeout(r, 300));
const op1 = await p.evaluate(() => parseFloat(getComputedStyle(document.getElementById('resizerWrap')).opacity));
console.log('场景1 hover键盘底部 卡片opacity=' + op1 + (op1 === 0 ? ' ✓ 不显' : ' ✗ 误显'));

// 场景2：hover 键盘顶部上方隐形区（应该出卡片）
await p.mouse.move(kbox.x + kbox.width/2, kbox.y - 30);  // 键盘上方 30px
await new Promise(r => setTimeout(r, 300));
const op2 = await p.evaluate(() => parseFloat(getComputedStyle(document.getElementById('resizerWrap')).opacity));
console.log('场景2 hover顶部上方 卡片opacity=' + op2 + (op2 === 1 ? ' ✓ 显' : ' ✗ 不显'));

// 场景3：鼠标移到卡片上（应该不断区，仍显）
const card = await p.$('.pr-resizer-card');
const cbox = await card.boundingBox();
await p.mouse.move(cbox.x + cbox.width/2, cbox.y + cbox.height/2);  // 卡片中心
await new Promise(r => setTimeout(r, 300));
const op3 = await p.evaluate(() => parseFloat(getComputedStyle(document.getElementById('resizerWrap')).opacity));
console.log('场景3 hover卡片 卡片opacity=' + op3 + (op3 === 1 ? ' ✓ 不断区' : ' ✗ 断区'));

// 截图（场景3状态）
await p.screenshot({ path: '/home/cong/AgentProjects/MusicSheet/practice-resizer.png', clip: { x: 480, y: 680, width: 480, height: 220 } });
await b.close();
console.log('done');
