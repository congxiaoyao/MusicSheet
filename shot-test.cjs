const { launch } = require('puppeteer-core');
(async () => {
  const browser = await launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--hide-scrollbars','--window-size=1000,2400']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 2400, deviceScaleFactor: 1.5 });
  await page.goto('http://localhost:5173/beam-test.html', { waitUntil: 'networkidle0', timeout: 30000 });
  // 关键：等字体 ready，再多等一会让所有 SVG 渲染完
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    // 主动触发所有 Bravura 字符加载
    const chars = ['\uE0A4','\uE0A2','\uE050','\uE084'];
    if (document.fonts) for (const c of chars) try { await document.fonts.load('40px Bravura', c); } catch {}
  });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: '/home/cong/AgentProjects/MusicSheet/screenshots/test-final.png', fullPage: true });
  await browser.close();
  console.log('saved');
})();
