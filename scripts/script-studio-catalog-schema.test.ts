import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady, SCRIPT_STUDIO_MIGRATIONS } from '../lib/script-studio/schema.ts';
import {
  findCatalog,
  getOrCreateCatalog,
  createCatalogRevision,
  setCatalogCurrentRevision,
  getCatalogCurrentRevisionId,
  listCatalogRevisions,
  getCatalogRevisionView,
  matchStrategyEntry,
} from '../lib/script-studio/catalogs.ts';
import { resolveKnowledgeContext } from '../lib/script-studio/knowledge-context.ts';

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

async function readyDb(root: string): Promise<Database.Database> {
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
  const db = createBaseDatabase(root);
  const readiness = await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  assert.ok(readiness.state === 'current' || readiness.state === 'ready', `schema 未就绪: ${JSON.stringify(readiness)}`);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-catalog-schema-'));
const db = await readyDb(root);
try {

  // 1. v4 迁移后目录表齐备
  for (const table of ['script_studio_catalogs', 'script_studio_catalog_revisions', 'script_studio_strategy_entries', 'script_studio_framework_templates', 'script_studio_copy_hook_templates', 'script_studio_visual_hook_templates', 'script_studio_template_assets']) {
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    assert.ok(row, `缺少表 ${table}`);
  }

  // 2. 每类只有一个 catalog；未导入时容错查找返回 null（设置页空状态）
  assert.equal(findCatalog(db, 'strategy'), null, '尚未导入时 findCatalog 不得抛错');
  assert.equal(findCatalog(db, 'template'), null);
  const strategyCatalog = getOrCreateCatalog(db, 'strategy');
  const templateCatalog = getOrCreateCatalog(db, 'template');
  assert.equal(getOrCreateCatalog(db, 'strategy').id, strategyCatalog.id, '同 kind 不得重复建 catalog');
  assert.ok(findCatalog(db, 'strategy'), '导入后 findCatalog 返回既有 catalog');

  // 3. 创建策略修订：同指纹幂等
  const rev1 = createCatalogRevision(db, {
    catalogId: strategyCatalog.id,
    sourceFilename: '策略.xlsx',
    sourceSha256: 'sha-aaa',
    importReport: { totalRows: 1, validRows: 1, mergedModelCount: 1, issues: [], canActivate: true },
    strategyEntries: [{
      modelKey: 'XQ9A', normalizedModelKey: 'xq9a', canonicalName: '微醺功能沙发',
      categoryMindsetsJson: '["品类心智A"]', primarySellingPointsJson: '["卖点1"]', differentiatorsJson: '["差异1"]',
      searchTermsJson: '["搜索词1"]', auxiliaryJson: '{}', sourceRowsJson: '[8]', status: 'active',
    }],
  });
  assert.equal(rev1.created, true);
  const rev1Again = createCatalogRevision(db, {
    catalogId: strategyCatalog.id,
    sourceFilename: '策略.xlsx',
    sourceSha256: 'sha-aaa',
    importReport: {},
  });
  assert.equal(rev1Again.created, false, '相同内容指纹必须幂等');
  assert.equal(rev1Again.revisionId, rev1.revisionId);

  // 4. 新修订成为当前版本；历史修订可切换
  assert.equal(getCatalogCurrentRevisionId(db, 'strategy'), rev1.revisionId);
  const rev2 = createCatalogRevision(db, {
    catalogId: strategyCatalog.id,
    sourceFilename: '策略v2.xlsx',
    sourceSha256: 'sha-bbb',
    importReport: {},
    strategyEntries: [
      {
        modelKey: 'PC672-A', normalizedModelKey: 'pc672-a', canonicalName: '沙发PC672A',
        categoryMindsetsJson: '[]', primarySellingPointsJson: '[]', differentiatorsJson: '[]', searchTermsJson: '[]', auxiliaryJson: '{}', sourceRowsJson: '[8]', status: 'active',
      },
      {
        modelKey: 'PC672', normalizedModelKey: 'pc672', canonicalName: '沙发PC672',
        categoryMindsetsJson: '[]', primarySellingPointsJson: '[]', differentiatorsJson: '[]', searchTermsJson: '[]', auxiliaryJson: '{}', sourceRowsJson: '[9]', status: 'active',
      },
    ],
  });
  assert.equal(getCatalogCurrentRevisionId(db, 'strategy'), rev2.revisionId);
  setCatalogCurrentRevision(db, strategyCatalog.id, rev1.revisionId);
  assert.equal(getCatalogCurrentRevisionId(db, 'strategy'), rev1.revisionId, '可回滚到历史修订');
  const revisions = listCatalogRevisions(db, strategyCatalog.id);
  assert.equal(revisions.length, 2);
  const currentFlags = revisions.filter((r) => r.current);
  assert.equal(currentFlags.length, 1);
  assert.equal(currentFlags[0]!.id, rev1.revisionId);

  // 5. 修订视图包含条目（rev1 仍是当前版本）
  const view = getCatalogRevisionView(db, rev1.revisionId);
  assert.ok(view);
  assert.equal(view!.strategyEntries.length, 1);
  assert.equal(view!.strategyEntries[0]!.canonicalName, '微醺功能沙发');
  assert.equal(view!.current, true, '当前指针指向 rev1 时 rev1 视图 current=true');

  // 6. 型号匹配（当前版本为 rev1）：命中 XQ9A；PC672 未命中返回 null
  assert.equal(matchStrategyEntry(db, 'strategy', 'XQ9A')?.view.canonicalName, '微醺功能沙发');
  assert.equal(matchStrategyEntry(db, 'strategy', 'PC672', 'A'), null, '当前修订不含 PC672 时不得命中');
  assert.equal(matchStrategyEntry(db, 'strategy', 'ZZZZ'), null);

  // 7. 切换到 rev2 后：组合优先、主型号回落、旧修订不再命中
  setCatalogCurrentRevision(db, strategyCatalog.id, rev2.revisionId);
  assert.equal(matchStrategyEntry(db, 'strategy', 'PC672', 'A')?.view.canonicalName, '沙发PC672A', '子型号组合命中');
  assert.equal(matchStrategyEntry(db, 'strategy', 'PC672', 'B')?.view.canonicalName, '沙发PC672', '组合未命中时回落主型号');
  assert.equal(matchStrategyEntry(db, 'strategy', 'PC672')?.view.canonicalName, '沙发PC672', '无子型号时直接查完整型号');
  assert.equal(matchStrategyEntry(db, 'strategy', 'XQ9A'), null, '切换当前版本后旧修订条目不再可匹配');

  // 7b. 未命中也保留「查过哪一版策略」与型号键：两个不同策略版本即使都未命中，
  // fingerprint 也必须不同（否则任务 requestKey 会跨版本碰撞）。
  const unmatchedContextFor = (revisionId: string) => {
    setCatalogCurrentRevision(db, strategyCatalog.id, revisionId);
    return resolveKnowledgeContext(db, { modelKey: 'ZZZZ', requestedCount: 1, pointTypes: [] });
  };
  const unmatchedA = unmatchedContextFor(rev1.revisionId);
  const unmatchedB = unmatchedContextFor(rev2.revisionId);
  assert.equal(unmatchedA.strategy.matchStatus, 'unmatched');
  assert.equal(unmatchedA.strategy.strategyCatalogRevisionId, rev1.revisionId, '未命中也要记录查过哪一版策略');
  assert.equal(unmatchedA.strategy.normalizedModelKey, 'zzzz', '未命中也要记录规范化型号键');
  assert.notEqual(unmatchedA.fingerprint, unmatchedB.fingerprint, '不同策略版本都未命中时 fingerprint 必须不同');

  // 8. 模板目录创建
  const templateRev = createCatalogRevision(db, {
    catalogId: templateCatalog.id,
    sourceFilename: '模板.xlsx',
    sourceSha256: 'sha-tpl',
    importReport: {},
    frameworkTemplates: [{ stableKey: '01', name: '01 痛点解决型', subtype: '', structureJson: '["痛点暴露","产品解决"]', sellingPointDensityJson: '{}', applicableProductsJson: '["全品类"]', preferredHookTypesJson: '["痛点式"]', secondaryHookTypesJson: '["反问式"]', sourceRow: 2, status: 'active' }],
    copyHookTemplates: [{ stableKey: '痛点式:行为反问', hookType: '痛点式', mechanism: '激发', subtype: '行为反问', formula: '为什么…', example: '…', recommendedFrameworksJson: '[]', recommendedSellingPointTagsJson: '[]', sourceRow: 2, status: 'active' }],
    visualHookTemplates: [{ stableKey: '0→1 生成:快递箱爆炸开场', playGroup: '0→1 生成', playName: '快递箱爆炸开场', visualFormula: '[A]→[B]', implementationAdvice: '可灵', applicableProductsJson: '["全品类"]', hookTagsJson: '["利益式"]', referenceLinksJson: '[]', notes: '制作备注：即梦OK', sourceRow: 2, status: 'active' }],
  });
  assert.equal(templateRev.created, true);
  const templateView = getCatalogRevisionView(db, templateRev.revisionId);
  assert.ok(templateView);
  assert.equal(templateView!.frameworkTemplates.length, 1);
  assert.equal(templateView!.copyHookTemplates.length, 1);
  assert.equal(templateView!.visualHookTemplates.length, 1);
  assert.equal(templateView!.visualHookTemplates[0]!.assetIds.length, 0);

  // 9. 失败导入不改变当前版本：同修订内重复 normalizedModelKey 违反唯一约束 → 整体回滚
  const currentBeforeFailure = getCatalogCurrentRevisionId(db, 'template');
  assert.throws(() => createCatalogRevision(db, {
    catalogId: templateCatalog.id,
    sourceFilename: '模板-坏.xlsx',
    sourceSha256: 'sha-bad',
    importReport: {},
    frameworkTemplates: [
      { stableKey: '01', name: '重复键A', subtype: '', structureJson: '[]', sellingPointDensityJson: '{}', applicableProductsJson: '[]', preferredHookTypesJson: '[]', secondaryHookTypesJson: '[]', sourceRow: 2, status: 'active' },
      { stableKey: '01', name: '重复键B', subtype: '', structureJson: '[]', sellingPointDensityJson: '{}', applicableProductsJson: '[]', preferredHookTypesJson: '[]', secondaryHookTypesJson: '[]', sourceRow: 3, status: 'active' },
    ],
  }), '同修订内重复稳定键必须整体回滚');
  assert.equal(getCatalogCurrentRevisionId(db, 'template'), currentBeforeFailure, '失败导入不得改变当前版本');
  assert.equal(listCatalogRevisions(db, templateCatalog.id).length, 1, '失败导入不得留下半版本');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('script-studio-catalog-schema tests passed');
