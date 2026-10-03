/**
 * F1 共享数量契约 + 上限 6 的落点验证：
 * 1. parseScriptStudioRequestedCount 覆盖 0/1/6/7/1.5/NaN（不先 floor）；
 * 2. planner 用 requestedCount=6 产出 6 个不同 template/angle（锁住模板池容量）；
 * 3. createTask 对 7/1.5 等非法数量抛错且不落库（不再 Math.max 掩盖非法输入）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  parseScriptProductionMode,
  parseScriptStudioRequestedCount,
  parseScriptStudioTargetDuration,
  parseTemplateRewriteEntryIds,
  SCRIPT_GENERATION_MAX_COUNT,
  SCRIPT_GENERATION_UI_OPTIONS,
} from '../lib/script-studio/generation-contract.ts';
import { planScriptDirections } from '../lib/script-studio/planner.ts';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { createTask } from '../lib/script-studio/tasks.ts';
import type { LibraryRevisionView } from '../lib/script-studio/libraries.ts';

// ---- 契约解析 ----
assert.equal(SCRIPT_GENERATION_MAX_COUNT, 6);
assert.deepEqual([...SCRIPT_GENERATION_UI_OPTIONS], [1, 2, 3, 4, 5, 6]);
assert.equal(parseScriptStudioRequestedCount(1), 1);
assert.equal(parseScriptStudioRequestedCount(6), 6);
assert.equal(parseScriptStudioRequestedCount('6'), 6, '数字字符串允许');
assert.equal(parseScriptStudioRequestedCount(' 6 '), 6, '带空格数字字符串允许');
assert.throws(() => parseScriptStudioRequestedCount(0), /1-6/);
assert.throws(() => parseScriptStudioRequestedCount(7), /1-6/);
assert.throws(() => parseScriptStudioRequestedCount(1.5), /1-6/, '小数不得被 Math.floor 吞掉');
assert.throws(() => parseScriptStudioRequestedCount('1.5'), /1-6/);
assert.throws(() => parseScriptStudioRequestedCount(Number.NaN), /1-6/);
assert.throws(() => parseScriptStudioRequestedCount('abc'), /1-6/);
assert.throws(() => parseScriptStudioRequestedCount(undefined), /1-6/);
assert.equal(parseScriptStudioTargetDuration(15), 15);
assert.equal(parseScriptStudioTargetDuration(60), 60);
assert.throws(() => parseScriptStudioTargetDuration(18), /15、20、30、45 或 60/);

// ---- 生产模式契约（爆文模板改写）----
assert.equal(parseScriptProductionMode(undefined, 20), 'standard');
assert.equal(parseScriptProductionMode('standard', 20), 'standard');
assert.equal(parseScriptProductionMode('pain_solving_15s', 15), 'pain_solving_15s');
assert.throws(() => parseScriptProductionMode('pain_solving_15s', 20), /仅支持15秒/);
assert.equal(parseScriptProductionMode('template_rewrite', 20), 'template_rewrite');
assert.equal(parseScriptProductionMode('template_rewrite', 15), 'template_rewrite', '模板改写时长走共享白名单，不限 15 秒');
assert.equal(parseScriptProductionMode('template_rewrite', 60), 'template_rewrite');
assert.throws(() => parseScriptProductionMode('audience_analysis', 20), /不支持的脚本生产模式/);

// ---- 模板选择校验（A03）：0、超上限、数量矛盾一律拒绝；同一模板可重复多条 ----
assert.throws(() => parseTemplateRewriteEntryIds([], 1), /勾选 1-6 个模板/, '0 个模板被拒绝');
assert.throws(() => parseTemplateRewriteEntryIds(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 7), /最多生成 6 条/, '展开后超 6 条被拒绝');
assert.throws(() => parseTemplateRewriteEntryIds(['a', 'b'], 3), /与模板条数一致/, '数量与模板条数矛盾被拒绝');
assert.throws(() => parseTemplateRewriteEntryIds(['a', 'b', 'c'], 2), /与模板条数一致/, '反向矛盾同样被拒绝');
assert.deepEqual(parseTemplateRewriteEntryIds(['a'], 1), ['a'], '1 个可用模板可提交');
assert.deepEqual(parseTemplateRewriteEntryIds(['a', 'b', 'c', 'd', 'e', 'f'], 6), ['a', 'b', 'c', 'd', 'e', 'f'], '6 个可用模板可提交且保持选择顺序');
assert.deepEqual(parseTemplateRewriteEntryIds(['a', 'a'], 2), ['a', 'a'], '同一模板重复 2 次 = 该模板生成 2 条');
assert.deepEqual(parseTemplateRewriteEntryIds(['a', 'a', 'b', 'b', 'b', 'c'], 6), ['a', 'a', 'b', 'b', 'b', 'c'], '多模板混合重复保持顺序');

// ---- planner 6 个不同方向 ----
const revision = {
  id: 'rev-6',
  category: '测试品类',
  sellingPoints: [
    { id: 'p1', pointType: 'appearance', seq: 1 },
    { id: 'p2', pointType: 'efficacy', seq: 2 },
    { id: 'p3', pointType: 'structure', seq: 3 },
    { id: 'p4', pointType: 'scenario', seq: 4 },
    { id: 'p5', pointType: 'material', seq: 5 },
    { id: 'p6', pointType: 'certification', seq: 6 },
  ],
} as unknown as LibraryRevisionView;
const planned = planScriptDirections(revision, 6, '');
assert.equal(planned.plans.length, 6, 'requestedCount=6 必须规划 6 个方案');
assert.equal(new Set(planned.plans.map((plan) => plan.templateId)).size, 6, '6 个方案必须使用不同模板');
assert.equal(new Set(planned.plans.map((plan) => plan.angle)).size, 6, '6 个方案必须使用不同切入角度');
assert.throws(() => planScriptDirections(revision, 7, ''), /1-6/, 'planner 不再静默钳制 7');
assert.throws(() => planScriptDirections(revision, 1.5, ''), /1-6/, 'planner 不再 Math.floor');

// ---- createTask 拒绝非法数量且不落库 ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-generation-contract-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
  INSERT INTO projects (id, name) VALUES ('p1', '一');
`);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(root, 'backups'),
  now: () => new Date('2026-09-02T00:00:00.000Z'),
});
const base = { projectId: 'p1', mode: 'reuse' as const, inputSnapshot: { targetDurationSec: 15 } };
for (const bad of [7, 1.5, 0, Number.NaN]) {
  assert.throws(
    () => createTask(db, { ...base, requestKey: `bad-${String(bad)}`, requestedCount: bad }),
    /1-6/,
    `createTask 必须拒绝非法数量 ${bad}`,
  );
}
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS n FROM script_studio_tasks WHERE requestKey LIKE 'bad-%'`).get() as { n: number }).n,
  0,
  '非法数量的 createTask 不得落库',
);
// 合法的 6 可以创建
const ok = createTask(db, { ...base, requestKey: 'ok-6', requestedCount: 6 });
assert.equal(ok.created, true);
assert.equal(ok.task.requestedCount, 6);

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('script-studio generation contract tests passed');
