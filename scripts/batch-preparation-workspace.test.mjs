import assert from 'node:assert/strict';
import fs from 'node:fs';

const projectPage = fs.readFileSync('app/projects/[id]/page.tsx', 'utf8');
const workspace = fs.readFileSync('components/mixcut/MixcutWorkspace.tsx', 'utf8');
const preparation = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');
const selectionCards = fs.readFileSync('components/batch-production/BatchInputSelectionCards.tsx', 'utf8');

assert.match(projectPage, /MixcutWorkspace/);
assert.match(workspace, /单条精准混剪/);
assert.match(workspace, /批量生产/);
assert.match(workspace, /BatchPreparationPanel/);
assert.match(preparation, /\/api\/batch-production\/readiness/);
assert.match(preparation, /\/api\/batch-production\/prepare\?projectId=/);
assert.match(preparation, /项目脚本/);
assert.match(preparation, /项目素材/);
assert.match(preparation, /重新同步/);
assert.match(preparation, /detail\.scriptSnapshots/);
assert.match(preparation, /inputState === 'frozen'/);
assert.match(preparation, /result\.inputState === 'frozen'/);
assert.match(selectionCards, /冻结脚本快照/);
assert.match(selectionCards, /bodyText/);

console.log('batch preparation workspace contract tests passed');
