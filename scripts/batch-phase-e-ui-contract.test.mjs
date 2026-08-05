import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');
const materials = fs.readFileSync('components/batch-production/BatchStepMaterials.tsx', 'utf8');
const review = fs.readFileSync('components/batch-production/BatchStepReview.tsx', 'utf8');
const exportStep = fs.readFileSync('components/batch-production/BatchStepExport.tsx', 'utf8');
const bootstrap = fs.readFileSync('lib/batch-production/bootstrap.ts', 'utf8');
const startRoute = fs.readFileSync('app/api/batch-production/batches/[id]/start/route.ts', 'utf8');
const workspaceRoute = fs.readFileSync('app/api/batch-production/batches/[id]/workspace/route.ts', 'utf8');
const exportRoute = fs.readFileSync('app/api/batch-production/batches/[id]/exports/route.ts', 'utf8');
const exclusionRoute = fs.readFileSync('app/api/batch-production/batches/[id]/assets/[assetId]/exclusion/route.ts', 'utf8');

// 界面不得出现研发术语(Phase/联合分配/代理 等)与内部状态值
for (const source of [panel, materials, review, exportStep]) {
  assert.doesNotMatch(source, /Phase [A-Z]/);
  assert.doesNotMatch(source, /联合分配/);
}
// 渲染闸门(问题 3-A/B)生效后不再产出静音样片,界面不得再出现相关文案;
// 检查页提供「重试配音」与常驻「重新生成」入口。
assert.doesNotMatch(review, /无配音样片/);
assert.doesNotMatch(review, /重新渲染（带配音）/);
assert.match(review, /重新生成/);
assert.match(review, /重试配音/);
assert.doesNotMatch(panel, /静音视觉候选/);
assert.doesNotMatch(exportStep, /productionReady/);
assert.match(exportStep, /正式导出选中项/);
assert.match(review, /换一批画面/);
assert.match(review, /batch-output-preview-/);
assert.match(review, /暂停批次/);
assert.match(review, /继续批次/);
assert.match(materials, /从后续分配排除/);
assert.match(materials, /恢复参与分配/);
assert.match(bootstrap, /batchRenderExecutor/);
assert.match(bootstrap, /batchNarrationExecutor/);
assert.match(startRoute, /startOrResumePhaseE/);
assert.match(workspaceRoute, /getBatchWorkspace/);
assert.match(exportRoute, /publishSelectedBatchOutputs/);
assert.match(exclusionRoute, /updateBatchAssetExclusionAndSchedule/);

console.log('batch Phase E UI contract tests passed');
