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
assert.match(preparation, /分析全部待分析/);
assert.match(preparation, /assets\/analyze\?projectId=/);
assert.match(preparation, /workType === 'asset_prepare'/);
assert.match(preparation, /定位来源/);
assert.match(preparation, /探测媒体/);
assert.match(preparation, /关闭素材预览/);
assert.match(selectionCards, /thumbnailUrl/);
assert.match(selectionCards, /previewUrl/);
assert.match(selectionCards, /开始分析/);
assert.match(selectionCards, /基础分析可用/);
assert.match(selectionCards, /智能内容理解尚未启用/);
assert.match(selectionCards, /重试/);
assert.match(selectionCards, /缩略图暂不可用/);
assert.match(selectionCards, /冻结脚本快照/);
assert.match(selectionCards, /bodyText/);

console.log('batch preparation workspace contract tests passed');
