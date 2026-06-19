const { launch } = require('puppeteer-core');
(async () => {
  const browser = await launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--hide-scrollbars','--window-size=1100,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1.5 });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await new Promise(r => setTimeout(r, 500));
  // 点「示例：小星星」按钮
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const ex = btns.find(b => b.textContent && b.textContent.includes('小星星'));
    if (ex) { ex.click(); return true; }
    return false;
  });
  console.log('点了小星星按钮:', clicked);
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: '/home/cong/AgentProjects/MusicSheet/screenshots/twinkle.png', fullPage: false });
  await browser.close();
  console.log('saved');
})();
