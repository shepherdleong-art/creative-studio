/** A32: only the output and warnings actually shown to the reviewer may be confirmed. */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BATCH_SCHEMA_MIGRATIONS } from '../lib/batch-production/schema.ts';
import { createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import { setBatchPlanReviews, readBatchPlanReview } from '../lib/batch-production/review.ts';

const db = new Database(':memory:');
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('p','审核验收');");
  for (const migration of BATCH_SCHEMA_MIGRATIONS) db.exec(migration.sql);
  const batchId = createBatchProduction(db, 'p', '所见版本审核');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 3 });
  const script = createProjectScript(db, 'p', { sourceKind: 'script_draft', sourceId: 'fixture', title: '脚本', bodyText: '好擦洗。', sourceVersion: '1' });
  const snapshot = snapshotScriptIntoBatch(db, versionId, { scriptId: script, copyCount: 3 });
  const plans = createOutputPlansForSnapshot(db, versionId, snapshot);
  const outputs = plans.map(planId => createOutputVersion(db, planId, { arrangementJson: {
    editRevision: 0, clips: [], warnings: ['检查产品颜色'], blockers: [], productionReady: true,
  } }));
  db.prepare("UPDATE batch_production_versions SET inputState='frozen' WHERE id=?").run(versionId);
  db.prepare('UPDATE batch_productions SET currentVersionId=? WHERE id=?').run(versionId, batchId);
  const read = (index: number) => readBatchPlanReview(db, 'p', batchId, plans[index]);
  const seen = plans.map((planId, index) => {
    const context = read(index).context;
    assert(context, '读取审核状态应同时给出当前版本、修订和问题集合');
    return { planId, ...context };
  });
  // Simulate another editor saving after this browser loaded its review context.
  db.prepare("UPDATE batch_output_versions SET arrangementJson=json_set(arrangementJson,'$.editRevision',1) WHERE id=?").run(outputs[0]);
  const partial = setBatchPlanReviews(db, 'p', batchId, { items: [seen[0], seen[1]], decision: 'approved' });
  assert.deepEqual(partial.planIds, [plans[1]], '批量只推进仍匹配用户所见内容的条目');
  assert.deepEqual(partial.results.map(item => item.status), ['conflict', 'saved']);
  assert.equal(read(0).decision, null);
  assert.equal(read(1).decision, 'approved');
  assert.equal(read(1).confirmed?.outputVersionId, outputs[1]);
  assert.equal(read(1).confirmed?.editRevision, 0);
  assert.equal(read(1).confirmed?.issueSetHash, seen[1].issueSetHash);
  assert(read(1).confirmed?.issues.some(issue => issue.message === '检查产品颜色'), '保存本次实际确认的问题内容');
  db.prepare("UPDATE batch_output_versions SET arrangementJson=json_set(arrangementJson,'$.warnings',json(?)) WHERE id=?")
    .run('["还要检查尺寸"]', outputs[2]);
  const changedIssues = setBatchPlanReviews(db, 'p', batchId, { items: [seen[2]], decision: 'approved' });
  assert.equal(changedIssues.results[0].status, 'conflict', '同版本同修订但问题内容改变也不能误确认');
  assert.equal(read(2).decision, null);
  const beforeAllocationWarning = read(1).context!;
  db.prepare(`INSERT INTO batch_allocation_runs(id,batchVersionId,ruleVersion,seed,inputFingerprint,resultJson,createdAt)
    VALUES('review-allocation',?,'fixture','fixture','fixture',?,datetime('now'))`)
    .run(versionId, JSON.stringify({ outputs: [{ planId: plans[1], warnings: ['请核对最新换片结果'] }] }));
  db.prepare("UPDATE batch_production_versions SET currentAllocationRunId='review-allocation' WHERE id=?").run(versionId);
  assert.equal(read(1).decision, null, '分配报告增加当前成片提醒时，旧审核也应失效');
  assert.notEqual(read(1).context?.issueSetHash, beforeAllocationWarning.issueSetHash);
  assert(read(1).context?.issues.some(issue => issue.message === '请核对最新换片结果'));
  const currentTarget = (index: number) => ({ planId: plans[index], ...read(index).context! });
  const oldVersion = currentTarget(0);
  const replacementOutput = createOutputVersion(db, plans[0], { arrangementJson: { editRevision: oldVersion.editRevision, clips: [], warnings: [] } });
  for (const decision of ['approved', 'rework', 'cancelled'] as const) {
    assert.equal(setBatchPlanReviews(db, 'p', batchId, { items: [oldVersion], decision }).results[0].status, 'conflict',
      '新成片版本即使修订数字相同，也不能被旧页操作');
  }
  assert.equal(read(0).context?.outputVersionId, replacementOutput);
  assert.equal(read(0).decision, null);
  assert.throws(() => setBatchPlanReviews(db, 'other-project', batchId, { items: [currentTarget(1)], decision: 'approved' }), /批次不存在/);
  const scoped = setBatchPlanReviews(db, 'p', batchId, { items: [{ ...currentTarget(0), planId: 'another-batch-plan' }, currentTarget(1)], decision: 'approved' });
  assert.deepEqual(scoped.results.map(item => item.status), ['conflict', 'saved']);
  assert.throws(() => setBatchPlanReviews(db, 'p', batchId, { items: [currentTarget(1), currentTarget(1)], decision: 'cancelled' }), /版本|提醒/);
  assert.throws(() => setBatchPlanReviews(db, 'p', batchId, { items: [currentTarget(1), { ...currentTarget(2), editRevision: -1 }], decision: 'cancelled' }), /版本|提醒/);
  assert.equal(read(1).decision, 'approved', '请求格式错误时不应部分撤销已有确认');
  db.prepare("UPDATE batch_productions SET controlState='stopped' WHERE id=?").run(batchId);
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { items: [currentTarget(1)], decision: 'cancelled' }).results[0].status, 'conflict');
  assert.equal(read(1).decision, 'approved', '停止后的审核操作保留原记录');
  db.prepare("UPDATE batch_productions SET controlState='running' WHERE id=?").run(batchId);
  db.prepare("UPDATE batch_production_versions SET inputState='draft' WHERE id=?").run(versionId);
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { items: [currentTarget(2)], decision: 'approved' }).results[0].status, 'conflict');
  console.log('batch review: version/revision/issue CAS, partial results and accepted issue snapshot passed');
} finally { db.close(); }
