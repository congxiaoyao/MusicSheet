// ScoreSheet 演示入口 —— 练琴页谱面组件独立 demo。
// 不依赖主 app,内置三首曲子(小星星/欢乐颂/土耳其),支持切换 模式(staff/jianpu/both)、
// 密度(compact/normal/loose)、模拟播放(行滚动+符头高亮)。
// 访问: vite dev server 下 /score-sheet-demo.html

import '../style.css';
import { KEYS } from '../core/theory';
import { Score } from '../core/score';
import { Note } from '../core/types';
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

// ── 曲库 ──
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
      onSeek: (m) => { console.log('seek measure', m); },
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

  // 播放控制
  const playGroup = mkGroup('播放');
  let playing = false;
  let beat = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const playBtn = mkBtn('▶ 播放', false, () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    if (playing) {
      timer = setInterval(() => {
        beat += 0.5;
        const total = songs[currentSong].meta.totalMeasures * 4;
        if (beat > total) beat = 0;
        sheet.onTick(beat);
      }, 500);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  // 播放按钮不参与 active 切换,单独处理
  playBtn.classList.add('active');
  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    if (playing) {
      timer = setInterval(() => {
        beat += 0.5;
        const total = songs[currentSong].meta.totalMeasures * 4;
        if (beat > total) beat = 0;
        sheet.onTick(beat);
      }, 500);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  playGroup.appendChild(playBtn);
  bar.appendChild(playGroup);
});
