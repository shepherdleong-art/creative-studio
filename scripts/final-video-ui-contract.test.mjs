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
assert.match(panel, /\/api\/final-video-drafts\/\$\{draft\.id\}\/preview/);
assert.match(panel, /\/api\/final-video-drafts\/\$\{draft\.id\}\/render/);
assert.doesNotMatch(panel, /\/api\/projects\/\$\{projectId\}\/final-videos`\s*,\s*\{\s*method:\s*'POST'/);
assert.match(panel, /titleTouchedRef/);
assert.match(panel, /titleTouchedRef\.current\s*=\s*true/);
assert.match(panel, /previewRevision\s*===\s*draft\.revision/);
assert.match(panel, /previewJob\?\.draftRevision\s*===\s*draft\.revision/);
assert.match(panel, /草稿已更新/);
assert.match(panel, /不自动调用/);
assert.match(panel, /供应商/);
assert.match(panel, /bgm-only/);
assert.match(panel, /纯 BGM/);
assert.match(panel, /targetDurationSec/);
assert.match(panel, /selectedScriptTargetDurationSec/);
assert.match(panel, /script_image_stale/);
assert.match(panel, /planned_clip_substituted/);
assert.doesNotMatch(panel, /narrationScriptProviderId|visionProviderId|orchestrationProviderId/);
assert.doesNotMatch(panel, /识别画面|AI 编排/);
// 目标时长在口播模式下由脚本决定，表单不再暴露；但纯 BGM 模式没有口播，它是 solve-bgm-timeline
// 计算成片长度的唯一依据（contentDurationSec = targetDurationSec - introDurationSec），
// 必须留给用户直接控制 —— 所以这个输入框存在，且只在 bgm-only 时渲染。
assert.match(panel, /bgmTargetDurationSec/);
assert.match(panel, /mode === 'bgm-only' && <label[\s\S]{0,40}目标时长（秒）/);
assert.match(panel, /准备素材/);
assert.match(panel, /mode === 'narration'/);
assert.match(panel, /新建草稿/);
assert.match(panel, /bgmSelectionReady/);

// Lifecycle: a newly submitted final job must refresh the list until it reaches a terminal state.
assert.match(panel, /activeFinalJob/);
assert.match(panel, /jobs\.some\(\(job\)\s*=>\s*job\.status\s*===\s*'pending'\s*\|\|\s*job\.status\s*===\s*'running'/);
assert.match(panel, /setInterval\(\(\)\s*=>\s*\{\s*void loadJobs\(\);\s*}\s*,\s*2000\)/);
assert.match(panel, /kind === 'preview'[\s\S]*kind === 'render'/);
assert.match(panel, /JSON\.stringify\(\{ revision: current\.revision \}\)/);
assert.match(panel, /response\.status\s*===\s*409[\s\S]{0,240}reportConflict\(current\.id\)/);
assert.match(panel, /if\s*\(kind === 'render'\)\s*await loadJobs\(\)/);

assert.match(editor, /revision/);
assert.match(editor, /method:\s*'PATCH'/);
assert.match(editor, /response\.status\s*===\s*409/);
assert.match(editor, /草稿已更新/);
assert.match(editor, /fetch\(`\/api\/final-video-drafts\/\$\{draft\.id\}`\)/);
assert.match(editor, /ClipPicker/);
assert.match(editor, /NarrationTimeline/);
assert.match(editor, /视觉缺口/);
assert.match(editor, /交换画面|换片/);
assert.match(editor, /上移|下移/);
assert.match(editor, /mode === 'bgm-only'/);
assert.match(editor, /selectedClipIds/);
assert.match(editor, /目标时长/);

assert.match(picker, /缩略图|画面素材/);
assert.match(timeline, /beat\.text/);
assert.match(timeline, /durationSec/);

console.log('final-video-ui-contract tests passed');
