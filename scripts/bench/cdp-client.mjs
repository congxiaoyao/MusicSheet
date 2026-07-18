// CDP 客户端:连接 Android WebView(经 adb forward 到 localhost:9222)
// 复用 /tmp/cdp_eval.mjs 验证过的手写 WebSocket 范式
// 提供给 run-bench.mjs / matrix.mjs 复用
//
// 用法:
//   import { connect, evalJS, navigate, close } from './cdp-client.mjs';
//   await connect();  // 连 localhost:9222
//   await navigate('http://127.0.0.1:5173/bench.html');
//   const r = await evalJS('window.__bench.ping()');  // 返回 JS 值

const CDP_URL = 'http://localhost:9222';

let ws = null;
let msgId = 1;
const pending = new Map();

function onMessage(e) {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
}

/** 连接 CDP(若已连则复用)。返回 page 信息 */
export async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const resp = await fetch(`${CDP_URL}/json`);
  const pages = await resp.json();
  const page = pages.find((p) => p.webSocketDebuggerUrl);
  if (!page) throw new Error('no debuggable page (WebView 未开调试?app 没起?)');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', onMessage);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  return page;
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** 执行 JS,返回值(returnByValue) */
export async function evalJS(js, opts = {}) {
  const r = await send('Runtime.evaluate', {
    expression: js,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? true,
  });
  if (r.exceptionDetails) {
    const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error('JS error: ' + (desc || '').slice(0, 300));
  }
  return r.result.value;
}

/** 导航到 URL,等加载完成 */
export async function navigate(url, timeoutMs = 15000) {
  await send('Page.enable');
  // 用 Page.navigate + 等 loadEventFired
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('navigate timeout: ' + url)), timeoutMs);
    const listener = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === 'Page.loadEventFired') {
        clearTimeout(timer);
        ws.removeEventListener('message', listener);
        // 给页面 JS 一点初始化时间
        setTimeout(resolve, 500);
      }
    };
    ws.addEventListener('message', listener);
    try {
      await send('Page.navigate', { url });
    } catch (err) {
      clearTimeout(timer);
      ws.removeEventListener('message', listener);
      reject(err);
    }
  });
}

/** 抓 CDP trace(可选),返回 trace events 数组 */
export async function collectTrace(seconds, categories) {
  await send('Tracing.start', {
    traceConfig: {
      includedCategories: categories || [
        'toplevel', 'rail', 'v8', 'blink.console', 'gc',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
      ],
      excludedCategories: ['*'],
    },
  });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const events = [];
  await new Promise((resolve) => {
    const listener = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === 'Tracing.tracingComplete') {
        ws.removeEventListener('message', listener);
        resolve();
      } else if (msg.method === 'Tracing.dataCollected') {
        events.push(...(msg.params.value || []));
      }
    };
    ws.addEventListener('message', listener);
    send('Tracing.end');
  });
  return events;
}

export function close() {
  if (ws) ws.close();
}

// 直接命令行调用:node cdp-client.mjs "<js>"
// 用于调试:快速 eval 一句 JS 看结果
if (import.meta.url === `file://${process.argv[1]}`) {
  const js = process.argv[2];
  if (!js) { console.error('用法: node cdp-client.mjs "<js>"'); process.exit(1); }
  await connect();
  try {
    const r = await evalJS(js);
    console.log(typeof r === 'string' ? r : JSON.stringify(r));
  } catch (e) { console.error(e.message); process.exit(1); }
  close();
}
