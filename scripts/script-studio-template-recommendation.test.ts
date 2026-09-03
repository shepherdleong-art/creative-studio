import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { getOrCreateCatalog, createCatalogRevision, getCatalogRevisionView } from '../lib/script-studio/catalogs.ts';
import { resolveTemplateCatalogSource, recommendFromCatalog } from '../lib/script-studio/template-catalog.ts';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-template-recommendation-'));
const db = createBaseDatabase(root);
const readiness = await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups') });
assert.ok(readiness.state === 'current' || readiness.state === 'ready', `schema 未就绪: ${JSON.stringify(readiness)}`);

try {
  const catalog = getOrCreateCatalog(db, 'template');
  const revision = createCatalogRevision(db, {
    catalogId: catalog.id,
    sourceFilename: '模板.xlsx',
    sourceSha256: 'sha-tpl',
    importReport: { canActivate: true },
    frameworkTemplates: [
      { stableKey: '01', name: '01 痛点解决型', subtype: '解决问题‑给方案', structureJson: '["痛点暴露","原因揭示","产品解决"]', sellingPointDensityJson: '{}', applicableProductsJson: '["全品类"]', preferredHookTypesJson: '["痛点式","后悔式"]', secondaryHookTypesJson: '["反问式"]', sourceRow: 2, status: 'active' },
      { stableKey: '02', name: '02 场景需求型', subtype: '还原生活‑引需求', structureJson: '["场景进入","需求发生","产品介入"]', sellingPointDensityJson: '{}', applicableProductsJson: '["全品类"]', preferredHookTypesJson: '["反问式","痛点式"]', secondaryHookTypesJson: '["利益式"]', sourceRow: 3, status: 'active' },
      { stableKey: '03', name: '03 多卖点合辑型', subtype: '卖点合集', structureJson: '["卖点A","卖点B","卖点C"]', sellingPointDensityJson: '{}', applicableProductsJson: '["功能多卖点"]', preferredHookTypesJson: '["利益式"]', secondaryHookTypesJson: '["痛点式"]', sourceRow: 4, status: 'active' },
    ],
    copyHookTemplates: [
      { stableKey: '痛点式:行为反问', hookType: '痛点式', mechanism: '激发', subtype: '行为反问', formula: '为什么越来越多人开始【行为变化】？', example: '为什么越来越多人开始淘汰传统餐桌？', recommendedFrameworksJson: '["01"]', recommendedSellingPointTagsJson: '["选购标准"]', sourceRow: 2, status: 'active' },
      { stableKey: '反问式:场景反问', hookType: '反问式', mechanism: '激发思考', subtype: '场景反问', formula: '【场景】真的需要【传统方案】吗？', example: '小户型真的需要大沙发吗？', recommendedFrameworksJson: '["02"]', recommendedSellingPointTagsJson: '[]', sourceRow: 3, status: 'active' },
      { stableKey: '利益式:利益点直给', hookType: '利益式', mechanism: '利益前置', subtype: '利益点直给', formula: '【核心利益】到底值不值？', example: '万元级体验，千元级价格', recommendedFrameworksJson: '["03"]', recommendedSellingPointTagsJson: '["价格"]', sourceRow: 4, status: 'active' },
    ],
    visualHookTemplates: [
      { stableKey: '0→1 生成:快递箱爆炸开场', playGroup: '0→1 生成', playName: '快递箱爆炸开场', visualFormula: '[快递箱]→[炸开]→[家具飞出]', implementationAdvice: '可灵首尾帧', applicableProductsJson: '["全品类"]', hookTagsJson: '["利益式","悬念式"]', referenceLinksJson: '[]', notes: '制作备注：即梦OK', sourceRow: 2, status: 'active' },
      { stableKey: '0→1 生成:空场景进场', playGroup: '0→1 生成', playName: '空场景丝滑进场', visualFormula: '[空房间]→[家具依次滑入]', implementationAdvice: '可灵首尾帧', applicableProductsJson: '["全品类"]', hookTagsJson: '["场景代入","利益式"]', referenceLinksJson: '[]', notes: '制作备注：需要前期制图', sourceRow: 3, status: 'active' },
      { stableKey: '1→2 对比:前后对比', playGroup: '1→2 对比', playName: '使用前后对比', visualFormula: '[用前]→[用后]', implementationAdvice: '脚本画面', applicableProductsJson: '["功能多卖点"]', hookTagsJson: '["对比式"]', referenceLinksJson: '[]', notes: '', sourceRow: 5, status: 'active' },
      { stableKey: 'draft:缺玩法名称', playGroup: '0→1 生成', playName: '', visualFormula: '[缺失玩法名称]', implementationAdvice: '可灵', applicableProductsJson: '["全品类"]', hookTagsJson: '["利益式"]', referenceLinksJson: '[]', notes: '', sourceRow: 7, status: 'draft_invalid' },
    ],
  });
  assert.equal(revision.created, true);
  const view = getCatalogRevisionView(db, revision.revisionId)!;
  const source = resolveTemplateCatalogSource({
    frameworks: view.frameworkTemplates,
    copyHooks: view.copyHookTemplates,
    visualHooks: view.visualHookTemplates,
  });
  assert.equal(source.frameworks.length, 3, 'draft_invalid 不进入推荐池');
  assert.equal(source.visualHooks.length, 3, 'draft_invalid 画面钩子不进入推荐池');

  // 1. 确定性：同一冻结输入重试得到同一推荐
  const base = { count: 3, pointTypes: [] as string[], categoryMindsets: ['沙发'] as string[], primarySellingPoints: [] as string[] };
  const first = recommendFromCatalog(source, { ...base });
  const second = recommendFromCatalog(source, { ...base });
  assert.equal(first.usedCatalog, true);
  assert.equal(first.warning, null);
  assert.deepEqual(JSON.parse(JSON.stringify(first.plans)), JSON.parse(JSON.stringify(second.plans)), '同一冻结输入重试必须得到同一推荐');

  // 2. 多方案在供给充足时使用不同框架组合
  assert.equal(first.plans.length, 3);
  const frameworkKeys = first.plans.map((plan) => plan.framework!.stableKey);
  assert.equal(new Set(frameworkKeys).size, 3, '供给充足时 3 个方案应使用 3 个不同框架');
  assert.ok(first.plans.every((plan) => plan.framework && plan.copyHook && plan.visualHook), '每个方案都应带框架/文案钩子/画面钩子');

  // 3. 品类心智命中提升对应框架：命中「多卖点/功能」心智时 03 优先
  const functional = recommendFromCatalog(source, {
    count: 1,
    pointTypes: [] as string[],
    categoryMindsets: ['功能多卖点'] as string[],
    primarySellingPoints: [] as string[],
  });
  assert.equal(functional.plans[0]!.framework!.stableKey, '03', '品类心智命中时对应框架优先');

  // 3b. 证据卖点类型必须真实参与评分：场景型证据 → 场景需求框架 02 优先
  const scenarioBased = recommendFromCatalog(source, {
    count: 1,
    pointTypes: ['scenario'],
    categoryMindsets: [] as string[],
    primarySellingPoints: [] as string[],
  });
  assert.equal(scenarioBased.plans[0]!.framework!.stableKey, '02', '证据卖点类型命中时对应框架优先');
  const efficacyBased = recommendFromCatalog(source, {
    count: 1,
    pointTypes: ['efficacy'],
    categoryMindsets: [] as string[],
    primarySellingPoints: [] as string[],
  });
  assert.equal(efficacyBased.plans[0]!.framework!.stableKey, '01', '功效/痛点型证据命中时痛点解决框架优先');

  // 4. 排除当前组合（换一个）：排除后新推荐不使用被排除的框架/钩子
  const excluded = recommendFromCatalog(source, {
    ...base,
    count: 2,
    exclusions: {
      frameworkKeys: [first.plans[0]!.framework!.stableKey],
      copyHookKeys: [first.plans[0]!.copyHook!.stableKey],
      visualHookKeys: [first.plans[0]!.visualHook!.stableKey],
    },
  });
  assert.ok(
    excluded.plans.every((plan) => plan.framework && plan.framework.stableKey !== first.plans[0]!.framework!.stableKey),
    '排除的框架不得再次出现',
  );
  assert.ok(
    excluded.plans.every((plan) => plan.copyHook && plan.copyHook.stableKey !== first.plans[0]!.copyHook!.stableKey),
    '排除的文案钩子不得再次出现',
  );
  assert.ok(
    excluded.plans.every((plan) => plan.visualHook && plan.visualHook.stableKey !== first.plans[0]!.visualHook!.stableKey),
    '排除的画面钩子不得再次出现',
  );

  // 5. 全部框架被排除 → 安全回落并给出 warning
  const allExcluded = recommendFromCatalog(source, {
    ...base,
    count: 1,
    exclusions: { frameworkKeys: ['01', '02', '03'] },
  });
  assert.equal(allExcluded.usedCatalog, false);
  assert.ok(allExcluded.warning && allExcluded.warning.includes('已按现有静态模板生成'), '应给出回落 warning');

  // 6. 无框架 → 回落
  const emptySource = resolveTemplateCatalogSource({ frameworks: [], copyHooks: [], visualHooks: [] });
  const empty = recommendFromCatalog(emptySource, { ...base, count: 1 });
  assert.equal(empty.usedCatalog, false);
  assert.ok(empty.warning, '空目录应给出回落 warning');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('script-studio-template-recommendation tests passed');
