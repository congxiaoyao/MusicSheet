// 截取 beam-test 页面的指定用例（双梁特写），验证 BEAM_GAP 调整效果。
// 用法: node scripts/shot-beam.mjs
import puppeteer from '../node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'shots');
import { mkdirSync } from 'fs';
mkdirSync(OUT, { recursive: true });

const URL = 'http://localhost:5173/beam-test.html';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: 'new',
  args: ['--no-sandbox', '--force-device-scale-factor=2'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 2000, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 600));

// 页面结构: 每个 case 一个块。截整页 + 两个双梁用例的局部。
await page.screenshot({ path: path.join(OUT, 'beam-all.png'), fullPage: true });
console.log('✅ 已截整页:', path.join(OUT, 'beam-all.png'));

// 定位：标题在 <b> 内，向上找到 .case-wrap 祖先（带 border 的卡片），截该卡片。
for (const label of ['4. 同拍 4 个十六分音符', '5. 两拍各 4 个十六分']) {
  const found = await page.evaluate((lbl) => {
    const bs = Array.from(document.querySelectorAll('b'));
    const el = bs.find(e => (e.textContent || '').includes(lbl));
    if (!el) return null;
    // 向上找带 border 的卡片容器（case-wrap）
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const cs = node.style && getComputedStyle(node);
      if (cs && cs.border && cs.border !== '0px none rgb(0, 0, 0)' && cs.borderWidth !== '0px') {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      node = node.parentElement;
    }
    // 兜底：用 svgWrap
    const svg = document.querySelector('svg');
    if (svg) {
      const r = svg.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return null;
  }, label);
  if (found) {
    const fname = label.startsWith('4') ? 'beam-case4.png' : 'beam-case5.png';
    await page.screenshot({ path: path.join(OUT, fname), clip: { x: found.x, y: found.y, width: found.w, height: found.h } });
    console.log('✅ 已截:', path.join(OUT, fname), JSON.stringify(found));
  } else {
    console.log('⚠️ 未找到用例:', label);
  }
}

await browser.close();
