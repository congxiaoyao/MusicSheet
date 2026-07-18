// 跑完整测试矩阵:全部场景 × 全部梯度 × 多轮 → 报告
// 用法: node matrix.mjs [--rounds N] [--out report.json]
// 默认 3 轮,输出到 stdout + bench-report.json
import { connect, evalJS, navigate, close } from './cdp-client.mjs';

const BENCH_URL = process.env.BENCH_URL || 'http://127.0.0.1:5173/bench.html';
const args = process.argv.slice(2);
const roundsIdx = args.indexOf('--rounds');
const ROUNDS = roundsIdx >= 0 ? parseInt(args[roundsIdx + 1], 10) : 3;
const outIdx = args.indexOf('--out');
const OUT_FILE = outIdx >= 0 ? args[outIdx + 1] : 'bench-report.json';
const SAMPLE_MS = 10000;   // 每轮采样 10s(平衡精度与总时长)
const WARMUP_MS = 2000;

// ─── 测试矩阵定义 ───
const MATRIX = {
  // 场景 A:合成层对照(count 固定 100,变 mode)—— 找最优合成策略
  composite: [
    { count: 100, mode: 'transform-only' },
    { count: 100, mode: 'will-change' },
    { count: 100, mode: 'contain' },
    { count: 100, mode: 'top-left' },
  ],
  // 场景 B:GPU 合成吞吐(transform-only,变 count)—— 找掉帧临界点
  'gpu-throughput': [
    { count: 10, mode: 'transform-only' },
    { count: 50, mode: 'transform-only' },
    { count: 100, mode: 'transform-only' },
    { count: 300, mode: 'transform-only' },
    { count: 500, mode: 'transform-only' },
    { count: 1000, mode: 'transform-only' },
  ],
  // 场景 C:DOM 规模(变 count + kind)—— 找 layout/paint 转折点
  'dom-scale': [
    { count: 500, kind: 'div' },
    { count: 2000, kind: 'div' },
    { count: 5000, kind: 'div' },
    { count: 500, kind: 'svg' },
    { count: 2000, kind: 'svg' },
    { count: 5000, kind: 'svg' },
  ],
  // 场景 D:JS 单帧预算(变 work)—— 找不掉帧上限
  'js-budget': [
    { work: 1000 },
    { work: 5000 },
    { work: 10000 },
    { work: 50000 },
    { work: 100000 },
  ],
};

// ─── 统计工具 ───
const median = (a) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0;
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
// 把每轮的 extra(如 {renderMs, layoutMs})按字段取中位
function medianExtra(rounds) {
  const keys = new Set();
  rounds.forEach((r) => Object.keys(r.extra || {}).forEach((k) => keys.add(k)));
  const out = {};
  keys.forEach((k) => {
    const vals = rounds.map((r) => r.extra?.[k]).filter((v) => typeof v === 'number');
    if (vals.length) out[k] = Math.round(median(vals) * 100) / 100;
  });
  return out;
}

async function runOnce(scene, params) {
  const result = await evalJS(
    `window.__bench.run(${JSON.stringify(scene)}, ${JSON.stringify(params)}, { warmupMs: ${WARMUP_MS}, sampleMs: ${SAMPLE_MS} })`,
    { awaitPromise: true }
  );
  const fps = result.fps || [];
  const lt = result.longtasks || [];
  return {
    fpsMedian: median(fps),
    fpsMin: fps.length ? Math.min(...fps) : 0,
    fpsMax: fps.length ? Math.max(...fps) : 0,
    longtaskCount: lt.length,
    longtaskTotal: lt.reduce((x, y) => x + y, 0),
    longtaskMax: lt.length ? Math.max(...lt) : 0,
    extra: result.extra || {},
    _raw: { fps, longtasks: lt },   // 原始(报告里可省)
  };
}

console.log(`═══ bench matrix ═══`);
console.log(`目标: ${BENCH_URL}`);
console.log(`轮数: ${ROUNDS} × 采样 ${SAMPLE_MS}ms × 预热 ${WARMUP_MS}ms`);
console.log(`场景: ${Object.keys(MATRIX).join(', ')}`);

await connect();
const curUrl = await evalJS('location.href');
if (!curUrl.includes('bench.html')) {
  console.log('导航到 bench.html...');
  await navigate(BENCH_URL);
}
const pong = await evalJS('window.__bench.ping()');
if (pong !== 'pong') { console.error('harness 未就绪'); process.exit(1); }

const report = { config: { BENCH_URL, ROUNDS, SAMPLE_MS, WARMUP_MS, timestamp: new Date().toISOString() }, scenes: {} };
const totalCases = Object.values(MATRIX).reduce((s, arr) => s + arr.length, 0);
let caseIdx = 0;

for (const [scene, paramsList] of Object.entries(MATRIX)) {
  report.scenes[scene] = [];
  for (const params of paramsList) {
    caseIdx++;
    const label = `${scene} ${JSON.stringify(params)}`;
    console.log(`\n[${caseIdx}/${totalCases}] ${label}`);
    const runs = [];
    for (let r = 0; r < ROUNDS; r++) {
      process.stdout.write(`  轮 ${r + 1}/${ROUNDS}: `);
      try {
        const res = await runOnce(scene, params);
        runs.push(res);
        console.log(`fps=${res.fpsMedian} lt=${res.longtaskCount}(${res.longtaskMax}ms)`);
      } catch (e) {
        console.log(`失败: ${e.message}`);
        runs.push({ error: e.message });
      }
    }
    // 汇总(只对成功的轮)
    const ok = runs.filter((r) => !r.error);
    const summary = {
      params,
      rounds: runs.map((r) => ({ fpsMedian: r.fpsMedian, longtaskCount: r.longtaskCount, longtaskMax: r.longtaskMax, extra: r.extra || {}, error: r.error })),
      fpsMedian_ofMedians: ok.length ? median(ok.map((r) => r.fpsMedian)) : null,
      longtaskCount_median: ok.length ? median(ok.map((r) => r.longtaskCount)) : null,
      longtaskMax_median: ok.length ? median(ok.map((r) => r.longtaskMax)) : null,
      // extra 汇总:取每轮 extra 的中位(如 renderMs/layoutMs)
      extra_median: ok.length ? medianExtra(ok) : {},
      okRounds: ok.length,
    };
    report.scenes[scene].push(summary);
  }
}

close();

// 写报告
import { writeFileSync } from 'node:fs';
writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
console.log(`\n═══ 完成,报告 → ${OUT_FILE} ═══`);

// 打印汇总表
console.log('\n━━━ 汇总(median of medians)━━━');
for (const [scene, cases] of Object.entries(report.scenes)) {
  console.log(`\n[${scene}]`);
  for (const c of cases) {
    const extraStr = c.extra_median && Object.keys(c.extra_median).length
      ? ' ' + Object.entries(c.extra_median).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    console.log(`  ${JSON.stringify(c.params).padEnd(45)} fps=${String(c.fpsMedian_ofMedians).padStart(3)} lt=${String(c.longtaskCount_median).padStart(3)}×${c.longtaskMax_median || 0}ms${extraStr} (${c.okRounds}/${ROUNDS} ok)`);
  }
}
