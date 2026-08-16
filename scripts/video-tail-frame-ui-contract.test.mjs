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
assert.match(results, /job\.tailImageId[\s\S]*首尾帧/, 'result cards must identify tail-frame jobs');

console.log('video tail-frame UI contract tests passed');
