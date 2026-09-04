import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gallery = readFileSync(new URL('../components/ResultGallery.tsx', import.meta.url), 'utf8');

const viewerHeaderStart = gallery.indexOf('Viewer header bar');
const viewerHeaderEnd = gallery.indexOf('Arrow overlays');
assert.ok(viewerHeaderStart >= 0 && viewerHeaderEnd > viewerHeaderStart, '结果查看器标题区域必须存在');
const viewerHeader = gallery.slice(viewerHeaderStart, viewerHeaderEnd);
assert.match(viewerHeader, /getImageJobDisplayName\(selectedJob\)/, '结果标题必须优先显示产出文件名');
assert.doesNotMatch(viewerHeader, /\{selectedJob\.inputFilename\}/, '结果标题不得直接显示输入文件名');

const gridStart = gallery.indexOf('displayedJobs.map((job) =>');
const gridEnd = gallery.indexOf('/* ── Viewer', gridStart);
assert.ok(gridStart >= 0 && gridEnd > gridStart, '结果卡片区域必须存在');
const grid = gallery.slice(gridStart, gridEnd);
assert.match(grid, /getImageJobDisplayName\(job\)/, '结果卡片必须复用统一的图片任务展示名');

assert.match(gallery, /getGptImage2AspectRatio\(job\.size\)/, '生成上下文必须展示任务画幅');
assert.match(gallery, /画幅/, '生成上下文必须包含画幅文案');

console.log('image-generation-ui contract tests passed');
