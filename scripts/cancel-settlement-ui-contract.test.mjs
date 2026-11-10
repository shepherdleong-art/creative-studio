import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');

const scene = read('components/workbench/SceneStep.tsx');
assert.match(scene, /已停止 · 已收尾/);
assert.match(scene, /停止后续生成/);
assert.match(scene, /晚到结果/);

const video = read('components/VideoGenerationResults.tsx');
assert.match(video, /已停止 · 结果已保留/);
assert.match(video, /cancelRequestedAt/);
assert.match(video, /晚到结果会保留/);

const canvas = read('components/creative-canvas/CanvasTaskDrawer.tsx');
assert.match(canvas, /结果已收尾/);
assert.match(canvas, /晚到结果已保留/);

const rework = read('components/mixcut/ReassembledReworkPanel.tsx');
assert.match(rework, /停止后续生成/);
assert.match(rework, /不会自动采用/);
assert.match(rework, /明确采用/);

console.log('cancel settlement UI contract passed');
