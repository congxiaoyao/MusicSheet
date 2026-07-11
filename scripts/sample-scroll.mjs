import { launch } from 'puppeteer-core';
const browser = await launch({ executablePath: '/usr/bin/google-chrome-stable', headless: 'new', args: ['--no-sandbox','--disable-gpu','--window-size=1440,900'] });
const page = await browser.newPage();
await page.setViewport({ width:1440, height:900 });
const url = 'file:///home/cong/AgentProjects/MusicSheet/practice-prototype.html';
await page.goto(url, { waitUntil:'networkidle0' });

async function sample(label){
  const d = await page.evaluate(()=>{
    const score = document.getElementById('score');
    const stage = document.querySelector('.pr-stage').getBoundingClientRect();
    const overlay = document.getElementById('overlay').getBoundingClientRect();
    // 当前可见的右手符头（y 在舞台范围内）
    const heads = [...document.querySelectorAll('.sn[data-hand="R"] ellipse')];
    const visHeads = heads.filter(h => {
      const r = h.getBoundingClientRect();
      return r.top > stage.top - 20 && r.top < stage.bottom;
    }).map(h => {
      const r = h.getBoundingClientRect();
      return Math.round(r.top + r.height/2);
    });
    return {
      scrollTop: Math.round(score.scrollTop),
      visHeadYs: visHeads.slice(0,8),
      overlayTop: Math.round(overlay.top - stage.top),  // 相对舞台
    };
  });
  const stageH = 813;
  console.log(`[${label}] scrollTop=${d.scrollTop} | 叠加层在舞台${d.overlayTop}px处 | 可见符头y(舞台坐标): ${d.visHeadYs.join(', ')}`);
  await page.screenshot({ path: `/home/cong/AgentProjects/MusicSheet/practice-shot-${label}.png` });
}

await new Promise(r=>setTimeout(r, 1000));
await sample('t1-first');

// 第5行（sys=4，约 4*16+8=72拍 ≈ 43秒）—— 太久，加速：调到 1.6x
await page.evaluate(()=>{ document.getElementById('speed').value = 1.6; document.getElementById('speed').dispatchEvent(new Event('input')); });
await new Promise(r=>setTimeout(r, 6000));
await sample('t2-mid');

await new Promise(r=>setTimeout(r, 8000));
await sample('t3-late');

await browser.close();
console.log('done');
