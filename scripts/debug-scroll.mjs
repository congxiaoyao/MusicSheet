import { launch } from 'puppeteer-core';
const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1440,900'] });
const page = await browser.newPage();
await page.setViewport({ width:1440, height:900 });
page.on('console', m => console.log('[page]', m.text()));
await page.goto('file:///home/cong/AgentProjects/MusicSheet/practice-prototype.html', { waitUntil:'networkidle0' });
await new Promise(r=>setTimeout(r,800));
const d = await page.evaluate(()=>{
  const score = document.getElementById('score');
  const inner = document.getElementById('scoreInner');
  const svg = inner.querySelector('svg');
  const vb = svg.getAttribute('viewBox').split(' ');
  return {
    scrollTop: score.scrollTop,
    scoreClientH: score.clientHeight,
    innerClientH: inner.clientHeight,
    svgViewBoxH: parseFloat(vb[3]),
    svgBoundingH: svg.getBoundingClientRect().height,
    SYS_H: 96, SYS_GAP: 34,
  };
});
console.log(JSON.stringify(d,null,2));
const scale = d.svgBoundingH / d.svgViewBoxH;  // 应该用实际渲染高度
console.log('scale(渲染高/vb高)=', scale);
console.log('scale(inner/clientH)=', d.innerClientH / d.svgViewBoxH);
await browser.close();
