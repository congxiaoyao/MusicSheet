// 跑单个 bench 场景
// 用法: node run-bench.mjs <scene> '<json params>' [sampleMs]
// 例: node run-bench.mjs composite '{"count":100,"mode":"will-change"}' 15000
import { connect, evalJS, navigate, close } from './cdp-client.mjs';

const BENCH_URL = process.env.BENCH_URL || 'http://127.0.0.1:5173/bench.html';
const scene = process.argv[2];
const paramsArg = process.argv[3] || '{}';
const sampleMs = parseInt(process.argv[4] || '15000', 10);

if (!scene) {
  console.error('用法: node run-bench.mjs <scene> \'<json params>\' [sampleMs]');
  console.error('场景:composite, gpu-throughput, dom-scale, js-budget');
  process.exit(1);
}

let params;
try { params = JSON.parse(paramsArg); }
catch (e) { console.error('params JSON 解析失败:', e.message); process.exit(1); }

await connect();

// 先确认在 bench.html,否则导航过去
const url = await evalJS('location.href');
if (!url.includes('bench.html')) {
  console.error('当前不在 bench.html,导航中... 当前:', url);
  await navigate(BENCH_URL);
}

// ping 确认 harness 就绪
const pong = await evalJS('window.__bench ? window.__bench.ping() : "NO_HARNESS"');
if (pong !== 'pong') {
  console.error('harness 未就绪:', pong);
  process.exit(1);
}

console.log(`▶ 跑场景: ${scene} ${JSON.stringify(params)} (sample ${sampleMs}ms)`);
const t0 = Date.now();
const result = await evalJS(
  `window.__bench.run(${JSON.stringify(scene)}, ${JSON.stringify(params)}, { sampleMs: ${sampleMs} })`,
  { awaitPromise: true }
);
const elapsed = Date.now() - t0;

// 汇总
const fps = result.fps || [];
const lt = result.longtasks || [];
fps.sort((a, b) => a - b);
lt.sort((a, b) => a - b);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a, p) => (a.length ? a[Math.floor(a.length * p)] : 0);

console.log(`✓ 完成 (${elapsed}ms, 采样 ${fps.length} 秒)`);
console.log(`  FPS: min=${fps[0] || 0} p25=${pct(fps, .25)} 中位=${pct(fps, .5)} p75=${pct(fps, .75)} max=${fps[fps.length - 1] || 0} 均值=${Math.round(avg(fps))}`);
console.log(`  LongTask(>50ms): 数量=${lt.length} 总=${Math.round(lt.reduce((x, y) => x + y, 0))}ms 最长=${lt[lt.length - 1] || 0}ms`);
if (result.extra && Object.keys(result.extra).length) {
  console.log(`  Extra: ${JSON.stringify(result.extra)}`);
}
// 完整 JSON 供 matrix 收集
console.log(`\n__RESULT__${JSON.stringify(result)}`);

close();
