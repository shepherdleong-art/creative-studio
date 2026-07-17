import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync('components/final-edit/FinalEditPanel.tsx', 'utf8');
const page = fs.readFileSync('app/projects/[id]/page.tsx', 'utf8');
const tabs = fs.readFileSync('components/ProjectWorkbenchTabs.tsx', 'utf8');
const settings = fs.readFileSync('app/settings/page.tsx', 'utf8');

assert.match(tabs, /'final-edit'/);
assert.match(tabs, /成片剪辑/);
assert.match(page, /<FinalEditPanel projectId=/);
assert.match(panel, /min-w-\[1240px\]/, '窄窗口必须保持桌面画布并横向滚动');
assert.match(panel, /grid-cols-\[440px_minmax\(420px,1fr\)_330px\]/, '编辑器必须保持素材池、预览、属性三栏');
assert.match(panel, /h-\[420px\].*grid-cols-2.*overflow-y-auto/, '素材池必须两列并在固定高度内部滚动');
assert.doesNotMatch(panel, /localStorage/, '标题预设和编辑状态不能以 localStorage 为正式权威');
assert.doesNotMatch(panel, /字幕列表/, '不得增加独立字幕列表');
assert.match(settings, /口播配音/);
assert.match(settings, /\/api\/providers\/tts/);

console.log('final-edit UI contract tests passed');
