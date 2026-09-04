import assert from 'node:assert/strict';
import { splitBatchRenderTasks } from '../lib/batch-production/progress-summary.ts';

const groups = splitBatchRenderTasks([
  { id: 'cover-1', workType: 'render', targetKind: 'output_version_cover' },
  { id: 'full-1', workType: 'render', targetKind: 'output_version' },
  { id: 'narration-1', workType: 'narration', targetKind: 'script_snapshot' },
  { id: 'legacy-1', workType: 'render', targetKind: 'legacy_proxy_cache' },
] as const);

assert.deepEqual(groups.cover.map(({ id }) => id), ['cover-1'], '封面任务必须单独归类');
assert.deepEqual(groups.full.map(({ id }) => id), ['full-1'], '整片任务必须单独归类');

console.log('batch progress summary tests passed');
