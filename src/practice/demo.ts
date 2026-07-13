// ScoreSheet 演示入口 —— 练琴页谱面组件独立 demo。
// 不依赖主 app,内置三首曲子(小星星/欢乐颂/土耳其),支持切换 模式(staff/jianpu/both)、
// 密度(compact/normal/loose)、模拟播放(行滚动+符头高亮)。
// 访问: vite dev server 下 /score-sheet-demo.html

import '../style.css';
import { KEYS } from '../core/theory';
import { Score } from '../core/score';
import { Note } from '../core/types';
import { beatsPerBar } from '../core/types';
import { buildScoreSheet, ScoreMode } from './score-sheet';
import { ensureFontLoaded } from '../render/glyphs';

function n(midi: number | null, d: Note['duration'], dot = false): Note {
  return { midi: midi, duration: d, dotted: dot, accidental: null };
}
const q: Note['duration'] = 'quarter';
const h: Note['duration'] = 'half';
const e: Note['duration'] = 'eighth';
const s: Note['duration'] = 'sixteenth';

// 音高常量
const C4=60,D4=62,E4=64,F4=65,G4=67,A4=69,B4=71,C5=72,D5=74,E5=76;
const C3=48,E3=52,G3=55,A2=45;

/** 把主题小节循环扩展到 total 小节(够看多行滚动效果)。 */
function loopMeasures(theme: { treble: Note[]; bass: Note[] }[], total: number): { treble: Note[]; bass: Note[] }[] {
  const out: { treble: Note[]; bass: Note[] }[] = [];
  for (let i = 0; i < total; i++) out.push(theme[i % theme.length]);
  return out;
}

// ── 曲库(每首 24 小节,主题循环 3 次,够看多行滚动) ──
const songs: Record<string, Score> = {
  twinkle: { meta:{id:'twinkle',title:'小星星',key:KEYS.C,time:{num:4,den:4},totalMeasures:24,viewMode:'grand',updatedAt:0}, measures: loopMeasures([
    {treble:[n(C4,q),n(C4,q),n(G4,q),n(G4,q)],bass:[]},
    {treble:[n(A4,q),n(A4,q),n(G4,h)],bass:[]},
    {treble:[n(F4,q),n(F4,q),n(E4,q),n(E4,q)],bass:[]},
    {treble:[n(D4,q),n(D4,q),n(C4,h)],bass:[]},
    {treble:[n(G4,q),n(G4,q),n(F4,q),n(F4,q)],bass:[]},
    {treble:[n(E4,q),n(E4,q),n(D4,h)],bass:[]},
    {treble:[n(G4,q),n(G4,q),n(F4,q),n(F4,q)],bass:[]},
    {treble:[n(E4,q),n(E4,q),n(D4,h)],bass:[]},
  ], 24)},
  ode: { meta:{id:'ode',title:'欢乐颂',key:KEYS.C,time:{num:4,den:4},totalMeasures:24,viewMode:'grand',updatedAt:0}, measures: loopMeasures([
    {treble:[n(E4,e),n(E4,e),n(F4,e),n(G4,e),n(G4,e),n(F4,e),n(E4,e),n(D4,e)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(C4,e),n(D4,e),n(E4,e),n(E4,q),n(D4,e),n(D4,e)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(E4,e),n(E4,e),n(F4,e),n(G4,e),n(G4,e),n(F4,e),n(E4,e),n(D4,e)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(C4,e),n(D4,e),n(E4,e),n(D4,q),n(C4,q)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(D4,e),n(E4,e),n(F4,e),n(F4,e),n(E4,e),n(D4,e),n(E4,q)],bass:[n(G3,h),n(C3,h)]},
    {treble:[n(G4,e),n(F4,e),n(E4,e),n(D4,e),n(E4,q),n(G4,q)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(C5,q),n(B4,q),n(A4,q),n(G4,q)],bass:[n(C3,h),n(G3,h)]},
    {treble:[n(A4,e),n(G4,e),n(F4,e),n(E4,e),n(D4,e),n(C4,e),n(D4,q)],bass:[n(G3,h),n(C3,h)]},
  ], 24)},
  turkish: { meta:{id:'turkish',title:'土耳其进行曲',key:KEYS.C,time:{num:2,den:4},totalMeasures:24,viewMode:'grand',updatedAt:0}, measures: loopMeasures([
    {treble:[n(B4,s),n(A4,s),n(G4,s),n(A4,s),n(B4,s),n(A4,s),n(G4,s),n(A4,s)],bass:[n(E3,e),n(E3,e)]},
    {treble:[n(C5,s),n(B4,s),n(A4,s),n(G4,s),n(C5,s),n(B4,s),n(A4,s),n(G4,s)],bass:[n(E3,e),n(E3,e)]},
    {treble:[n(D5,s),n(C5,s),n(B4,s),n(A4,s),n(D5,s),n(C5,s),n(B4,s),n(A4,s)],bass:[n(A2,e),n(A2,e)]},
    {treble:[n(E5,s),n(D5,s),n(C5,s),n(B4,s),n(A4,e),n(G4,e)],bass:[n(A2,e),n(A2,e)]},
    {treble:[n(B4,s),n(A4,s),n(G4,s),n(A4,s),n(B4,s),n(A4,s),n(G4,s),n(A4,s)],bass:[n(E3,e),n(E3,e)]},
    {treble:[n(C5,s),n(B4,s),n(A4,s),n(G4,s),n(C5,s),n(B4,s),n(A4,s),n(G4,s)],bass:[n(E3,e),n(E3,e)]},
    {treble:[n(D5,s),n(C5,s),n(B4,s),n(A4,s),n(B4,s),n(A4,s),n(G4,s),n(A4,s)],bass:[n(A2,e),n(A2,e)]},
    {treble:[n(B4,q),n(A4,q)],bass:[n(E3,q),n(E3,q)]},
  ], 24)},
};

void ensureFontLoaded().then(() => {
  const root = document.getElementById('root')!;

  // 控制条
  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  root.appendChild(bar);

  // 谱面容器(占满除控制条外的空间)
  const host = document.createElement('div');
  host.style.cssText = 'width:100%;height:calc(100vh - 48px)';
  root.appendChild(host);

  let currentSong = 'twinkle';
  let currentMode: ScoreMode = 'staff';
  let currentDensity = 'compact';

  const sheet = buildScoreSheet(
    { score: songs[currentSong], mode: currentMode, density: currentDensity },
    {
      onSeek: (beat) => { console.log('seek beat', beat); },
      onLineLayout: (info) => { /* 瀑布流组件用,此处空 */ void info; },
    },
  );
  host.appendChild(sheet.el);

  // 分组按钮工厂
  const mkGroup = (label: string) => {
    const g = document.createElement('div');
    g.className = 'demo-btn-group';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.className = 'demo-btn-label';
    g.appendChild(lbl);
    return g;
  };
  const mkBtn = (text: string, active: boolean, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = 'demo-btn' + (active ? ' active' : '');
    b.onclick = () => {
      onClick();
      [...b.parentElement!.querySelectorAll('.demo-btn')].forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    };
    return b;
  };

  // 曲子选择
  const songGroup = mkGroup('曲目');
  for (const k of Object.keys(songs)) {
    songGroup.appendChild(mkBtn(songs[k].meta.title, k === currentSong, () => {
      currentSong = k;
      sheet.setScore(songs[k]);
    }));
  }
  bar.appendChild(songGroup);

  // 模式选择
  const modeGroup = mkGroup('视图');
  const modeLabels: Record<ScoreMode, string> = { staff: '五线谱', jianpu: '简谱', both: '对照' };
  for (const m of ['staff', 'jianpu', 'both'] as ScoreMode[]) {
    modeGroup.appendChild(mkBtn(modeLabels[m], m === currentMode, () => {
      currentMode = m;
      sheet.setMode(m);
    }));
  }
  bar.appendChild(modeGroup);

  // 密度选择
  const densGroup = mkGroup('密度');
  const densLabels: Record<string, string> = { compact: '紧密', normal: '正常', loose: '宽松' };
  for (const d of ['compact', 'normal', 'loose']) {
    densGroup.appendChild(mkBtn(densLabels[d], d === currentDensity, () => {
      currentDensity = d;
      sheet.setDensity(d);
    }));
  }
  bar.appendChild(densGroup);

  // 播放控制:单一定时器,不使用 mkBtn(避免其 active 切换副作用)。
  // 节奏用真实 BPM:小星星/欢乐颂 ♩=100,土耳其 ♩=120(16分音符能看清逐个移动)。
  // 步进用 16 分粒度(beat += 0.25),让土耳其的 16 分音符播放头逐个跳到每个符头。
  const BPM_BY_SONG: Record<string, number> = { twinkle: 100, ode: 100, turkish: 120 };
  const playGroup = mkGroup('播放');
  let playing = false;
  let beat = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const playBtn = document.createElement('button');
  playBtn.className = 'demo-btn active';
  playBtn.textContent = '▶ 播放';
  const togglePlay = () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    if (timer) { clearInterval(timer); timer = null; }
    if (playing) {
      const bpm = BPM_BY_SONG[currentSong] ?? 100;
      // 16 分音符时长(ms)= 60000 / bpm / 4
      const stepMs = 60000 / bpm / 4;
      timer = setInterval(() => {
        beat += 0.25;
        const total = songs[currentSong].meta.totalMeasures * beatsPerBar(songs[currentSong].meta.time);
        if (beat > total) beat = 0;
        sheet.onTick(beat);
      }, stepMs);
    }
  };
  playBtn.onclick = togglePlay;
  playGroup.appendChild(playBtn);
  bar.appendChild(playGroup);

  // 调试钩子(控制台手动调):window.__sheet
  (window as any).__sheet = sheet;
});
