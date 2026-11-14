import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ExecutionJournal, ExecutionRuntime, OperationRecord } from '../lib/media-core/execution/context.ts';
import {
  TASK_SEARCH_DEBOUNCE_MS,
  groupPageByActor,
  groupTeamTaskRows,
  memberOptionsFromUsers,
  readTaskListResponse,
  taskListRequestPath,
  taskPageAfterChange,
  taskTotalSummary,
} from '../components/team/task-panel-state.ts';

// ── 06 号票：全员任务页的纯展示/状态逻辑（不依赖 React 与数据库） ──────────────
// 这些规则决定「服务端分页怎么请求、总数怎么写、分组是否只作用于当前页、筛选变化回第 1 页」，
// 页面组件带 React/Next 无法被 Node 直接 import，所以逻辑放在 components/team/task-panel-state.ts。
assert.equal(TASK_SEARCH_DEBOUNCE_MS, 300, '搜索输入防抖必须是约 300ms');
assert.equal(taskTotalSummary(503, 505), '共 503 个制作任务，505 条执行记录', '总数文案读分页元数据，不是当前页数组长度');
assert.equal(taskTotalSummary(0, 0), '共 0 个制作任务，0 条执行记录');
assert.equal(
  taskListRequestPath({ q: ' 张三 ', status: 'failed', actorUserId: 'alice', page: 2, pageSize: 50 }),
  '/api/team/tasks?q=%E5%BC%A0%E4%B8%89&status=failed&actorUserId=alice&page=2&pageSize=50',
  '关键词/状态/成员走服务端参数，分页参数永远携带',
);
assert.equal(
  taskListRequestPath({ q: '', status: '', actorUserId: '', page: 1, pageSize: 25 }),
  '/api/team/tasks?page=1&pageSize=25',
  '空筛选不发送空参数',
);
assert.equal(taskPageAfterChange(4, { kind: 'page', page: 9 }), 9, '翻页只改页码');
assert.equal(taskPageAfterChange(4, { kind: 'filter' }), 1, '搜索/成员/状态变化回第 1 页');
assert.equal(taskPageAfterChange(4, { kind: 'pageSize' }), 1, '每页条数变化回第 1 页');
assert.equal(taskPageAfterChange(4, { kind: 'refresh' }), 4, '手动刷新保留当前页');

const pageRows = [
  { operationId: 'op-unified-1', unifiedTaskId: 'media-task-1', actorUserId: 'user-zhang', employeeId: '0001', actorDisplayName: '张三' },
  { operationId: 'op-unified-2', unifiedTaskId: 'media-task-1', actorUserId: 'user-zhang', employeeId: '0001', actorDisplayName: '张三' },
  { operationId: 'op-unified-3', unifiedTaskId: 'media-task-1', actorUserId: 'user-zhang', employeeId: '0001', actorDisplayName: '张三' },
  { operationId: 'op-single', unifiedTaskId: null, actorUserId: 'admin-user', employeeId: '0000', actorDisplayName: '管理员' },
];
const pageGroups = groupTeamTaskRows(pageRows);
assert.equal(pageGroups.length, 2, '同一制作任务的 3 条执行记录只展示为一个制作任务');
assert.equal(pageGroups[0]?.key, 'unified:media-task-1');
assert.equal(pageGroups[0]?.items.length, 3);
assert.equal(pageGroups[0]?.representative.operationId, 'op-unified-1');
assert.equal(pageGroups[1]?.key, 'operation:op-single');
const pageByActor = groupPageByActor(pageGroups);
assert.deepEqual(
  pageByActor.map((group) => [group.actorUserId, group.groups.length]),
  [['user-zhang', 1], ['admin-user', 1]],
  '按发起人分组只重排当前页的制作任务',
);
assert.equal(pageByActor.reduce((sum, group) => sum + group.groups.length, 0), pageGroups.length, '分组/平铺看到同一批制作任务');
assert.equal(pageByActor[0]?.displayName, '张三');

const memberOptions = memberOptionsFromUsers([
  { id: 'user-li', employeeId: '0002', displayName: '李四', status: 'active' },
  { id: 'user-zhang', employeeId: '0001', displayName: '张三', status: 'disabled' },
  { id: 'user-zhang', employeeId: '0001', displayName: '张三', status: 'disabled' },
  { id: '', employeeId: '', displayName: '' },
]);
assert.deepEqual(
  memberOptions.map((option) => [option.employeeId, option.displayName]),
  [['0001', '张三'], ['0002', '李四']],
  '成员选项来自完整用户数据，含停用成员，不靠当前页去重',
);

const clampedPage = readTaskListResponse<typeof pageRows[number]>(
  {
    items: pageRows,
    pagination: { page: 21, pageSize: 25, total: 503, totalPages: 21 },
    totalRecords: 505,
  },
);
assert.equal(clampedPage.pagination.page, 21, '越界页按服务端实际 page 收敛，不在前端自己夹取');
assert.equal(clampedPage.pagination.total, 503);
assert.equal(clampedPage.totalRecords, 505);
assert.equal(clampedPage.items.length, pageRows.length);
assert.throws(
  () => readTaskListResponse({ items: [] }),
  /分页/,
  '响应缺少分页元数据必须报错，不能伪装成 0 条',
);
assert.throws(
  () => readTaskListResponse({ items: [], pagination: { page: 0, pageSize: 25, total: 0, totalPages: 1 }, totalRecords: 0 }),
  /分页/,
  '非法页码不能被当成有效响应',
);
console.log('PASS: task page request path, total copy, current-page grouping and page-reset rules');

// 公共任务查询接缝：真实 SQLite 与 execution facade，不访问任何供应商。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-task-display-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { listTeamTasks, findTeamTask, listRecentTeamTasks, listTeamTaskRecords, readTeamTaskActivity } = await import('../lib/team-service/tasks.ts');

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT, inputImageId TEXT, model TEXT, usageSnapshotJson TEXT);
  CREATE TABLE video_jobs (id TEXT PRIMARY KEY, status TEXT, sourceImageId TEXT, model TEXT, usageSnapshotJson TEXT);
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, filename TEXT, usage TEXT);
  CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL, type TEXT NOT NULL);
  CREATE TABLE video_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, defaultModel TEXT NOT NULL, type TEXT NOT NULL);
  CREATE TABLE script_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL);
  CREATE TABLE creative_canvases (id TEXT PRIMARY KEY, name TEXT NOT NULL);
`);
const timestamp = '2026-11-06T04:00:00.000Z';
for (const [id, employeeId, displayName, role] of [
  ['admin', '0000', '管理员', 'admin'], ['alice', '0001', '张三', 'employee'], ['bob', '0002', '李四', 'employee'],
] as const) {
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'active', 'not-used', 0, 1, ?, ?)`).run(id, employeeId, displayName, role, timestamp, timestamp);
  updateActorPolicy(db, { actorId: id, monthlyLimitMinor: null, personalConcurrency: 5, paused: false, expectedVersion: 0 });
}
db.prepare("INSERT INTO projects VALUES ('project-a', '洁面乳详情页')").run();
db.prepare("INSERT INTO script_providers VALUES ('text-provider', '当前脚本供应商', 'new-current-model')").run();
upsertExecutionPool(db, { poolKey: 'llm:remote', kind: 'remote', capacity: 5, enabled: true, mappingSnapshot: { providerId: 'text-provider' }, expectedVersion: 0 });
const identity = { instanceId: 'task-display-test', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'task-display-test' });
const journal: ExecutionJournal = {
  verify: () => ({ valid: true, records: [] }), scan: () => [],
  appendIntent: (input) => ({ ...input, schemaVersion: 1, deploymentId: 'task-display-test', eventType: 'submit_intent', seq: 1, prevHash: null, hash: 'intent', at: timestamp }),
  appendReceipt: (input) => ({ ...input, schemaVersion: 1, deploymentId: 'task-display-test', eventType: 'receipt', seq: 2, prevHash: null, hash: 'receipt', at: timestamp }),
};
const runtime: ExecutionRuntime = createExecutionFacade({
  db, deploymentId: 'task-display-test', journal, serverReleaseId: 'release-test',
  actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false,
  newId: (() => { let sequence = 0; return () => `id-${++sequence}`; })(),
});
await runtime.lifecycle.start({ ...identity, deploymentId: 'task-display-test', signal: new AbortController().signal });

function enqueue(input: {
  taskId: string; module?: string; step?: string; providerSnapshot: unknown; inputSnapshot?: unknown;
  status?: 'pending'; actorUserId?: string; scopeId?: string; scopeType?: 'project' | 'canvas' | 'shot_set' | 'canvas_task';
  inputRevision?: string; mediaTaskId?: string; channelKey?: string;
}): OperationRecord {
  const moduleName = input.module ?? 'llm';
  const step = input.step ?? 'script-studio-generate:plan:1:generate:1';
  const inputRevision = input.inputRevision ?? 'r1';
  return runtime.facade.enqueue({
    operationKey: `${moduleName}/${input.taskId}/${step}/${inputRevision}`, actor: { userId: input.actorUserId ?? 'alice' },
    scope: { resourceType: input.scopeType ?? 'project', resourceId: input.scopeId ?? 'project-a' }, module: moduleName, taskId: input.taskId, step,
    inputRevision, businessAttempt: { id: `${input.taskId}-business`, number: 1 },
    inputSnapshot: input.inputSnapshot ?? {}, inputHash: `hash-${input.taskId}-${step}`, continuationKey: 'test',
    providerSnapshot: input.providerSnapshot, configVersion: 'frozen-config', clientVersion: '0.7.1', requiredPools: ['llm:remote'],
    mediaTaskId: input.mediaTaskId, channelKey: input.channelKey,
    quote: { kind: 'unpriced' },
  }).operation;
}

async function send(operation: OperationRecord): Promise<string> {
  const admitted = runtime.facade.admit({ ...identity, operationId: operation.id });
  assert.equal(admitted.kind, 'admitted');
  if (admitted.kind !== 'admitted') throw new Error('expected admitted grant');
  const intent = await runtime.facade.markSubmitting({ grant: admitted.grant, requestSnapshot: { safe: true } });
  await runtime.facade.transmit(intent, async () => ({ terminalState: 'succeeded', actualCost: null }));
  await runtime.facade.settle({ attemptId: intent.attemptId, outcome: 'succeeded', actualCost: null, remoteTerminal: true });
  return intent.attemptId;
}

try {
  const operation = enqueue({
    taskId: 'script-history', providerSnapshot: {
      id: 'text-provider', name: '执行时脚本供应商', type: 'openai-compatible', model: 'old-default-model', apiKey: 'must-not-leak', baseUrl: 'https://secret.example.test',
    },
    inputSnapshot: { request: { model: 'history-text-model', userPrompt: '脚本正文不得进入任务接口' } },
  });
  const attemptId = await send(operation);
  db.prepare("UPDATE script_providers SET name = '修改后的供应商', model = 'new-current-model' WHERE id = 'text-provider'").run();

  const adminItems = listTeamTasks(db, { userId: 'admin', role: 'admin' }).items;
  const item = adminItems.find(candidate => candidate.taskId === 'script-history');
  assert.ok(item);
  assert.equal(item.model, 'history-text-model', '实际请求模型来自执行时快照，不读修改后的默认模型');
  assert.equal(item.providerName, '执行时脚本供应商');
  assert.equal(item.stepName, '第 1 条文案 · 生成');
  assert.equal(item.scopeName, '洁面乳详情页');
  assert.equal(item.modelStatus, 'recorded');
  assert.equal(item.modelCalls.length, 1);
  assert.equal(item.modelCalls[0]?.model, 'history-text-model');
  assert.equal(item.modelCalls[0]?.submissionState, 'terminal');
  assert.equal(item.modelCalls[0]?.attemptId, attemptId);
  const serialized = JSON.stringify(item);
  for (const forbidden of ['must-not-leak', 'secret.example.test', '脚本正文不得进入任务接口', 'providerSnapshot', 'inputSnapshot', 'apiKey', 'baseUrl']) {
    assert.equal(serialized.includes(forbidden), false, `任务投影不得返回 ${forbidden}`);
  }
  console.log('PASS: team task history uses the actual frozen script model and safe Chinese labels');

  enqueue({ taskId: 'script-waiting', providerSnapshot: { name: '排队脚本供应商', requestModel: 'waiting-model' } });
  enqueue({ taskId: 'script-missing', providerSnapshot: {} });
  enqueue({ taskId: 'local-render', module: 'final_edit', step: 'render', providerSnapshot: {} });
  const waiting = listTeamTasks(db, { userId: 'alice', role: 'employee' }).items.find(candidate => candidate.taskId === 'script-waiting');
  const missing = listTeamTasks(db, { userId: 'alice', role: 'employee' }).items.find(candidate => candidate.taskId === 'script-missing');
  const local = listTeamTasks(db, { userId: 'alice', role: 'employee' }).items.find(candidate => candidate.taskId === 'local-render');
  assert.ok(waiting && missing && local);
  assert.equal(waiting.model, 'waiting-model');
  assert.equal(waiting.modelStatus, 'pending');
  assert.equal(waiting.submissionCount, 0);
  assert.equal(waiting.modelCalls[0]?.submissionState, 'not_sent');
  assert.equal(missing.model, null);
  assert.equal(missing.modelStatus, 'missing');
  assert.equal(local.model, null);
  assert.equal(local.modelStatus, 'not_applicable');
  assert.equal(local.providerName, '不适用（本地处理）');
  assert.equal(listTeamTasks(db, { userId: 'bob', role: 'employee' }).items.length, 0);
  assert.throws(() => listTeamTasks(db, { userId: 'bob', role: 'employee' }, { actorUserId: 'alice' }), (error: unknown) => (error as { status?: number }).status === 403);
  console.log('PASS: waiting, missing and local-only models stay truthful and employee queries stay scoped');

  db.prepare("INSERT INTO providers VALUES ('image-provider', '修改后的图片供应商', 'changed-image-model', 'openai-compatible')").run();
  db.prepare("INSERT INTO video_providers VALUES ('video-provider', '修改后的视频供应商', 'changed-video-model', 'openai-video')").run();
  db.prepare("INSERT INTO image_assets VALUES ('input-image', '产品原图.png', 'shot_source')").run();
  const imageUsage = JSON.stringify({ provider: { providerId: 'image-provider', providerName: '执行时图片供应商', requestModel: 'image-history-model' } });
  const videoUsage = JSON.stringify({ provider: { providerId: 'video-provider', providerName: '执行时视频供应商', requestModel: 'video-history-model' } });
  db.prepare("INSERT INTO jobs VALUES ('image-history', 'succeeded', 'input-image', 'image-history-model', ?)").run(imageUsage);
  db.prepare("INSERT INTO video_jobs VALUES ('video-history', 'succeeded', 'input-image', 'video-history-model', ?)").run(videoUsage);
  db.prepare("INSERT INTO creative_canvases VALUES ('canvas-a', '夏季新品画布')").run();
  const imageOperation = enqueue({ taskId: 'image-history', module: 'image', step: 'submit', providerSnapshot: { providerId: 'image-provider', type: 'openai-compatible', model: 'image-history-model', baseUrl: 'https://image-secret.test' } });
  const videoOperation = enqueue({ taskId: 'video-history', module: 'video', step: 'submit', providerSnapshot: { providerId: 'video-provider', type: 'openai-video', model: 'video-history-model' } });
  const canvasOperation = enqueue({ taskId: 'canvas-history', module: 'canvas', step: 'submit', scopeType: 'canvas', scopeId: 'canvas-a', providerSnapshot: { providerIdentity: 'creative-canvas-fixture', modelAlias: 'fixture/image-edit', providerName: '测试图片供应商' } });
  const ttsOperation = enqueue({ taskId: 'tts-history', module: 'tts', step: 'segment:segment-1:chunk:0', providerSnapshot: { providerName: '执行时配音供应商', requestModel: 'speech-history-model', providerId: 'tts-history' } });
  for (const operation of [imageOperation, videoOperation, canvasOperation, ttsOperation]) await send(operation);
  const displayed = listTeamTasks(db, { userId: 'admin', role: 'admin' }).items;
  const image = displayed.find(item => item.taskId === 'image-history');
  const video = displayed.find(item => item.taskId === 'video-history');
  const canvas = displayed.find(item => item.taskId === 'canvas-history');
  const tts = displayed.find(item => item.taskId === 'tts-history');
  assert.ok(image && video && canvas && tts);
  assert.equal(image.providerName, '执行时图片供应商');
  assert.equal(image.model, 'image-history-model');
  assert.equal(video.providerName, '执行时视频供应商');
  assert.equal(video.model, 'video-history-model');
  assert.equal(canvas.providerName, '测试图片供应商');
  assert.equal(canvas.model, 'fixture/image-edit');
  assert.equal(canvas.scopeName, '夏季新品画布');
  assert.equal(canvas.stepName, '生成请求');
  assert.equal(tts.providerName, '执行时配音供应商');
  assert.equal(tts.model, 'speech-history-model');
  console.log('PASS: image, video, canvas and speech retain frozen model facts');

  for (const [step, providerSnapshot] of [
    ['script-studio-generate:plan:2:generate:1', { name: '文本渠道', model: 'text-model-a' }],
    ['script-studio-generate:plan:2:polish:1', { name: '润色渠道', model: 'text-model-b' }],
    ['script-studio-generate:plan:2:title_repair:1', { name: '文本渠道', model: 'text-model-a' }],
    ['script-studio-generate:future-step-17', {}],
    ['segment:segment-1:chunk:0', { providerName: '配音渠道', requestModel: 'speech-model' }],
    ['transcription:http:1', { providerId: 'alignment', model: 'alignment-model' }],
  ] as const) {
    const moduleName = step.startsWith('segment:') ? 'tts' : step.startsWith('transcription:') ? 'alignment' : 'llm';
    const pending = enqueue({ taskId: `labels-${step}`, module: moduleName, step, providerSnapshot });
    await send(pending);
  }
  const labeled = listTeamTasks(db, { userId: 'alice', role: 'employee' }).items;
  const generated = labeled.find(item => item.step === 'script-studio-generate:plan:2:generate:1');
  const polished = labeled.find(item => item.step === 'script-studio-generate:plan:2:polish:1');
  const repaired = labeled.find(item => item.step === 'script-studio-generate:plan:2:title_repair:1');
  const unknown = labeled.find(item => item.step === 'script-studio-generate:future-step-17');
  const ttsLabel = labeled.find(item => item.step === 'segment:segment-1:chunk:0');
  const alignmentLabel = labeled.find(item => item.step === 'transcription:http:1');
  assert.ok(generated && polished && repaired && unknown && ttsLabel && alignmentLabel);
  assert.equal(generated.stepName, '第 2 条文案 · 生成');
  assert.equal(polished.stepName, '第 2 条文案 · 润色');
  assert.equal(polished.model, 'text-model-b');
  assert.equal(repaired.stepName, '第 2 条文案 · 标题修复');
  assert.equal(unknown.stepName, '文案生成');
  assert.equal(unknown.stepName.includes('17'), false);
  assert.equal(ttsLabel.stepName, '配音片段');
  assert.equal(alignmentLabel.stepName, '声音识别');
  console.log('PASS: known script steps are Chinese, unknown keys stay generic, and models follow each call');

  const retriedOperation = enqueue({ taskId: 'multi-model-retry', providerSnapshot: { name: '原调用渠道', model: 'model-before-retry' } });
  const retried = runtime.facade.admit({ ...identity, operationId: retriedOperation.id });
  assert.equal(retried.kind, 'admitted');
  if (retried.kind !== 'admitted') throw new Error('expected retry grant');
  const initial = await runtime.facade.markSubmitting({ grant: retried.grant, requestSnapshot: { model: 'model-before-retry' } });
  await runtime.facade.transmit(initial, async () => ({ terminalState: 'failed', actualCost: { currency: 'CNY', minor: 0 } }));
  await runtime.facade.settle({ attemptId: initial.attemptId, outcome: 'failed', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: false });
  db.prepare('UPDATE execution_operations SET providerSnapshotJson = ? WHERE id = ?').run(JSON.stringify({ name: '替换调用渠道', model: 'model-after-retry' }), retriedOperation.id);
  const fallback = await runtime.facade.markSubmitting({ grant: retried.grant, requestSnapshot: { model: 'model-after-retry' }, retryKind: 'protocol_fallback', quote: { kind: 'unpriced' } });
  await runtime.facade.transmit(fallback, async () => ({ terminalState: 'succeeded', actualCost: { currency: 'CNY', minor: 0 } }));
  await runtime.facade.settle({ attemptId: fallback.attemptId, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: true });
  const multi = listTeamTasks(db, { userId: 'alice', role: 'employee' }).items.find(item => item.taskId === 'multi-model-retry');
  assert.ok(multi);
  assert.deepEqual(multi.modelCalls.map(call => call.model), ['model-before-retry', 'model-after-retry']);
  assert.equal(multi.modelStatus, 'multiple');
  assert.equal(multi.submissionCount, 2);
  assert.equal(multi.businessAttemptNo, 1);
  console.log('PASS: model-changing retries remain distinct attempts, not extra products or confirmed charges');

  const unknownOperation = enqueue({ taskId: 'unknown-operation', module: 'unknown_future_module', step: 'internal:47', providerSnapshot: {} });
  enqueue({ taskId: 'tts-retry', module: 'tts', step: 'segment:segment-9:chunk:0:request:2', providerSnapshot: { providerName: '配音渠道', requestModel: 'speech-model' } });
  await send(unknownOperation);
  const compat = listTeamTasks(db, { userId: 'alice', role: 'employee' }).items;
  assert.equal(compat.find(item => item.taskId === 'unknown-operation')?.taskName, '其他制作任务');
  assert.equal(compat.find(item => item.taskId === 'unknown-operation')?.stepName, '其他制作步骤');
  assert.equal(compat.find(item => item.taskId === 'unknown-operation')?.modelStatus, 'missing');
  assert.equal(compat.find(item => item.taskId === 'tts-retry')?.stepName, '配音片段');
  console.log('PASS: unknown future modules and media retry keys remain readable and truthful');

  const insertOld = db.prepare(`UPDATE execution_operations SET actorId = 'bob', taskId = 'older-bob-task', operationKey = 'llm/older-bob-task/submit/r1', updatedAt = '2020-01-01T00:00:00.000Z' WHERE id = ?`);
  insertOld.run(retriedOperation.id);
  const insertNewer = db.prepare(`INSERT INTO execution_operations (
    id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
    businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
    providerSnapshotJson, configVersion, clientVersion, serverReleaseId, requiredPoolsJson,
    quoteJson, status, readySeq, createdAt, updatedAt
  ) SELECT ?, ?, actorId, scopeType, scopeId, module, ?, step, inputRevision,
    ?, businessAttemptNo, ?, inputSnapshotJson, continuationKey,
    providerSnapshotJson, configVersion, clientVersion, serverReleaseId, requiredPoolsJson,
    quoteJson, status, ?, ?, ? FROM execution_operations WHERE id = ?`);
  const recent = enqueue({ taskId: 'recent-alice', providerSnapshot: { name: '近期供应商', model: 'recent-model' } });
  for (let index = 0; index < 510; index += 1) {
    const id = `recent-${index}`;
    const at = new Date(Date.UTC(2026, 10, 6, 5, 0, index)).toISOString();
    insertNewer.run(id, `llm/${id}/script-studio-generate:plan:1:generate:1/r1`, id, id, `hash-${id}`, 2000 + index, at, at, recent.id);
  }
  // 服务端分页（03 号票）：一页只返回该页制作任务组的执行记录，总数由 pagination 给出；
  // 旧任务不在第一页，但仍能按执行记录号直接打开（findTeamTask 不受分页/筛选限制）。
  const unfiltered = listTeamTasks(db, { userId: 'admin', role: 'admin' }, {}, { page: 1, pageSize: 50 });
  const totalOperations = Number(db.prepare('SELECT COUNT(*) FROM execution_operations').pluck().get());
  const filtered = listTeamTasks(db, { userId: 'admin', role: 'admin' }, { actorUserId: 'bob' }).items;
  assert.equal(unfiltered.items.length, 50, '管理员第一页只返回一页执行记录，不再是 500 条');
  assert.equal(unfiltered.pagination.total, totalOperations, '总数覆盖完整可见历史');
  assert.equal(unfiltered.pagination.totalPages, Math.ceil(totalOperations / 50));
  assert.equal(unfiltered.items.some(item => item.taskId === 'older-bob-task'), false, '2020 年的旧任务不在第一页');
  const oldTask = findTeamTask(db, { userId: 'admin', role: 'admin' }, retriedOperation.id);
  assert.equal(oldTask?.taskId, 'older-bob-task', '500 条之外的旧任务仍能按执行记录号读取');
  assert.deepEqual(oldTask?.modelCalls.map(call => call.model), ['model-before-retry', 'model-after-retry']);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.taskId, 'older-bob-task');
  assert.equal(filtered[0]?.model, '2 个模型（见调用记录）');
  assert.deepEqual(filtered[0]?.modelCalls.map(call => call.model), ['model-before-retry', 'model-after-retry']);
  console.log('PASS: member filtering happens before pagination, and old records stay readable by operation id');

  db.prepare("INSERT INTO image_assets VALUES ('input-retry', '重试原图.png', 'shot_source')").run();
  db.prepare("INSERT INTO jobs VALUES ('image-retry', 'succeeded', 'input-retry', 'image-retry-model', ?)").run(imageUsage);
  const legacyRetry = enqueue({ taskId: 'image-retry', module: 'image', step: 'submit', providerSnapshot: { providerId: 'image-provider', type: 'openai-compatible', model: 'image-retry-model' } });
  const retryGrant = runtime.facade.admit({ ...identity, operationId: legacyRetry.id });
  assert.equal(retryGrant.kind, 'admitted');
  if (retryGrant.kind !== 'admitted') throw new Error('expected legacy retry grant');
  const legacyIntent = await runtime.facade.markSubmitting({ grant: retryGrant.grant, requestSnapshot: {} });
  await runtime.facade.transmit(legacyIntent, async () => ({ terminalState: 'failed', actualCost: { currency: 'CNY', minor: 0 } }));
  await runtime.facade.settle({ attemptId: legacyIntent.attemptId, outcome: 'failed', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: false });
  db.prepare('UPDATE execution_operations SET providerSnapshotJson = ? WHERE id = ?').run(JSON.stringify({ providerId: 'replacement-provider', type: 'openai-compatible', model: 'replacement-image-model' }), legacyRetry.id);
  const replacementIntent = await runtime.facade.markSubmitting({ grant: retryGrant.grant, requestSnapshot: {}, retryKind: 'protocol_fallback', quote: { kind: 'unpriced' } });
  await runtime.facade.transmit(replacementIntent, async () => ({ terminalState: 'succeeded', actualCost: { currency: 'CNY', minor: 0 } }));
  await runtime.facade.settle({ attemptId: replacementIntent.attemptId, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 }, remoteTerminal: true });
  const legacyCalls = findTeamTask(db, { userId: 'admin', role: 'admin' }, legacyRetry.id)?.modelCalls;
  assert.equal(legacyCalls?.length, 2);
  assert.equal(legacyCalls[0]?.providerName, '执行时图片供应商');
  assert.equal(legacyCalls[0]?.model, 'image-retry-model');
  assert.equal(legacyCalls[1]?.providerName, 'replacement-provider');
  assert.equal(legacyCalls[1]?.model, 'replacement-image-model');
  console.log('PASS: fallback legacy names never replace a changed attempt snapshot or model');

  const undeterminedOperation = enqueue({ taskId: 'model-undetermined', providerSnapshot: { name: '已选供应商', model: '   ' } });
  const undetermined = findTeamTask(db, { userId: 'admin', role: 'admin' }, undeterminedOperation.id);
  assert.equal(undetermined?.model, null);
  assert.equal(undetermined?.modelStatus, 'undetermined');
  assert.equal(undetermined?.submissionCount, 0);
  console.log('PASS: a selected provider with no model remains explicitly undetermined');

  // 自动切换通道不是把旧 operation 重新排队：七牛失败仍是历史失败，腾讯有自己的执行记录。
  db.prepare("INSERT INTO image_assets VALUES ('fallback-input', '通道切换原图.png', 'shot_source')").run();
  for (const moduleName of ['image', 'video'] as const) {
    const taskId = `${moduleName}-channel-fallback`;
    const mediaTaskId = `${taskId}-media`;
    const businessTable = moduleName === 'image' ? 'jobs' : 'video_jobs';
    db.prepare(`INSERT INTO ${businessTable} VALUES (?, 'running', 'fallback-input', 'fixture-model', NULL)`).run(taskId);
    db.prepare(`INSERT INTO execution_media_tasks (
      id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
      inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
      status, currentChannelKey, createdAt, updatedAt
    ) VALUES (?, ?, 'alice', 'project', 'project-a', ?, ?, ?, 'rules-v1', ?, '{}', '{}',
      'project_scene', 'project-a', '{}', 'running', 'tencent', ?, ?)`)
      .run(mediaTaskId, mediaTaskId, moduleName, taskId, moduleName === 'image' ? 'image2' : 'kling3', taskId, timestamp, timestamp);
    const before = readTeamTaskActivity(db, { userId: 'admin', role: 'admin' }).counts;
    const failedChannel = enqueue({
      taskId, module: moduleName, step: 'submit', mediaTaskId, channelKey: 'qiniu',
      providerSnapshot: { name: '七牛通道', model: 'fixture-qiniu-model' },
    });
    db.prepare("UPDATE execution_operations SET status = 'failed' WHERE id = ?").run(failedChannel.id);
    assert.equal(findTeamTask(db, { userId: 'admin', role: 'admin' }, failedChannel.id)?.status, 'failed',
      '切换空隙中，统一任务的旧失败通道也不能冒充重新排队');
    const fallbackChannel = enqueue({
      taskId, module: moduleName, step: 'submit', inputRevision: 'r2', mediaTaskId, channelKey: 'tencent',
      providerSnapshot: { name: '腾讯通道', model: 'fixture-tencent-model' },
    });
    const queued = listTeamTaskRecords(db, { userId: 'admin', role: 'admin' }, { statuses: ['pending', 'deferred'], limit: 100 });
    assert.deepEqual(queued.items.filter(item => item.taskId === taskId).map(item => item.operationId), [fallbackChannel.id],
      '真实备用通道待提交时，只计一条排队记录');
    db.prepare("UPDATE execution_operations SET status = 'accepted' WHERE id = ?").run(fallbackChannel.id);
    const recent = listRecentTeamTasks(db, { userId: 'admin', role: 'admin' }, 50).items;
    assert.equal(recent.find(item => item.operationId === failedChannel.id)?.status, 'failed');
    assert.equal(recent.find(item => item.operationId === fallbackChannel.id)?.status, 'accepted');
    assert.equal(listTeamTasks(db, { userId: 'admin', role: 'admin' }, { q: taskId, status: 'pending' }).pagination.total, 0,
      '状态筛选不能把已失败通道计作排队');
    const after = readTeamTaskActivity(db, { userId: 'admin', role: 'admin' }).counts;
    assert.equal(after.queued, before.queued, '总览不增加虚假的排队名额');
    assert.equal(after.running, before.running + 1);
    assert.equal(after.failed, before.failed + 1);
    const employeeHistory = findTeamTask(db, { userId: 'alice', role: 'employee' }, failedChannel.id);
    assert.equal(employeeHistory?.status, 'failed');
    assert.equal(employeeHistory?.waitLabel, '');
  }
  console.log('PASS: channel fallback retains failed history and counts only the current channel as queued/running');

  db.prepare("INSERT INTO jobs VALUES ('manual-requeue', 'pending', 'fallback-input', 'fixture-model', NULL)").run();
  const original = enqueue({ taskId: 'manual-requeue', module: 'image', step: 'submit', providerSnapshot: { model: 'fixture-model' } });
  db.prepare("UPDATE execution_operations SET status = 'failed' WHERE id = ?").run(original.id);
  assert.equal(findTeamTask(db, { userId: 'admin', role: 'admin' }, original.id)?.status, 'pending',
    '普通任务人工重试、尚无新执行记录时，仍明确显示已回队');
  const manualRetry = enqueue({ taskId: 'manual-requeue', module: 'image', step: 'submit', inputRevision: 'r2', providerSnapshot: { model: 'fixture-model' } });
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = 'manual-requeue'").run();
  db.prepare("UPDATE execution_operations SET status = 'accepted' WHERE id = ?").run(manualRetry.id);
  assert.equal(findTeamTask(db, { userId: 'admin', role: 'admin' }, original.id)?.status, 'failed',
    '普通重试已有新的执行记录后，旧失败记录不能继续冒充排队');
  console.log('PASS: genuine manual requeue stays visible until the replacement execution exists');

  // Historical labels require evidence that every reservation for the current permit is released.
  {
    const history = enqueue({ taskId: 'released-history', providerSnapshot: { model: 'history-model' } });
    const admission = runtime.facade.admit({ ...identity, operationId: history.id });
    assert.equal(admission.kind, 'admitted');
    if (admission.kind !== 'admitted') throw new Error('history grant required');
    const intent = await runtime.facade.markSubmitting({ grant: admission.grant, requestSnapshot: {} });
    await assert.rejects(() => runtime.facade.transmit(intent, async () => { throw new Error('lost response'); }));
    const { taskStatusLabel, taskOccupancyLabel } = await import('../lib/team-task-labels.ts');
    const { recentConsoleTasks } = await import('../lib/team-console-overview.ts');
    const read = () => findTeamTask(db, { userId: 'admin', role: 'admin' }, history.id)!;
    assert.equal(taskStatusLabel(read()), '结果确认中');
    assert.equal(read().concurrencyReleased, false);
    db.prepare("UPDATE execution_reservations SET state='released' WHERE permitId=? AND kind='concurrency' AND poolKey='llm:remote'")
      .run(admission.grant.permitId);
    assert.equal(read().concurrencyReleased, false, 'one released shared slot does not prove the personal slot is released');
    db.prepare("UPDATE execution_reservations SET state='released' WHERE permitId=? AND kind='concurrency'")
      .run(admission.grant.permitId);
    const before = db.prepare('SELECT * FROM execution_operations WHERE id=?').get(history.id);
    const attemptsBefore = db.prepare('SELECT * FROM execution_attempts WHERE operationId=?').all(history.id);
    const costsBefore = db.prepare("SELECT * FROM execution_reservations WHERE permitId=? AND kind='cost'").all(admission.grant.permitId);
    const task = read();
    assert.equal(task.status, 'unknown');
    assert.equal(task.concurrencyReleased, true);
    assert.equal(taskStatusLabel(task), '历史调用待核对');
    assert.equal(taskOccupancyLabel(task), '名额已释放');
    assert.equal(recentConsoleTasks([task])[0].statusLabel, '历史调用待核对');
    assert.equal(recentConsoleTasks([task])[0].occupancyLabel, '名额已释放');
    assert.equal(findTeamTask(db, { userId: 'alice', role: 'employee' }, history.id)?.concurrencyReleased, true);
    assert.equal(findTeamTask(db, { userId: 'bob', role: 'employee' }, history.id), null);
    assert.ok(listTeamTasks(db, { userId: 'admin', role: 'admin' }, { status: 'unknown' }).items.some(item => item.operationId === history.id));
    assert.deepEqual(db.prepare('SELECT * FROM execution_operations WHERE id=?').get(history.id), before);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE operationId=?').all(history.id), attemptsBefore);
    assert.deepEqual(db.prepare("SELECT * FROM execution_reservations WHERE permitId=? AND kind='cost'").all(admission.grant.permitId), costsBefore);
    assert.equal(taskStatusLabel({ status: 'succeeded', concurrencyReleased: true }), '成功');
    assert.equal(taskOccupancyLabel({ status: 'succeeded', concurrencyReleased: true }), '');
    console.log('PASS: released historical calls show truthful labels across task and overview views without changing result, cost or access');
  }

  // LLM video analysis belongs to a shot set; the task list must resolve its registered project.
  for (const [rootType, rootId] of [['project', 'project-a'], ['canvas', 'canvas-a']] as const) {
    db.prepare(`INSERT OR IGNORE INTO team_resource_scopes
      (resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt)
      VALUES (?, ?, 'alice', 'private', NULL, NULL, ?, ?, ?, ?)`)
      .run(rootType, rootId, rootType, rootId, timestamp, timestamp);
  }
  for (const [resourceType, resourceId, rootType, rootId] of [
    ['shot_set', 'set-analysis', 'project', 'project-a'],
    ['canvas_task', 'canvas-analysis', 'canvas', 'canvas-a'],
  ] as const) {
    db.prepare(`INSERT INTO team_resource_scopes
      (resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt)
      VALUES (?, ?, 'alice', 'private', ?, ?, ?, ?, ?, ?)`)
      .run(resourceType, resourceId, rootType, rootId, rootType, rootId, timestamp, timestamp);
  }
  const analysisOperation = enqueue({ taskId: 'video-analysis:fixture', step: 'analyze:1', scopeType: 'shot_set', scopeId: 'set-analysis', providerSnapshot: { model: 'vision-model' } });
  db.prepare("UPDATE execution_operations SET status='unknown' WHERE id=?").run(analysisOperation.id);
  const analysisTask = findTeamTask(db, { userId: 'admin', role: 'admin' }, analysisOperation.id);
  assert.equal(analysisTask?.scopeName, '洁面乳详情页', 'shot-set analysis must show its project instead of unassociated');
  assert.equal(analysisTask?.stepName, '素材分析');
  assert.equal(analysisTask?.status, 'unknown', 'display repair must not pretend the provider succeeded');
  assert.deepEqual(analysisTask?.scope, { resourceType: 'shot_set', resourceId: 'set-analysis' }, 'retain the original authorization scope');
  assert.ok(listTeamTasks(db, { userId: 'alice', role: 'employee' }, { q: '洁面乳详情页' }, { pageSize: 50 }).items.some(item => item.operationId === analysisOperation.id));
  assert.ok(listTeamTasks(db, { userId: 'admin', role: 'admin' }, { q: '素材分析' }).items.some(item => item.operationId === analysisOperation.id));
  assert.equal(findTeamTask(db, { userId: 'bob', role: 'employee' }, analysisOperation.id), null);
  const canvasChild = enqueue({ taskId: 'canvas-child-analysis', step: 'analyze:1', scopeType: 'canvas_task', scopeId: 'canvas-analysis', providerSnapshot: {} });
  assert.equal(findTeamTask(db, { userId: 'admin', role: 'admin' }, canvasChild.id)?.scopeName, '夏季新品画布');
  db.prepare("DELETE FROM projects WHERE id='project-a'").run();
  assert.equal(findTeamTask(db, { userId: 'admin', role: 'admin' }, analysisOperation.id)?.scopeName, '项目已删除或不可用');
  console.log('PASS: inherited project/canvas scope names, analysis labels, search and caller isolation');
} finally {
  runtime.closeNewWork();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
