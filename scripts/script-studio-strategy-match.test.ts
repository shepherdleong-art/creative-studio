import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { getOrCreateCatalog, createCatalogRevision } from '../lib/script-studio/catalogs.ts';
import { resolveKnowledgeContext, serializeKnowledgeContext, parseKnowledgeContext } from '../lib/script-studio/knowledge-context.ts';
import { createScriptStudioTaskRequestKey } from '../lib/script-studio/tasks.ts';
import type { ScriptStudioPointType } from '../lib/script-studio/types.ts';

function createBaseDatabase(root: string): Database.Database {
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')), productCode TEXT DEFAULT '', exportDirName TEXT NOT NULL DEFAULT '');
    CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE);
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-strategy-match-'));
const db = createBaseDatabase(root);
const readiness = await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.ok(readiness.state === 'current' || readiness.state === 'ready', `schema 未就绪: ${JSON.stringify(readiness)}`);

try {
  // 策略目录：XQ9A（搜索词 + 卖点）与 PC672 / PC672-A 组合。
  const strategyCatalog = getOrCreateCatalog(db, 'strategy');
  const strategyRev = createCatalogRevision(db, {
    catalogId: strategyCatalog.id,
    sourceFilename: '策略.xlsx',
    sourceSha256: 'sha-strategy',
    importReport: { canActivate: true },
    strategyEntries: [
      {
        modelKey: 'XQ9A', normalizedModelKey: 'xq9a', canonicalName: '微醺功能沙发',
        categoryMindsetsJson: '["客厅核心"]', primarySellingPointsJson: '["一键折叠","智能调节"]', differentiatorsJson: '["窄缝适配"]',
        searchTermsJson: '["微醺沙发","折叠沙发"]', auxiliaryJson: '{}', sourceRowsJson: '[2,3]', status: 'active',
      },
      {
        modelKey: 'PC672', normalizedModelKey: 'pc672', canonicalName: '云感沙发',
        categoryMindsetsJson: '["卧室"]', primarySellingPointsJson: '["透气面料"]', differentiatorsJson: '[]',
        searchTermsJson: '["云感沙发"]', auxiliaryJson: '{}', sourceRowsJson: '[5]', status: 'active',
      },
      {
        modelKey: 'PC672-A', normalizedModelKey: 'pc672-a', canonicalName: '云感沙发A款',
        categoryMindsetsJson: '["卧室"]', primarySellingPointsJson: '["透气面料","加宽座深"]', differentiatorsJson: '[]',
        searchTermsJson: '["云感沙发A"]', auxiliaryJson: '{}', sourceRowsJson: '[6]', status: 'active',
      },
    ],
  });
  assert.equal(strategyRev.created, true);

  // 模板目录：一个框架 + 钩子，用于验证模板推荐冻结。
  const templateCatalog = getOrCreateCatalog(db, 'template');
  createCatalogRevision(db, {
    catalogId: templateCatalog.id,
    sourceFilename: '模板.xlsx',
    sourceSha256: 'sha-template',
    importReport: { canActivate: true },
    frameworkTemplates: [
      { stableKey: '01', name: '01 痛点解决型', subtype: 'x', structureJson: '["痛点暴露","产品解决"]', sellingPointDensityJson: '{}', applicableProductsJson: '["全品类"]', preferredHookTypesJson: '["痛点式"]', secondaryHookTypesJson: '["反问式"]', sourceRow: 2, status: 'active' },
    ],
    copyHookTemplates: [
      { stableKey: '痛点式:行为反问', hookType: '痛点式', mechanism: 'm', subtype: '行为反问', formula: '为什么…？', example: '例', recommendedFrameworksJson: '[]', recommendedSellingPointTagsJson: '[]', sourceRow: 2, status: 'active' },
    ],
    visualHookTemplates: [
      { stableKey: '0→1 生成:开场', playGroup: '0→1 生成', playName: '开场', visualFormula: '[A]→[B]', implementationAdvice: '可灵', applicableProductsJson: '["全品类"]', hookTagsJson: '["痛点式"]', referenceLinksJson: '[]', notes: '', sourceRow: 2, status: 'active' },
    ],
  });

  const baseInput = { modelKey: 'XQ9A', requestedCount: 2, pointTypes: [] as ScriptStudioPointType[] };

  // 1. 命中：策略字段被冻结
  const matched = resolveKnowledgeContext(db, { ...baseInput });
  assert.equal(matched.strategy.matchStatus, 'matched');
  assert.equal(matched.strategy.canonicalName, '微醺功能沙发');
  assert.deepEqual(matched.strategy.searchTerms, ['微醺沙发', '折叠沙发']);
  assert.deepEqual(matched.strategy.primarySellingPoints, ['一键折叠', '智能调节']);
  assert.ok(matched.strategy.strategyCatalogRevisionId);
  assert.ok(matched.strategy.strategyEntryId);
  assert.deepEqual(matched.strategy.sourceRows, [2, 3]);
  assert.equal(matched.template.usedCatalog, true, '模板目录就绪时使用目录推荐');
  assert.equal(matched.recommendations.length, 2, '每个方案一条推荐');
  assert.ok(matched.recommendations[0]!.framework, '推荐应包含核心框架');
  assert.ok(matched.fingerprint.length > 0);

  // 2. 子型号组合命中优先；组合未命中回落主型号
  const comboHit = resolveKnowledgeContext(db, { ...baseInput, modelKey: 'PC672', submodel: 'A' });
  assert.equal(comboHit.strategy.canonicalName, '云感沙发A款', '子型号组合命中');
  const comboMiss = resolveKnowledgeContext(db, { ...baseInput, modelKey: 'PC672', submodel: 'B' });
  assert.equal(comboMiss.strategy.canonicalName, '云感沙发', '组合未命中回落主型号');

  // 3. 未命中：不阻断，给出 unmatched 状态
  const unmatched = resolveKnowledgeContext(db, { ...baseInput, modelKey: 'ZZZZ' });
  assert.equal(unmatched.strategy.matchStatus, 'unmatched');
  assert.equal(unmatched.strategy.strategyEntryId, null);
  assert.equal(unmatched.recommendations.length, 2, '未命中策略仍使用模板目录推荐');
  assert.equal(unmatched.template.usedCatalog, true);

  // 4. 确定性：同一冻结输入重试得到同一指纹
  const again = resolveKnowledgeContext(db, { ...baseInput });
  assert.equal(again.fingerprint, matched.fingerprint, '同一冻结输入重试必须得到同一指纹');

  // 5. 不同知识版本 → 不同指纹（requestKey 不得误复用旧任务）
  const newStrategyRev = createCatalogRevision(db, {
    catalogId: strategyCatalog.id,
    sourceFilename: '策略v2.xlsx',
    sourceSha256: 'sha-strategy-v2',
    importReport: { canActivate: true },
    strategyEntries: [
      {
        modelKey: 'XQ9A', normalizedModelKey: 'xq9a', canonicalName: '微醺功能沙发新',
        categoryMindsetsJson: '["客厅核心"]', primarySellingPointsJson: '["一键折叠"]', differentiatorsJson: '[]',
        searchTermsJson: '["微醺沙发"]', auxiliaryJson: '{}', sourceRowsJson: '[2]', status: 'active',
      },
    ],
  });
  assert.equal(newStrategyRev.created, true);
  const afterSwitch = resolveKnowledgeContext(db, { ...baseInput });
  assert.notEqual(afterSwitch.fingerprint, matched.fingerprint, '策略版本变化后指纹必须不同');

  // 6. 「换一个」排除当前组合 → 新指纹，进入快照
  const withExclusions = resolveKnowledgeContext(db, {
    ...baseInput,
    exclusions: {
      frameworkKeys: [matched.recommendations[0]!.framework!.stableKey],
      copyHookKeys: [matched.recommendations[0]!.copyHook?.stableKey ?? ''],
      visualHookKeys: [matched.recommendations[0]!.visualHook?.stableKey ?? ''],
    },
  });
  assert.notEqual(withExclusions.fingerprint, matched.fingerprint, '排除当前组合后指纹必须不同');

  // 7. 序列化/反序列化往返：快照内容自洽（runner 只读快照）
  const serialized = serializeKnowledgeContext(matched);
  const parsed = parseKnowledgeContext(serialized);
  assert.ok(parsed);
  assert.equal(parsed.strategy.matchStatus, 'matched');
  assert.equal(parsed.fingerprint, matched.fingerprint);
  assert.equal(parsed.recommendations.length, matched.recommendations.length);

  // 8. requestKey 派生身份包含知识指纹：不同知识版本 key 不同
  const keyBase = { projectId: 'p1', mode: 'reuse' as const, sourceSetId: null, libraryRevisionId: null, targetDurationSec: 15, requestedCount: 2, creativeBrief: '', providerId: 'pv', providerModel: 'model' };
  const keyA = createScriptStudioTaskRequestKey({ ...keyBase, knowledgeFingerprint: matched.fingerprint });
  const keyB = createScriptStudioTaskRequestKey({ ...keyBase, knowledgeFingerprint: afterSwitch.fingerprint });
  assert.notEqual(keyA, keyB, '不同知识版本必须得到不同 requestKey');
  const keyA2 = createScriptStudioTaskRequestKey({ ...keyBase, knowledgeFingerprint: matched.fingerprint });
  assert.equal(keyA, keyA2, '同一知识指纹必须得到同一 requestKey');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('script-studio-strategy-match tests passed');
