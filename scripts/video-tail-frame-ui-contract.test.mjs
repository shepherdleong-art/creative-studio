import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync('components/VideoGenerationPanel.tsx', 'utf8');
const results = fs.readFileSync('components/VideoGenerationResults.tsx', 'utf8');

assert.match(panel, /usage', 'video_tail_frame'/, 'tail upload must use the dedicated asset usage');
assert.match(panel, /tailImageId: r\.tailImageId/, 'batch request must include each row tailImageId');
assert.match(panel, /handleTailFrameUpload\(selectedShot, row\.key, file\)/, 'async upload must target row.key');
assert.match(panel, /releaseDraftTailFrameAssets/, 'unsubmitted tail assets must be released on reset/unmount');
assert.match(panel, /pendingCreationTailIdsRef/, 'tail assets in an active create request must be protected from draft cleanup');
assert.match(panel, /if \(creatingRef\.current\) return/, 'draft ownership changes must be blocked during creation');
assert.match(panel, /getVideoMotionRowIssue/, 'incompatible or incomplete tail rows must block creation');
assert.match(panel, /data-testid="video-frame-pair"/, 'tail-frame UI must present first and tail frames as a visual pair');
assert.match(panel, /className="video-frame-bridge"/, 'the visual pair must include a clear first-to-tail relationship marker');
assert.match(panel, /添加尾帧图/, 'the empty tail tile must expose an in-context upload affordance');
assert.doesNotMatch(panel, /className="flex h-14 cursor-pointer/, 'the old compact tail-frame upload strip must not return');
assert.match(results, /job\.tailImageId[\s\S]*首尾帧/, 'result cards must identify tail-frame jobs');

console.log('video tail-frame UI contract tests passed');
