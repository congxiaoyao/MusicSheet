const { launch } = require('puppeteer-core');
(async () => {
  const url = process.argv[2];
  const out = process.argv[3];
  const w = +(process.argv[4] || 1000);
  const browser = await launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--hide-scrollbars',`--window-size=${w},2400`]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 2400, deviceScaleFactor: 1.5 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log('saved', out);
})();
