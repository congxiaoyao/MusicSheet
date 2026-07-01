// 验证 library-demo.html 渲染:卡片网格 + 真实五线谱缩略图 + 交互。
import { launch } from 'puppeteer-core';
const URL = process.argv[2] || 'http://localhost:5176/library-demo.html';
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1300,950'] });
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 950 });
const errors = [];
page.on('console', m => { if (m.type()==='error' && !/favicon|net::ERR|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: '+e.message));

await page.goto(URL, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 2000));  // 等字体+渲染

check('标题渲染', await page.evaluate(() => /曲谱库/.test(document.querySelector('.lib-title h1')?.textContent || '')));
const cardCount = await page.evaluate(() => document.querySelectorAll('.score-card:not(.new-card)').length);
check('渲染了 6 张曲谱卡片', cardCount === 6, `${cardCount} 张`);
const newCard = await page.evaluate(() => !!document.querySelector('.score-card.new-card'));
check('末尾有新建占位卡', newCard);

// 缩略图:前 5 张(有内容的)应有 SVG,空草稿(s5,treble 3 音)也应有
const thumbSvgs = await page.evaluate(() => document.querySelectorAll('.sc-thumb svg').length);
check('缩略图渲染了五线谱 SVG', thumbSvgs >= 5, `${thumbSvgs} 个 svg`);

// 内容进度点:小星星(16音/4小节=填满4点)
const filledDots = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.score-card:not(.new-card)')].find(c => c.querySelector('.sc-title')?.textContent === '小星星');
  return card ? card.querySelectorAll('.sc-dot.filled').length : -1;
});
check('小星星进度点=4(填满)', filledDots === 4, `${filledDots} 点`);

// 搜索:输入"小" → 只剩匹配
await page.evaluate(() => { document.querySelector('.lib-search input').value = '小'; document.querySelector('.lib-search input').dispatchEvent(new Event('input')); });
await new Promise(r => setTimeout(r, 300));
const afterSearch = await page.evaluate(() => document.querySelectorAll('.score-card:not(.new-card)').length);
check('搜索"小"→ 只剩 1 张(小星星)', afterSearch === 1, `${afterSearch} 张`);
// 清搜索
await page.evaluate(() => { const i = document.querySelector('.lib-search input'); i.value = ''; i.dispatchEvent(new Event('input')); });
await new Promise(r => setTimeout(r, 300));

// 切列表视图
await page.evaluate(() => document.querySelector('[data-view="list"]')?.click());
await new Promise(r => setTimeout(r, 300));
const isList = await page.evaluate(() => document.querySelector('.lib-grid')?.classList.contains('list'));
check('切到列表视图', isList);

// 切回网格
await page.evaluate(() => document.querySelector('[data-view="grid"]')?.click());
await new Promise(r => setTimeout(r, 300));

// 排序:点"小节" → 第一张应是 totalMeasures 最大的(G大调练习=8)
await page.evaluate(() => document.querySelector('[data-sort="bars"]')?.click());
await new Promise(r => setTimeout(r, 300));
const firstTitle = await page.evaluate(() => document.querySelector('.score-card:not(.new-card) .sc-title')?.textContent);
check('按小节排序 → 首张=G大调练习(8小节)', firstTitle === 'G 大调练习', firstTitle);

check('页面无 console 错误(库视图)', errors.length === 0, errors.slice(0,3).join(' | '));

// ═══ 进入曲子视图:MeasureSelector 组件 ═══
console.log('\n进入曲子视图(点「小星星」)...');
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.score-card:not(.new-card)')].find(c => c.querySelector('.sc-title')?.textContent === '小星星');
  c?.click();
});
await new Promise(r => setTimeout(r, 600));

check('进入曲子视图(显示编辑区标签)', await page.evaluate(() => /点五线谱放音/.test(document.querySelector('.sv-edit-label')?.textContent || '')));
check('曲名=小星星', await page.evaluate(() => document.querySelector('.appbar-name')?.textContent) === '小星星');

// MeasureSelector:4 个数字方块 + 2 个把手 + 背景层
const mBlocks = await page.evaluate(() => document.querySelectorAll('.ms-blk').length);
check('小节条 4 个数字方块', mBlocks === 4, `${mBlocks} 个`);
check('有左右把手', await page.evaluate(() => document.querySelectorAll('.ms-grip').length === 2));
check('有选择框背景层', await page.evaluate(() => !!document.querySelector('.ms-sel')));
check('末尾有 + 加小节', await page.evaluate(() => !!document.querySelector('.ms-add')));

// 内容指示点:小星星有内容 → 方块带 has-content
const hasContentCount = await page.evaluate(() => document.querySelectorAll('.ms-blk.has-content').length);
check('有内容的小节方块带指示点', hasContentCount >= 1, `${hasContentCount} 个`);

// 删除叉:hover 才出现(默认 opacity:0)。每个书签都有 del 按钮,但默认隐藏。
const delHidden = await page.evaluate(() => {
  const dels = [...document.querySelectorAll('.ms-del')];
  return dels.length > 0 && dels.every(d => getComputedStyle(d).opacity === '0');
});
check('删除叉默认隐藏(hover 才出现)', delHidden);

// 拖右把手加宽 → count 变 3(吸附到第3个方块)
console.log('拖右把手加宽...');
await page.evaluate(async () => {
  const rh = document.querySelector('.ms-grip-r');
  const blocks = [...document.querySelectorAll('.ms-blk')];
  const rhR = rh.getBoundingClientRect();
  const targetX = blocks[2].getBoundingClientRect().left + blocks[2].getBoundingClientRect().width/2;
  rh.dispatchEvent(new PointerEvent('pointerdown', { clientX: rhR.left + rhR.width/2, clientY: rhR.top + rhR.height/2, bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: targetX, clientY: rhR.top + rhR.height/2, bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: targetX, clientY: rhR.top + rhR.height/2, bubbles: true }));
});
await new Promise(r => setTimeout(r, 500));
const insideAfter = await page.evaluate(() => document.querySelectorAll('.ms-blk.inside').length);
check('拖右把手 → 框内方块变 3', insideAfter === 3, `${insideAfter} 个框内`);

// 点第 4 小节方块 → 起点跳到 3(范围提示变)
await page.evaluate(() => {
  const b = document.querySelector('.ms-blk[data-idx="3"]');
  // 模拟 pointerdown + 抬起(无大幅移动 = 点击)
  const r = b.getBoundingClientRect();
  b.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true }));
});
await new Promise(r => setTimeout(r, 400));
const rangeHint = await page.evaluate(() => document.querySelector('.sv-range-hint')?.textContent);
// 点击 idx=3 时 count=3,maxStart=4-3=1,start 夹到 1 → 范围 2–4(正确,组件 clamp 行为)
check('点第4小节 → 范围提示更新', /第 \d+–\d+ 小节/.test(rangeHint || ''), rangeHint);

// 工具盘:补全的功能存在
check('工具有 和音 按钮', await page.evaluate(() => !!document.querySelector('[data-act="chord"]')));
check('工具有 三连 按钮', await page.evaluate(() => !!document.querySelector('[data-act="tuplet"]')));
check('工具有 休止 按钮', await page.evaluate(() => !!document.querySelector('[data-act="rest"]')));
check('工具有 临时记号 ♯♭♮', await page.evaluate(() => document.querySelectorAll('[data-acc]').length === 3));

// 视图模式 radio
check('appbar 有视图模式 radio 4 个', await page.evaluate(() => document.querySelectorAll('.appbar-vbtn').length === 4), `${await page.evaluate(() => document.querySelectorAll('.appbar-vbtn').length)} 个`);
await page.evaluate(() => document.querySelector('[data-view="bass"]')?.click());
await new Promise(r => setTimeout(r, 300));
check('点低音 → 激活', await page.evaluate(() => document.querySelector('[data-view="bass"]')?.classList.contains('active')));
await page.evaluate(() => document.querySelector('[data-view="treble"]')?.click());
await new Promise(r => setTimeout(r, 300));

// 末尾加小节(组件内 +)
const beforeBars = await page.evaluate(() => document.querySelectorAll('.ms-blk').length);
await page.evaluate(() => document.querySelector('.ms-add')?.click());
await new Promise(r => setTimeout(r, 300));
const afterBars = await page.evaluate(() => document.querySelectorAll('.ms-blk').length);
check('点 + 加小节 → 方块数+1', afterBars === beforeBars + 1, `${beforeBars}→${afterBars}`);

// 删除框外小节(点 idx=4 的删除按钮)
const beforeBars2 = await page.evaluate(() => document.querySelectorAll('.ms-blk').length);
await page.evaluate(() => {
  window.confirm = () => true;
  document.querySelector('.ms-del')?.click();
});
await new Promise(r => setTimeout(r, 400));
const afterBars2 = await page.evaluate(() => document.querySelectorAll('.ms-blk').length);
check('点框外删除 → 方块数-1', afterBars2 === beforeBars2 - 1, `${beforeBars2}→${afterBars2}`);

// 返回曲谱库
await page.evaluate(() => document.querySelector('.appbar-back')?.click());
await new Promise(r => setTimeout(r, 500));
check('返回曲谱库', await page.evaluate(() => !!document.querySelector('.lib-title') && !document.querySelector('.score-view')));

// ═══ 二级页真实编辑:点击放音 + 休止符 + Backspace ═══
console.log('\n再进入,测真实编辑(未命名草稿,3 音)...');
await page.evaluate(() => [...document.querySelectorAll('.score-card:not(.new-card)')].find(c => c.querySelector('.sc-title')?.textContent === '未命名草稿')?.click());
await new Promise(r => setTimeout(r, 700));

const notesBefore = await page.evaluate(() => new Set([...document.querySelector('[data-role="staff"]').querySelectorAll('[data-idx]')].map(el => el.getAttribute('data-idx'))).size);
check('编辑区初始 3 个音(草稿)', notesBefore === 3, `${notesBefore} 个`);

// 点五线谱放音
await page.evaluate(() => {
  const sh = document.querySelector('[data-role="staff"]');
  const r = sh.querySelector('svg').getBoundingClientRect();
  sh.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + r.width*0.75, clientY: r.top + r.height*0.45, bubbles: true }));
  sh.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width*0.75, clientY: r.top + r.height*0.45, bubbles: true }));
});
await new Promise(r => setTimeout(r, 500));
const notesAfter = await page.evaluate(() => new Set([...document.querySelector('[data-role="staff"]').querySelectorAll('[data-idx]')].map(el => el.getAttribute('data-idx'))).size);
check('点击五线谱放音 → 音数变 4', notesAfter === 4, `${notesAfter} 个`);
check('简谱区渲染了内容', await page.evaluate(() => document.querySelector('[data-role="jianpu"]').querySelectorAll('[data-idx]').length > 0));

// 点休止符追加
await page.evaluate(() => document.querySelector('[data-act="rest"]')?.click());
await new Promise(r => setTimeout(r, 400));
const notesAfterRest = await page.evaluate(() => new Set([...document.querySelector('[data-role="staff"]').querySelectorAll('[data-idx]')].map(el => el.getAttribute('data-idx'))).size);
check('点休止 → 音数变 5', notesAfterRest === 5, `${notesAfterRest} 个`);

// Backspace 退格两次回 3
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Backspace'); await new Promise(r => setTimeout(r, 300));
await page.keyboard.press('Backspace'); await new Promise(r => setTimeout(r, 300));
const notesAfterUndo = await page.evaluate(() => new Set([...document.querySelector('[data-role="staff"]').querySelectorAll('[data-idx]')].map(el => el.getAttribute('data-idx'))).size);
check('Backspace ×2 → 音数回 3', notesAfterUndo === 3, `${notesAfterUndo} 个`);

// 三连音 toggle
await page.evaluate(() => document.querySelector('[data-act="tuplet"]')?.click());
check('点三连 → 激活', await page.evaluate(() => document.querySelector('[data-act="tuplet"]')?.classList.contains('active')));

check('页面无 console 错误(全程)', errors.length === 0, errors.slice(0,3).join(' | '));

await browser.close();
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${failed === 0 ? '🎉 全部通过' : '❌ 有失败'}: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
