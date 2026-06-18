import './style.css';
import { App } from './ui/app';
import { ensureFontLoaded } from './render/glyphs';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

// 先声明字体（@font-face 已在 style.css）
void ensureFontLoaded();
new App(root);
