const { launch } = require('puppeteer-core');
(async () => {
  const browser = await launch({
    executablePath: '/usr/bin/google-chrome-stable', headless: 'new',
    args: ['--no-sandbox','--disable-gpu','--window-size=1100,2400']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 2400, deviceScaleFactor: 1 });
  await page.goto('http://localhost:5173/beam-test.html', { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    try { await Promise.all([
      document.fonts.load('40px Bravura','\uE0A4'),
      document.fonts.load('40px Bravura','\uE0A2'),
    ]); } catch {}
  });
  await new Promise(r => setTimeout(r, 1500));
  // 直接在页面里数 SVG 里的 text 元素，并检测它们渲染后的 boundingBox 是否有可见尺寸
  const result = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg')];
    const info = [];
    for (let i = 0; i < Math.min(3, svgs.length); i++) {
      const texts = [...svgs[i].querySelectorAll('text')];
      // 找 noteheadBlack(U+E0A4) 的 text
      const heads = texts.filter(t => t.textContent && t.textContent.codePointAt(0) === 0xE0A4);
      const visible = heads.map(t => {
        const r = t.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), text: 'E0A4' };
      });
      info.push({ svgIdx: i, headCount: heads.length, samples: visible.slice(0,3) });
    }
    return info;
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
