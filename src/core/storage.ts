// 前端存储客户端 —— 封装与服务端(server/index.mjs)的 HTTP 通信。
//
// 所有请求走相对路径 /api/...(开发时由 vite proxy 转发到 Node 服务;生产时 Node 服务
// 同时服务 API 与 dist/)。返回 Promise,出错抛带中文 message 的 Error。
//
// 设计:薄封装,直接对应服务端端点。App 层只依赖这里的类型化函数,不直接碰 fetch。

import { Score, ScoreMeta, MeasureData } from './score';
import { KeySig, TimeSig, ViewMode } from './types';

/** 通用 fetch 封装:JSON 请求/响应,非 2xx 抛 Error(带服务端中文 message)。 */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opt: RequestInit = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch('/api' + path, opt);
  } catch (err) {
    // 网络错误(服务器未启动/不可达):给出明确提示。
    throw new Error('无法连接存储服务器(请确认 Node 服务已启动):' + (err as Error).message);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { /* 非 JSON(如导出端点的原始文本),原样返回 */ data = text; }
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data)
      ? String((data as { error: unknown }).error)
      : `请求失败(${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

// ── 端点封装 ──────────────────────────────────────────────

/** 列所有曲谱 meta(按 updatedAt 降序)。 */
export function listPieces(): Promise<{ pieces: ScoreMeta[] }> {
  return api('GET', '/pieces');
}

/** 建新曲谱。返回完整 meta。 */
export function createPiece(input: {
  title: string;
  key?: KeySig;
  time?: TimeSig;
  totalMeasures: number;
  viewMode?: ViewMode;
}): Promise<ScoreMeta> {
  return api('POST', '/pieces', input);
}

/** 读整曲 Score(manifest + 全部小节)。 */
export function getPiece(id: string): Promise<Score> {
  return api('GET', '/pieces/' + encodeURIComponent(id));
}

/** 改 meta(改 time/totalMeasures 时服务端重建/截断小节)。返回新 meta。 */
export function updateMeta(id: string, patch: {
  title?: string;
  key?: KeySig;
  time?: TimeSig;
  totalMeasures?: number;
  viewMode?: ViewMode;
}): Promise<ScoreMeta> {
  return api('PUT', '/pieces/' + encodeURIComponent(id) + '/meta', patch);
}

/** 单小节局部覆写(硬指标:只落盘这一小节)。返回 { ok, updatedAt }。 */
export function putMeasure(id: string, measureIndex0Based: number, m: MeasureData): Promise<{ ok: boolean; updatedAt: number }> {
  return api('PUT', '/pieces/' + encodeURIComponent(id) + '/measures/' + measureIndex0Based, m);
}

/** 删整曲。 */
export function deletePiece(id: string): Promise<{ ok: boolean }> {
  return api('DELETE', '/pieces/' + encodeURIComponent(id));
}

/** 导出整曲打包文本(.mscore,带 musicsheet-score 头)。 */
export async function exportPiece(id: string): Promise<string> {
  return api<string>('GET', '/pieces/' + encodeURIComponent(id) + '/export');
}

/** 整曲打包导入(覆盖既有曲谱,保留 id)。返回新 meta。 */
export function importPiece(id: string, mscoreText: string): Promise<ScoreMeta> {
  return api('POST', '/pieces/' + encodeURIComponent(id) + '/import', mscoreText);
}

// ── 局域网访问地址(供 UI 展示给用户) ────────────────────────

/** 获取本机局域网 IP 列表(供 pad/电视 访问)。 */
export function getLanIp(): Promise<{ ips: string[]; port: number }> {
  return api('GET', '/lan-ip');
}

// ── 落盘节流队列(3 秒间隔,按小节局部落盘) ───────────────────
// App 层增删音后,标记 dirty 小节并调度;3 秒内无新改动则批量 PUT。
// 切窗/切曲谱/页面关闭前强制 flush(立即落盘),避免丢失。

/** 落盘队列:按 measureIndex → MeasureData 收集改动,3 秒后批量 PUT。 */
export class MeasureFlusher {
  private dirty = new Map<number, MeasureData>();
  private timer: number | null = null;
  private readonly debounceMs: number;
  private readonly onFlush: (measureIndex: number, m: MeasureData) => Promise<void>;

  constructor(onFlush: (measureIndex: number, m: MeasureData) => Promise<void>, debounceMs = 3000) {
    this.onFlush = onFlush;
    this.debounceMs = debounceMs;
  }

  /** 标记某小节已改动(3 秒后批量落盘)。 */
  markDirty(measureIndex: number, m: MeasureData): void {
    this.dirty.set(measureIndex, m);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.flush(); }, this.debounceMs);
  }

  /** 立即落盘所有 dirty 小节(切窗/关闭前调用)。返回是否真有写入。 */
  async flush(): Promise<boolean> {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    if (this.dirty.size === 0) return false;
    const entries = Array.from(this.dirty.entries());
    this.dirty.clear();
    for (const [idx, m] of entries) {
      try { await this.onFlush(idx, m); }
      catch (err) {
        // 落盘失败:重新入队,下次再试(不丢用户改动)。
        console.warn('[storage] 小节 ' + idx + ' 落盘失败,重新排队:', err);
        this.dirty.set(idx, m);
        this.schedule();
      }
    }
    return true;
  }

  /** 是否有待落盘改动。 */
  hasPending(): boolean { return this.dirty.size > 0; }
}
