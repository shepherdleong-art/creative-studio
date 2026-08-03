import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');
const bootstrap = fs.readFileSync('lib/batch-production/bootstrap.ts', 'utf8');
const startRoute = fs.readFileSync('app/api/batch-production/batches/[id]/start/route.ts', 'utf8');
const workspaceRoute = fs.readFileSync('app/api/batch-production/batches/[id]/workspace/route.ts', 'utf8');
const exportRoute = fs.readFileSync('app/api/batch-production/batches/[id]/exports/route.ts', 'utf8');
const exclusionRoute = fs.readFileSync('app/api/batch-production/batches/[id]/assets/[assetId]/exclusion/route.ts', 'utf8');

assert.match(panel, /Phase E · 联合分配与正式导出/);
assert.match(panel, /静音视觉候选/);
assert.match(panel, /正式导出选中项/);
assert.match(panel, /只重新分配这一条/);
assert.match(panel, /batch-output-preview-/);
assert.match(panel, /暂停批次/);
assert.match(panel, /继续批次/);
assert.match(panel, /重试渲染/);
assert.match(panel, /从后续分配排除/);
assert.match(panel, /恢复参与分配/);
assert.match(bootstrap, /batchRenderExecutor/);
assert.match(startRoute, /startOrResumePhaseE/);
assert.match(workspaceRoute, /getBatchWorkspace/);
assert.match(exportRoute, /publishSelectedBatchOutputs/);
assert.match(exclusionRoute, /updateBatchAssetExclusionAndSchedule/);

console.log('batch Phase E UI contract tests passed');
