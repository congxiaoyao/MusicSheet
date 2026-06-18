const { launch } = require('puppeteer-core');
(async () => {
  const browser = await launch({
    executablePath: '/usr/bin/google-chrome-stable', headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--window-size=1100,1200']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1200, deviceScaleFactor: 2 });
  await page.goto('http://localhost:5173/beam-test.html', { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await new Promise(r => setTimeout(r, 1500));
  // 用例1是第一个 svg。裁第一个 noteheadBlack 周围 200x200
  const box = await page.evaluate(() => {
    const svg = document.querySelectorAll('svg')[1]; // 第0个可能是别的
    const svgs = [...document.querySelectorAll('svg')];
    for (const svg of svgs) {
      const head = [...svg.querySelectorAll('text')].find(t => t.textContent && t.textContent.codePointAt(0)===0xE0A4);
      if (head) {
        const r = head.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
    }
    return null;
  });
  console.log('notehead bbox:', JSON.stringify(box));
  if (box) {
    // 截这个区域周围
    await page.screenshot({
      path: '/home/cong/AgentProjects/MusicSheet/head-zoom.png',
      clip: { x: box.x - 40, y: box.y - 60, width: box.w + 80, height: box.h + 160 }
    });
  }
  await browser.close();
  console.log('done');
})();
