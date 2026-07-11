import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const panel = read('components/FinalVideoPanel.tsx');
const editor = read('components/final-video/ArrangementEditor.tsx');
const picker = read('components/final-video/ClipPicker.tsx');
const timeline = read('components/final-video/NarrationTimeline.tsx');

assert.match(panel, /ArrangementEditor/);
assert.match(panel, /\/api\/projects\/\$\{projectId\}\/final-video-drafts/);
assert.match(panel, /\/api\/final-video-drafts\/\$\{draft\.id\}\/prepare/);
assert.match(panel, /\/api\/final-video-drafts\/\$\{draft\.id\}\/describe/);
assert.match(panel, /\/api\/final-video-drafts\/\$\{draft\.id\}\/arrange/);
assert.match(panel, /\/api\/final-video-drafts\/\$\{draft\.id\}\/preview/);
assert.match(panel, /\/api\/final-video-drafts\/\$\{draft\.id\}\/render/);
assert.doesNotMatch(panel, /\/api\/projects\/\$\{projectId\}\/final-videos`\s*,\s*\{\s*method:\s*'POST'/);
assert.match(panel, /titleTouchedRef/);
assert.match(panel, /previewRevision\s*===\s*draft\.revision/);
assert.match(panel, /草稿已更新/);
assert.match(panel, /不自动调用/);
assert.match(panel, /供应商/);

assert.match(editor, /revision/);
assert.match(editor, /method:\s*'PATCH'/);
assert.match(editor, /response\.status\s*===\s*409/);
assert.match(editor, /草稿已更新/);
assert.match(editor, /ClipPicker/);
assert.match(editor, /NarrationTimeline/);
assert.match(editor, /视觉缺口/);
assert.match(editor, /交换画面|换片/);
assert.match(editor, /上移|下移/);

assert.match(picker, /缩略图|画面素材/);
assert.match(timeline, /beat\.text/);
assert.match(timeline, /durationSec/);

console.log('final-video-ui-contract tests passed');
