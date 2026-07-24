import assert from 'node:assert/strict';
import { buildSceneRanges, parseSceneCutTimes } from '../lib/final-edit/scene-detect.ts';

const stdout = 'frame:12 pts:12000 pts_time:1.25\nlavfi.scene_score=0.44\n';
const stderr = 'frame:44 pts:44000 pts_time:4.50\nlavfi.scene_score=0.51\n';
assert.deepEqual(parseSceneCutTimes(stdout, stderr), [1_250_000, 4_500_000], '必须同时解析 stdout 与 stderr');
assert.deepEqual(parseSceneCutTimes('pts_time:0.05\npts_time:1.00', 'pts_time:1.00'), [1_000_000], '忽略开头噪声并去重');

assert.deepEqual(buildSceneRanges(5_000_000, [100_000, 1_000_000, 1_150_000, 3_000_000], 300_000), [
  { startUs: 0, endUs: 1_000_000 },
  { startUs: 1_000_000, endUs: 3_000_000 },
  { startUs: 3_000_000, endUs: 5_000_000 },
]);

console.log('final-edit scene detection tests passed');
