const { launch } = require('puppeteer-core');
(async () => {
  const browser = await launch({
    executablePath: '/usr/bin/google-chrome-stable', headless: 'new',
    args: ['--no-sandbox','--disable-gpu']
  });
  const page = await browser.newPage();
  // 抓测试页第一个用例 SVG 的 outerHTML
  await page.goto('http://localhost:5173/beam-test.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 2000));
  const testSvg = await page.evaluate(() => {
    const svg = document.querySelectorAll('svg')[0];
    return svg ? svg.outerHTML.slice(0, 2000) : 'NO SVG';
  });
  console.log('=== 测试页第一个 SVG(前2000字符)===');
  console.log(testSvg);

  // 抓主应用小星星 SVG
  await page.goto('http://localhost:5171/', { waitUntil: 'networkidle0' }).catch(()=>{});
  const page2 = await browser.newPage();
  await page2.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));
  // 点小星星
  await page2.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.includes('小星星'));
    if(btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  const twinkleSvg = await page2.evaluate(() => {
    const svg = document.querySelector('#app svg, svg');
    return svg ? svg.outerHTML.slice(0, 2000) : 'NO SVG';
  });
  console.log('\n=== 小星星 SVG(前2000字符)===');
  console.log(twinkleSvg);
  await browser.close();
})();
