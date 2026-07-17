import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync('components/final-edit/FinalEditPanel.tsx', 'utf8');
const editorCss = fs.readFileSync('components/final-edit/FinalEditEditor.module.css', 'utf8');
const assetPool = fs.readFileSync('components/final-edit/FinalEditAssetPool.tsx', 'utf8');
const preview = fs.readFileSync('components/final-edit/FinalEditPreview.tsx', 'utf8');
const inspector = fs.readFileSync('components/final-edit/FinalEditInspector.tsx', 'utf8');
const timeline = fs.readFileSync('components/final-edit/FinalEditTimeline.tsx', 'utf8');
const canvasGolden = fs.readFileSync('scripts/final-edit-canvas.playwright.test.mjs', 'utf8');
const page = fs.readFileSync('app/projects/[id]/page.tsx', 'utf8');
const tabs = fs.readFileSync('components/ProjectWorkbenchTabs.tsx', 'utf8');
const settings = fs.readFileSync('app/settings/page.tsx', 'utf8');

assert.match(tabs, /'final-edit'/);
assert.match(tabs, /成片剪辑/);
assert.match(page, /<FinalEditPanel projectId=/);
assert.match(editorCss, /min-width:\s*1240px/, '窄窗口必须保持桌面画布并横向滚动');
assert.match(editorCss, /grid-template-columns:\s*440px minmax\(440px,1fr\) 360px/, '编辑器必须保持素材池、预览、属性三栏');
assert.match(editorCss, /\.assetGrid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s, '素材池必须为两列');
assert.match(editorCss, /\.assetScroller\s*\{[^}]*overflow-y:\s*auto/s, '素材池必须在固定区域内部滚动');
assert.match(panel, /生成设置.*成片组.*单条编辑/s, '正式界面必须保留三段工作流');
assert.match(assetPool, /thumbnailUrl/, '素材卡必须使用稳定静态缩略图');
assert.doesNotMatch(assetPool, /<video/, '素材池不得为每张卡创建视频解码器');
assert.match(preview, /new AudioContext\(\)/, '预览必须使用 AudioContext 作为主时钟');
assert.match(preview, /videoARef/);
assert.match(preview, /videoBRef/, '预览必须保留双 video 预加载槽');
assert.match(inspector, /role="tablist"/);
assert.match(inspector, /mode === 'subtitle'.*mode === 'cover'.*mode === 'framing'.*mode === 'audio'/s, '属性栏同一时刻只能显示当前编辑模式');
assert.match(timeline, /application\/x-final-edit-asset/, '素材必须可拖入视频轨');
assert.match(timeline, /onTrimCue/, '字幕两侧把手必须调用修剪命令');
assert.match(canvasGolden, /chromium\.launch/);
assert.match(canvasGolden, /previewMatchesBundle/, 'UI 门禁必须包含真实 Chromium Canvas 与 bundle 像素一致性验证');
assert.doesNotMatch(panel, /localStorage/, '标题预设和编辑状态不能以 localStorage 为正式权威');
assert.doesNotMatch(panel, /字幕列表/, '不得增加独立字幕列表');
assert.match(settings, /口播配音/);
assert.match(settings, /\/api\/providers\/tts/);

console.log('final-edit UI contract tests passed');
