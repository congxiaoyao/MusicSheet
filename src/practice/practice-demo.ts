// 练琴页演示入口 —— 键盘 + 瀑布流 端到端测试页。
// 不依赖主 app,不建 PracticeApp,不碰 ScoreSheet。
// 内置三首曲子(小星星/欢乐颂/土耳其),模拟播放驱动 waterfall.onTick + keyboard.setActiveMidis。
// 访问: vite dev server 下 /practice-demo.html
//
// 本文件模拟「controller」职责:
//   - onTick 循环算当前响的音(computeActiveMidis,原始 midi + 左右手)
//   - 喂 keyboard.setActiveMidis + waterfall.onTick
//   - bounds:方块区容器相对练琴页的坐标自给(不接 ScoreSheet)
//   - 协调:keyboard.onKeyLayoutChange → waterfall.setKeyLayout(含 kbOffset);onHeightChange → 重算 bounds
//   - 持久化:键宽/高度存 localStorage

import '../style.css';
import { KEYS } from '../core/theory';
import { Score, rangeToPiece } from '../core/score';
import { Note } from '../core/types';
import { durationBeats } from '../core/types';
import { noteStartBeats, BEAT_EPS } from '../core/model';
import { buildKeyboard, whiteKeyRange, rangeFromWhites, ActiveNote } from './keyboard';
import { buildWaterfall, parseFallNotes, FallNote } from './waterfall';
import { KeyRange } from './key-coords';

// ── 曲子数据(复用 demo.ts 的三首曲子) ────────────────────
function n(midi: number | null, d: Note['duration'], dot = false): Note {
  return { midi: midi, duration: d, dotted: dot, accidental: null };
}
const q: Note['duration'] = 'quarter';
const h: Note['duration'] = 'half';
const e: Note['duration'] = 'eighth';
const s: Note['duration'] = 'sixteenth';
const C4=60,D4=62,E4=64,F4=65,G4=67,A4=69,B4=71,C5=72,D5=74,E5=76;
const C3=48,E3=52,G3=55,A2=45;

const songs: Record<string, Score> = {
  twinkle: { meta:{id:'twinkle',title:'小星星',key:KEYS.C,time:{num:4,den:4},totalMeasures:8,viewMode:'grand',updatedAt:0}, measures:[
    {treble:[n(C4,q),n(C4,q),n(G4,q),n(G4,q)],bass:[]},
    {treble:[n(A4,q),n(A4,q),n(G4,h)],bass:[]},
    {treble:[n(F4,q),n(F4,q),n(E4,q),n(E4,q)],bass:[]},
    {treble:[n(D4,q),n(D4,q),n(C4,h)],bass:[]},
    {treble:[n(G4,q),n(G4,q),n(F4,q),n(F4,q)],bass:[]},
    {treble:[n(E4,q),n(E4,q),n(D4,h)],bass:[]},
    {treble:[n(G4,q),n(G4,q),n(F4,q),n(F4,q)],bass:[]},
    {treble:[n(E4,q),n(E4,q),n(D4,h)],bass:[]},
  ]},
  ode: { meta:{id:'ode',title:'欢乐颂',key:KEYS.C,time:{num:4,den:4},totalMeasures:8,viewMode:'grand',updatedAt:0}, measures:[
    {treble:[n(E4,e),n(E4,e),n(F4,e),n(G4,e),n(G4,e),n(F4,e),n(E4,e),n(D4,e)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(C4,e),n(D4,e),n(E4,e),n(E4,q),n(D4,e),n(D4,e)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(E4,e),n(E4,e),n(F4,e),n(G4,e),n(G4,e),n(F4,e),n(E4,e),n(D4,e)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(C4,e),n(D4,e),n(E4,e),n(D4,q),n(C4,q)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(D4,e),n(E4,e),n(F4,e),n(F4,e),n(E4,e),n(D4,e),n(E4,q)],bass:[n(G3,h),n(C3,h)]},
    {treble:[n(G4,e),n(F4,e),n(E4,e),n(D4,e),n(E4,q),n(G4,q)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(C5,q),n(B4,q),n(A4,q),n(G4,q)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(A4,e),n(G4,e),n(F4,e),n(E4,e),n(D4,e),n(C4,e),n(D4,q)],bass:[n(G3,h),n(C3,h)]},
  ]},
  turkish: { meta:{id:'turkish',title:'土耳其进行曲',key:KEYS.C,time:{num:2,den:4},totalMeasures:8,viewMode:'grand',updatedAt:0}, measures:[
    {treble:[n(B4,s),n(A4,s),n(G4,s),n(A4,s),n(B4,s),n(A4,s),n(G4,s),n(A4,s)],bass:[n(E3,e),n(E3,e)]},
    {treble:[n(C5,s),n(B4,s),n(A4,s),n(G4,s),n(C5,s),n(B4,s),n(A4,s),n(G4,s)],bass:[n(E3,e),n(E3,e)]},
    {treble:[n(D5,s),n(C5,s),n(B4,s),n(A4,s),n(D5,s),n(C5,s),n(B4,s),n(A4,s)],bass:[n(A2,e),n(A2,e)]},
    {treble:[n(E5,s),n(D5,s),n(C5,s),n(B4,s),n(A4,e),n(G4,e)],bass:[n(A2,e),n(A2,e)]},
    {treble:[n(B4,s),n(A4,s),n(G4,s),n(A4,s),n(B4,s),n(A4,s),n(G4,s),n(A4,s)],bass:[n(E3,e),n(E3,e)]},
    {treble:[n(C5,s),n(B4,s),n(A4,s),n(G4,s),n(C5,s),n(B4,s),n(A4,s),n(G4,s)],bass:[n(E3,e),n(E3,e)]},
    {treble:[n(D5,s),n(C5,s),n(B4,s),n(A4,s),n(B4,s),n(A4,s),n(G4,s),n(A4,s)],bass:[n(A2,e),n(A2,e)]},
    {treble:[n(B4,q),n(A4,q)],bass:[n(E3,q),n(E3,q)]},
  ]},
};

// ── controller 端:算当前响的音(原始 midi + 左右手) ────────
// 复刻 playback-card L377-397 的思路,但返回原始 midi(不做 highlightMidi 映射),
// 且带左右手标识(treble=R, bass=L),供键盘高亮上色。
// 用整曲 treble/bass Piece + noteStartBeats 反查当前 beat 落在哪个音。

interface StaffSched {
  notes: Note[];
  starts: number[];
  hand: 'R' | 'L';
}

/** 算 beat 落在哪个音(行内局部 idx)。返回 -1 = 该 beat 不在任何音发声区间内。
 *  复刻 score-sheet.ts noteIndexAtBeat:找最后一个 startBeat ≤ beat 且 beat 仍在 [start, start+dur) 内的音。 */
function noteIndexAtBeat(beat: number, starts: number[], notes: Note[]): number {
  if (starts.length === 0) return -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] > beat + BEAT_EPS) break;
    const dur = durationBeats(notes[i]);
    if (beat < starts[i] + dur - BEAT_EPS) return i;
  }
  return -1;
}

/** 和弦扩展:同 chordId 的音都收集(复刻 playback-card L384-388 + score-sheet expand)。 */
function collectChord(notes: Note[], idx: number): number[] {
  if (idx < 0 || idx >= notes.length) return [];
  const head = notes[idx];
  if (head.midi === null) return [];
  if (!head.chordId) return [head.midi];
  const out: number[] = [];
  for (const n2 of notes) {
    if (n2.chordId === head.chordId && n2.midi !== null) out.push(n2.midi);
  }
  return out;
}

/** controller 每帧算当前响的原始 midi 集合(带左右手)。
 *  handFilter 过滤:单手隔离时只收那只手。 */
function computeActiveMidis(beat: number, staffs: StaffSched[], handFilter: 'both' | 'R' | 'L'): ActiveNote[] {
  const out: ActiveNote[] = [];
  for (const st of staffs) {
    if (handFilter !== 'both' && st.hand !== handFilter) continue;
    const idx = noteIndexAtBeat(beat, st.starts, st.notes);
    for (const midi of collectChord(st.notes, idx)) {
      out.push({ midi, hand: st.hand });
    }
  }
  return out;
}

// ── 持久化(controller 职责) ──────────────────────────────
const LS_PREFIX = 'musicsheet:practice:';
function lsGet<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(LS_PREFIX + key); return v === null ? fallback : JSON.parse(v) as T; }
  catch { return fallback; }
}
function lsSet(key: string, val: unknown): void {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(val)); } catch { /* ignore */ }
}

// ── 主入口 ────────────────────────────────────────────────
function main() {
  const root = document.getElementById('root')!;

  // 顶栏
  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  root.appendChild(bar);

  // 舞台:方块区 + 键盘
  const stage = document.createElement('div');
  stage.className = 'demo-stage';
  root.appendChild(stage);
  const fallWrap = document.createElement('div');
  fallWrap.className = 'demo-fall-wrap';
  stage.appendChild(fallWrap);
  const keysWrap = document.createElement('div');
  keysWrap.className = 'demo-keys-wrap';
  stage.appendChild(keysWrap);

  // 状态
  let currentSong = 'twinkle';
  let handFilter: 'both' | 'R' | 'L' = 'both';
  let playing = false;
  let beat = 0;
  let rafId: number | null = null;
  let lastTs: number | null = null;
  // 播放 BPM(每分钟拍数)。beat = 拍。一拍 = 60/bpm 秒。
  const BPM = 100;

  // 算当前曲子的整曲 treble/bass 调度(供 computeActiveMidis)。
  function buildStaffs(score: Score): StaffSched[] {
    const total = score.meta.totalMeasures;
    const tp = rangeToPiece(score, 0, total, 'treble');
    const bp = rangeToPiece(score, 0, total, 'bass');
    return [
      { notes: tp.treble, starts: noteStartBeats(tp), hand: 'R' },
      { notes: bp.bass, starts: noteStartBeats(bp), hand: 'L' },
    ];
  }

  /** 按谱面音域自动算键盘 range:同时算 treble+bass(whiteKeyRange 各算一次取并集)。
   *  旧实现只用 treble piece,bass 音域漏算 → 低音越界。 */
  function computeAutoRange(score: Score): KeyRange {
    const total = score.meta.totalMeasures;
    const tp = rangeToPiece(score, 0, total, 'treble');
    const bp = rangeToPiece(score, 0, total, 'bass');
    const tWhites = whiteKeyRange(tp);
    const bWhites = whiteKeyRange(bp);
    // 合并两组白键,去重排序,取首尾。
    const all = [...new Set([...tWhites, ...bWhites])].sort((a, b) => a - b);
    return rangeFromWhites(all);
  }

  // 初始音域:按谱面自动(whiteKeyRange 同时算 treble+bass),从 localStorage 恢复或重算。
  let score = songs[currentSong];
  let range: KeyRange = lsGet('range', null) ?? computeAutoRange(score);
  let kbHeight: number = lsGet('kbHeight', 140);
  let whiteW: number = lsGet('whiteW', 44);

  // 方块音符
  let fallNotes: FallNote[] = parseFallNotes(score);
  let staffs: StaffSched[] = buildStaffs(score);

  // ── 键盘组件 ──
  const keyboard = buildKeyboard(
    { range, height: kbHeight, keyWidth: whiteW, labels: 'name', fingering: 'follow', key: score.meta.key },
    {
      onKeyLayoutChange: (info) => {
        range = info.range;
        whiteW = info.whiteW;
        lsSet('range', info.range);
        lsSet('whiteW', info.whiteW);
        waterfall.setKeyLayout(info);
      },
      onHeightChange: (newH) => {
        kbHeight = newH;
        lsSet('kbHeight', newH);
        updateBounds();
      },
      onLabelChange: () => {},
      onFingeringChange: () => {},
    },
  );
  keysWrap.appendChild(keyboard.el);

  // ── 方块组件 ──
  const waterfall = buildWaterfall(
    { notes: fallNotes, range, whiteW: keyboard.getKeyWidth() },
    {},
  );
  fallWrap.appendChild(waterfall.el);

  // ── bounds:方块区容器相对练琴页的坐标(测试页自给,不接 ScoreSheet) ──
  function updateBounds() {
    // 方块区:从 fallWrap 顶 到 键盘顶(fallWrap 底)。
    // 用容器内部相对坐标:topY=0(容器顶),bottomY=容器高度。
    waterfall.setBounds({ topY: 0, bottomY: fallWrap.clientHeight });
  }
  // 延迟一次(等布局完成)。
  requestAnimationFrame(() => updateBounds());
  window.addEventListener('resize', updateBounds);

  // ── onTick 循环(requestAnimationFrame,beat 用时间差连续推进) ──
  // 旧实现 setInterval(tick, 200) 每秒只更新 5 次 → 方块位置跳跃,一卡一卡。
  // rAF 每帧(约 60fps)用 dt 连续推进 beat,方块位置平滑。
  const totalBeatsOf = (s: Score) => s.meta.totalMeasures * (s.meta.time.num * 4 / s.meta.time.den);
  const frame = (ts: number) => {
    if (!playing) return;
    if (lastTs == null) lastTs = ts;
    const dt = (ts - lastTs) / 1000;   // 秒
    lastTs = ts;
    beat += dt * (BPM / 60);           // 拍 = 秒 × 拍/秒
    const total = totalBeatsOf(score);
    if (beat > total) beat = 0;
    const active = computeActiveMidis(beat, staffs, handFilter);
    waterfall.onTick(beat);
    keyboard.setActiveMidis(active);
    rafId = requestAnimationFrame(frame);
  };
  const playBtn = mkBtn('▶ 播放', false, () => {});
  playBtn.classList.add('active');
  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    if (playing) {
      lastTs = null;
      rafId = requestAnimationFrame(frame);
    } else {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      keyboard.clearHighlight();
    }
  };

  // ── 顶栏按钮(复用 demo.ts 的工厂) ──
  const mkGroup = (label: string) => {
    const g = document.createElement('div');
    g.className = 'demo-btn-group';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.className = 'demo-btn-label';
    g.appendChild(lbl);
    return g;
  };
  function mkBtn(text: string, active: boolean, onClick: () => void) {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = 'demo-btn' + (active ? ' active' : '');
    b.onclick = () => {
      onClick();
      [...b.parentElement!.querySelectorAll('.demo-btn')].forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    };
    return b;
  }

  // 曲目
  const songGroup = mkGroup('曲目');
  for (const k of Object.keys(songs)) {
    songGroup.appendChild(mkBtn(songs[k].meta.title, k === currentSong, () => {
      currentSong = k;
      score = songs[k];
      fallNotes = parseFallNotes(score);
      staffs = buildStaffs(score);
      waterfall.setNotes(fallNotes);
      beat = 0;
    }));
  }
  bar.appendChild(songGroup);

  // 单手隔离
  const handGroup = mkGroup('单手');
  const handLabels: Record<string, string> = { both: '双手', R: '右手', L: '左手' };
  for (const hf of ['both', 'R', 'L'] as const) {
    handGroup.appendChild(mkBtn(handLabels[hf], hf === handFilter, () => {
      handFilter = hf;
      waterfall.setHandFilter(hf);
    }));
  }
  bar.appendChild(handGroup);

  // 播放(不参与 active 切换)
  const playGroup = mkGroup('播放');
  playGroup.appendChild(playBtn);
  bar.appendChild(playGroup);

  // ── 方块区高度滑块(调试用:手动调方块掉落区域高度看效果) ──
  // fallWrap 默认 flex:1 占满;设了 fallH 后改为固定高度(底部留白),键盘仍在底。
  let fallH: number | null = lsGet('fallH', null);   // null = 自动占满
  const applyFallH = () => {
    if (fallH == null) {
      // 自动:fallWrap flex:1 占满剩余空间,贴键盘顶。
      fallWrap.style.height = '';
      fallWrap.style.flex = '1';
      stage.style.justifyContent = '';
    } else {
      // 固定高度:fallWrap 不再占满,stage 内容贴底(fallWrap+键盘一起贴底),
      // 这样 fallWrap 底部仍是键盘顶,方块落点对齐键盘。
      fallWrap.style.flex = 'none';
      fallWrap.style.height = fallH + 'px';
      stage.style.justifyContent = 'flex-end';
    }
    updateBounds();
  };
  const fallGroup = mkGroup('方块区');
  const fallLabel = document.createElement('span');
  fallLabel.className = 'demo-btn-label';
  fallLabel.textContent = '高度 ' + (fallH == null ? '自动' : fallH);
  const fallRange = document.createElement('input');
  fallRange.type = 'range';
  fallRange.min = '120'; fallRange.max = '600'; fallRange.step = '10';
  fallRange.value = fallH == null ? '400' : String(fallH);
  fallRange.style.width = '120px';
  fallRange.style.accentColor = '#2563eb';
  // 自动/手动 切换按钮
  const fallAutoBtn = document.createElement('button');
  fallAutoBtn.textContent = '自动';
  fallAutoBtn.className = 'demo-btn' + (fallH == null ? ' active' : '');
  fallAutoBtn.onclick = () => {
    fallH = null;
    fallLabel.textContent = '高度 自动';
    fallAutoBtn.classList.add('active');
    lsSet('fallH', null);
    applyFallH();
  };
  fallRange.oninput = () => {
    fallH = parseInt(fallRange.value, 10);
    fallLabel.textContent = '高度 ' + fallH;
    fallAutoBtn.classList.remove('active');
    lsSet('fallH', fallH);
    applyFallH();
  };
  fallGroup.append(fallLabel, fallRange, fallAutoBtn);
  bar.appendChild(fallGroup);
  applyFallH();
}

main();
