import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  parseProductionIdentityInput,
  buildProjectBaseName,
  resolveUniqueProjectBaseName,
  deriveProjectNamingDate,
  formatShanghaiIdentityDate,
} from '../lib/project-production-identity.ts';
import { ProjectInfoValidationError } from '../lib/project-info.ts';
import {
  createExportIdentity,
  activateNewExportIdentity,
  hasExportIdentity,
  listExportIdentities,
} from '../lib/project-export-identity.ts';
import type { ProjectProductionIdentity } from '../lib/project-production-identity.ts';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      productName TEXT DEFAULT '',
      productCode TEXT DEFAULT '',
      productCategory TEXT DEFAULT '',
      exportDirName TEXT NOT NULL DEFAULT '',
      storeCode TEXT NOT NULL DEFAULT '',
      productSubmodel TEXT NOT NULL DEFAULT '',
      productionType TEXT NOT NULL DEFAULT '',
      editorName TEXT NOT NULL DEFAULT '',
      namingDate TEXT NOT NULL DEFAULT '',
      currentExportIdentityId TEXT
    );
    CREATE TABLE project_export_identities (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      revisionNumber INTEGER NOT NULL,
      baseName TEXT NOT NULL,
      exportDirName TEXT NOT NULL,
      identityJson TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      supersededAt TEXT,
      UNIQUE(projectId, revisionNumber),
      UNIQUE(exportDirName)
    );
  `);
  return db;
}

function insertNewProject(db: Database.Database, row: { id: string; name: string; storeCode?: string; productCode?: string; productSubmodel?: string; productionType?: string; editorName?: string; namingDate?: string; createdAt?: string }): void {
  db.prepare(`
    INSERT INTO projects (id, name, createdAt, storeCode, productCode, productSubmodel, productionType, editorName, namingDate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.name, row.createdAt ?? '2026-08-01 08:00:00', row.storeCode ?? '', row.productCode ?? '', row.productSubmodel ?? '', row.productionType ?? '', row.editorName ?? '', row.namingDate ?? '');
}

// ── POST /api/projects 的领域行为 ──
// 1. 合法身份字段 → 服务端生成名称
{
  const identity = parseProductionIdentityInput({ storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷' });
  const namingDate = formatShanghaiIdentityDate(new Date('2026-09-03T02:00:00Z'));
  assert.equal(namingDate, '20260903');
  assert.equal(buildProjectBaseName({ ...identity, namingDate }), '20260903-B店-XQ9A-AI种草-紫菜卷');
}

// 2. 绕过前端直接 POST 非法枚举 → 400（领域层抛校验错误）
{
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: '天猫', productCode: 'XQ9A', productionType: 'AI种草', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError,
  );
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: 'B店', productCode: 'XQ9A', productionType: '带货', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError,
  );
  assert.throws(
    () => parseProductionIdentityInput({ storeCode: 'B店', productCode: '', productionType: 'AI种草', editorName: '紫菜卷' }),
    (error: unknown) => error instanceof ProjectInfoValidationError,
  );
}

// 3. 创建时忽略客户端 name：客户端伪造 name 无效（名称由服务端按身份生成）
{
  const db = makeDb();
  const identity = parseProductionIdentityInput({ storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷' });
  const baseName = resolveUniqueProjectBaseName(db, buildProjectBaseName({ ...identity, namingDate: '20260903' }));
  assert.equal(baseName, '20260903-B店-XQ9A-AI种草-紫菜卷');
  insertNewProject(db, { id: 'p1', name: baseName, ...identity, namingDate: '20260903' });
  db.close();
}

// 4. 第二个完全同名项目 → 追加 -02
{
  const db = makeDb();
  const identity = parseProductionIdentityInput({ storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷' });
  const first = resolveUniqueProjectBaseName(db, buildProjectBaseName({ ...identity, namingDate: '20260903' }));
  insertNewProject(db, { id: 'p1', name: first, ...identity, namingDate: '20260903' });
  const second = resolveUniqueProjectBaseName(db, buildProjectBaseName({ ...identity, namingDate: '20260903' }));
  assert.equal(second, '20260903-B店-XQ9A-AI种草-紫菜卷-02');
  db.close();
}

// ── PATCH /api/projects/[id] 的领域行为 ──
// 5. 首次正式导出前修改身份 → 重新生成名称，不创建身份修订
{
  const db = makeDb();
  insertNewProject(db, { id: 'p1', name: '旧名', storeCode: 'B店', productCode: 'XQ9A', productionType: 'AI种草', editorName: '紫菜卷', namingDate: '20260903' });
  assert.equal(hasExportIdentity(db, 'p1'), false);
  const updated = parseProductionIdentityInput({ ...{ storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷' }, productSubmodel: 'A' });
  const baseName = resolveUniqueProjectBaseName(db, buildProjectBaseName({ ...updated, namingDate: '20260903' }), 'p1');
  db.prepare(`UPDATE projects SET name = ? WHERE id = 'p1'`).run(baseName);
  const row = db.prepare(`SELECT name FROM projects WHERE id = 'p1'`).get() as { name: string };
  assert.equal(row.name, '20260903-B店-XQ9A-A-AI种草-紫菜卷');
  assert.equal(hasExportIdentity(db, 'p1'), false, '尚未正式导出不得创建身份修订');
  db.close();
}

// 6. 首次正式导出冻结后修改身份（未显式确认）→ 被阻止；显式确认 → 新修订且旧身份可追溯
{
  const db = makeDb();
  insertNewProject(db, { id: 'p1', name: 'x', storeCode: 'B店', productCode: 'XQ9A', productionType: 'AI种草', editorName: '紫菜卷', namingDate: '20260903' });
  const frozenIdentity: ProjectProductionIdentity = { namingDate: '20260903', storeCode: 'B店', productCode: 'XQ9A', productSubmodel: '', productionType: 'AI种草', editorName: '紫菜卷' };
  createExportIdentity(db, { projectId: 'p1', identity: frozenIdentity });
  assert.equal(hasExportIdentity(db, 'p1'), true);

  // 未确认时：领域层不应新建修订（路由返回 409，见下方源码契约）
  assert.equal(listExportIdentities(db, 'p1').length, 1);

  // 显式确认 → 新修订，旧身份 superseded
  const newIdentity: ProjectProductionIdentity = { ...frozenIdentity, productSubmodel: 'A' };
  const v2 = activateNewExportIdentity(db, { projectId: 'p1', identity: newIdentity });
  assert.equal(v2.revisionNumber, 2);
  const all = listExportIdentities(db, 'p1');
  assert.equal(all.length, 2);
  assert.notEqual(all[0].supersededAt, null, '旧身份必须被标记 superseded');
  assert.equal(all[1].exportDirName, '20260903-B店-XQ9A-A-AI种草-紫菜卷');
  db.close();
}

// 7. 历史项目补齐身份：日期取原 createdAt（上海时区），并冻结第一版身份
{
  const db = makeDb();
  // 2026-08-15 16:30 UTC = 2026-08-16 00:30 上海
  insertNewProject(db, { id: 'legacy', name: '旧项目', createdAt: '2026-08-15 16:30:00' });
  const namingDate = deriveProjectNamingDate(db.prepare(`SELECT namingDate, createdAt FROM projects WHERE id = 'legacy'`).get() as { namingDate: string; createdAt: string });
  assert.equal(namingDate, '20260816', '历史项目命名日期从 createdAt 按上海时区派生');
  const identity = parseProductionIdentityInput({ storeCode: 'K店', productCode: 'RQ5A', productSubmodel: '', productionType: '新品种草', editorName: '紫菜卷' });
  const view = createExportIdentity(db, { projectId: 'legacy', identity: { ...identity, namingDate } });
  assert.equal(view.revisionNumber, 1);
  assert.equal(view.baseName, '20260816-K店-RQ5A-新品种草-紫菜卷');
  db.close();
}

// ── 路由源码契约 ──
{
  const postSource = readFileSync(new URL('../app/api/projects/route.ts', import.meta.url), 'utf8');
  assert.match(postSource, /parseProductionIdentityInput\(body\)/);
  assert.match(postSource, /formatShanghaiIdentityDate\(new Date\(\)\)/);
  assert.match(postSource, /resolveUniqueProjectBaseName/);
  assert.match(postSource, /validateImageAspectRatio\(model, body\.aspectRatio\)/, '项目创建必须校验模型支持的图片比例');
  assert.match(postSource, /resolveGptImage2Size\(body\.aspectRatio, body\.resolution \|\| '1k'\)/, '图片比例与清晰度必须解析成目标尺寸');
  assert.ok(!/body\.name\s*\|\|/.test(postSource), 'POST 不得把客户端 name 写入项目名');

  // 回归：项目字段名和绑定参数必须保持同一列顺序。
  // 旧代码把 resolvedSize 绑定到了 prompt，size 反而为空，项目详情因此出现
  // 一个用户不想要的「1024x1024」提示词。
  const projectInsertBlock = postSource.slice(
    postSource.indexOf('INSERT INTO projects'),
    postSource.indexOf('if (hasFullCreation)'),
  );
  assert.match(
    projectInsertBlock,
    /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/,
    '项目创建必须用完整占位符，避免静态空值让绑定参数错位',
  );
  assert.match(
    projectInsertBlock,
    /\.run\(projectId, baseName, '', identity\.productCode, '', body\.providerId, model, '', '', resolvedSize, quality, concurrency, maxAttempts, 'draft', 'none', timeoutMs, 'complex_product'/,
    'prompt 必须为空，resolvedSize 必须绑定到 size，项目状态必须是 draft',
  );

  const patchSource = readFileSync(new URL('../app/api/projects/[id]/route.ts', import.meta.url), 'utf8');
  assert.match(patchSource, /parseProductionIdentityUpdate\(body\)/);
  assert.match(patchSource, /export_identity_frozen/);
  assert.match(patchSource, /ENABLE_NEW_EXPORT_IDENTITY_KEY/, '路由必须通过共享常量读取确认字段，与弹窗共用同一契约');
  assert.match(patchSource, /createExportIdentity/);
  assert.match(patchSource, /activateNewExportIdentity/);
  assert.match(patchSource, /projectHasProductionIdentity/);
}

console.log('project-production-identity-route tests passed');
