import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync('components/VideoGenerationPanel.tsx', 'utf8');
const results = fs.readFileSync('components/VideoGenerationResults.tsx', 'utf8');

assert.match(panel, /usage', 'video_tail_frame'/, 'tail upload must use the dedicated asset usage');
assert.match(panel, /\.\.\.serializeVideoGenerationFields\(r\)/, 'single-shot request must serialize mode, tail and ordered references together');
assert.match(panel, /handleTailFrameUpload\(selectedShot, row\.key, file\)/, 'async upload must target row.key');
assert.match(panel, /releaseDraftTailFrameAssets/, 'unsubmitted tail assets must be released on reset/unmount');
assert.match(panel, /pendingCreationTailIdsRef/, 'tail assets in an active create request must be protected from draft cleanup');
assert.match(panel, /if \(creatingRef\.current\) return/, 'draft ownership changes must be blocked during creation');
assert.match(panel, /getVideoMotionRowIssue/, 'incompatible or incomplete tail rows must block creation');
assert.match(panel, /data-testid="video-frame-pair"/, 'tail-frame UI must present first and tail frames as a visual pair');
assert.match(panel, /className="video-frame-bridge"/, 'the visual pair must include a clear first-to-tail relationship marker');
assert.match(panel, /添加尾帧图/, 'the empty tail tile must expose an in-context upload affordance');
assert.match(panel, /event\.dataTransfer\.files/, 'the tail tile must accept files from a native drag-and-drop event');
assert.match(panel, /onDrop:[\s\S]*handleTailFrameDrop/, 'empty and loaded tail tiles must wire the drop handler');
assert.match(panel, /松开添加尾帧/, 'dragging over an empty tail tile must show an explicit drop state');
assert.match(panel, /松开替换尾帧/, 'dragging over a loaded tail tile must show an explicit replace state');
assert.match(panel, /<HoverZoomImage[\s\S]*alt="尾帧预览"/, 'loaded tail frames must share the first-frame hover zoom interaction');
assert.doesNotMatch(panel, /className="flex h-14 cursor-pointer/, 'the old compact tail-frame upload strip must not return');
assert.match(results, /job\.tailImageId[\s\S]*首尾帧/, 'result cards must identify tail-frame jobs');

assert.match(panel, /generationMode === 'image-to-video' && \([\s\S]*data-testid="video-frame-pair"/, 'the existing first/tail-frame editor must remain in image-to-video mode');
assert.match(panel, /generationMode === 'reference-to-video' && \([\s\S]*data-testid="video-reference-editor"/, 'reference mode replaces the frame editor');
assert.match(panel, /const deleteReferenceAsset[\s\S]*response\.status !== 404 && response\.status !== 409/, 'reference delete must detach drafts on missing or job-protected assets');
assert.match(panel, /releaseDraftReferenceAssets/, 'unsubmitted references must be released on reset/unmount');
assert.match(panel, /pendingCreationReferenceIdsRef/, 'references in an active create request must be protected from draft cleanup');
assert.match(panel, /referenceDeletionIdsRef/, 'in-flight reference deletion must not be duplicated by draft cleanup');
assert.match(panel, /\.\.\.serializeVideoGenerationFields\(row\)/, 'bulk request must use the same mode and ordered-reference serializer');
assert.doesNotMatch(panel, /from ['"]@\/lib\/video-job-create/, 'browser draft code must not import the server creation module');


assert.doesNotMatch(panel, /aria-label="生成模式"/, 'Modes are selected automatically by model');
assert.match(panel, /getRowSelection\(row\)\.generationMode/);
assert.match(panel, /video-reference-editor/);
assert.match(panel, /使用当前分镜图/);
assert.match(panel, /src=\{selectedShotData\.imageUrl\}/);
assert.doesNotMatch(panel, /handleReferenceUpload|添加参考素材|参考素材上移|参考素材下移/);

assert.match(panel, /全能参考 · 当前分镜图/);
console.log('video tail-frame and reference UI contract tests passed');
