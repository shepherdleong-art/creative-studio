import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import ExcelJS from 'exceljs';

/**
 * 团队公共爆文模板库（票 01）：上传 → 预览 → 原子发布 → 当前版本读取。
 *
 * 领域层合同测试，使用真实团队访问上下文（createTeamAccessContext）与真实
 * team_resource_scopes 权限链，不 mock assertAccess。覆盖：
 * - 团队库有明确唯一身份（哨兵 ownerKey），不是「管理员当前个人库」；
 * - 个人空库 / 个人非空库 / 无个人库的员工读到同一团队当前版本，且读请求不建库；
 * - 从既有修订发布 = 复制进团队库，私人历史不连带公开；
 * - 同内容幂等、历史版本重导明确激活、并发基准冲突可见；
 * - 解析失败 / 无可用条目 / 发布失败不改变旧版本；旧团队版本切走后仍可读；
 * - 员工不能导入、不能发布、不能切团队版本。
 */

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-viral-tpl-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3311',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-team-viral-tpl',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createTeamAccessContext, registerRootScope, registerInheritedScope } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
const {
  importViralTemplateLibrary,
  getViralTemplateLibraryView,
  listViralTemplateEntries,
  getViralTemplateEntriesByIds,
  recommendViralTemplates,
  setViralTemplateCurrentRevision,
  findTeamViralTemplateLibrary,
  TEAM_VIRAL_TEMPLATE_OWNER_KEY,
} = await import('../lib/script-studio/viral-templates.ts');
const {
  publishTeamViralTemplate,
  getTeamViralTemplateView,
} = await import('../lib/script-studio/viral-templates-team.ts');
const { ScriptStudioError } = await import('../lib/script-studio/errors.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3311,
  deploymentId: 'deployment-team-viral-tpl', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const scriptSchema = await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'script-backups') });
assert.notEqual(scriptSchema.state, 'compatibility_only');

const insertUser = db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
) VALUES (?, ?, ?, ?, 'active', 'test', 0, 1, '2026-11-05', '2026-11-05')`);
insertUser.run('admin', '0000', '管理员', 'admin');
insertUser.run('user-a', '0001', '甲', 'employee');
insertUser.run('user-b', '0002', '乙', 'employee');
insertUser.run('user-c', '0003', '丙', 'employee');

const principal = (userId: string, role: 'employee' | 'admin' = 'employee') => ({
  kind: 'user' as const, userId, employeeId: userId, displayName: userId, role,
  sessionId: `session-${userId}`, sessionVersion: 1, mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
});
const contextAdmin = createTeamAccessContext({ db, principal: principal('admin', 'admin') });
const contextA = createTeamAccessContext({ db, principal: principal('user-a') });
const contextB = createTeamAccessContext({ db, principal: principal('user-b') });
const contextC = createTeamAccessContext({ db, principal: principal('user-c') });

const HEADER = ['类目', '子类目', '模板名称', '标题', '参考文案', '结构拆解', '结构摘要', '素材类型', '使用次数', '逛逛ID', '商品链接', '模板ID', '是否私有', '脚本编号'];

function tplRow(overrides: Record<string, string>): string[] {
  const row: Record<string, string> = {
    类目: '床', 子类目: '实木床', 模板名称: '模板', 标题: '标题', 参考文案: '标题：x\n正文：y',
    结构拆解: '', 结构摘要: '', 素材类型: '', 使用次数: '0', 逛逛ID: '1', 商品链接: '', 模板ID: 'tpl1', 是否私有: '否',
    ...overrides,
  };
  return HEADER.map((header) => row[header] ?? '');
}

async function workbook(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('全部模板');
  sheet.addRow(HEADER);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const v1 = await workbook([
  tplRow({ 模板ID: 'tpl-a', 脚本编号: 'J1', 模板名称: '实木床爆款', 标题: '实木床真香', 参考文案: '标题：实木床真香\n正文：整块实木框架，睡十年都不塌。', 结构摘要: '钩子>痛点>卖点>逼单' }),
  tplRow({ 模板ID: 'tpl-b', 模板名称: '占位模板', 参考文案: '测试文本' }),
  tplRow({ 模板ID: 'tpl-f', 模板名称: '短字幕模板', 参考文案: '标题：可旋转升降\n正文：适配不同场景' }),
]);
const v2 = await workbook([
  tplRow({ 模板ID: 'tpl-a', 脚本编号: 'J1', 模板名称: '实木床爆款', 标题: '实木床真香', 参考文案: '标题：实木床真香\n正文：整块实木框架加静音床板，睡十年不塌。', 结构摘要: '钩子>痛点>卖点>逼单' }),
  tplRow({ 模板ID: 'tpl-c', 模板名称: '沙发模板', 类目: '沙发', 参考文案: '标题：坐下来就不想起来\n正文：坐深 60 公分，整个人陷进去。' }),
]);
const personalDraft = await workbook([
  tplRow({ 模板ID: 'tpl-personal', 模板名称: '私人草稿', 参考文案: '标题：私人草稿标题\n正文：只属于甲自己的测试文案内容。' }),
]);
const broken = Buffer.from('not an xlsx workbook at all', 'utf8');
const noUsable = await workbook([tplRow({ 模板ID: 'tpl-empty', 参考文案: '测试文本' })]);

function libraryRows(): Array<{ id: string; ownerKey: string; currentRevisionId: string | null }> {
  return db.prepare('SELECT id, ownerKey, currentRevisionId FROM script_studio_viral_tpl_libraries ORDER BY createdAt, id')
    .all() as Array<{ id: string; ownerKey: string; currentRevisionId: string | null }>;
}

/** 管理视图是管理员入口，必须在真实管理员访问上下文里读（fail closed）。 */
function adminView() {
  return runWithAccessContext(contextAdmin, () => getTeamViralTemplateView(db));
}

/** 模拟本轮修复前已存在的员工私人模板库（历史数据，不经过新的导入权限）。 */
function seedLegacyPersonalLibrary(ownerUserId: string, options: { revisionId: string; libraryId: string; withEntry: boolean }): void {
  db.prepare(`INSERT INTO script_studio_viral_tpl_libraries (id, currentRevisionId, ownerKey, createdAt, updatedAt)
    VALUES (?, NULL, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run(options.libraryId, ownerUserId);
  registerRootScope(db, {
    resourceType: 'viral_template_library', resourceId: options.libraryId,
    ownerUserId, visibility: 'private',
  });
  if (!options.withEntry) return;
  db.prepare(`INSERT INTO script_studio_viral_tpl_revisions
      (id, libraryId, revisionNumber, sourceFilename, sourceSha256, importReportJson, createdAt)
    VALUES (?, ?, 1, '个人历史.xlsx', ?, '{}', '2026-10-01T00:00:00.000Z')`)
    .run(options.revisionId, options.libraryId, `legacy-sha-${options.libraryId}`);
  registerInheritedScope(db, {
    resourceType: 'viral_template_revision', resourceId: options.revisionId,
    parent: { resourceType: 'viral_template_library', resourceId: options.libraryId }, visibility: 'private',
  });
  db.prepare(`INSERT INTO script_studio_viral_tpl_entries
      (id, revisionId, sourceTemplateId, category, subCategory, name, title, refText,
       structureRaw, structureSummary, structure, structureOrigin, rawColumnsJson,
       sourceSheet, sourceRow, sourceFileSha256, contentHash, status, statusReason, statusUpdatedBy, createdAt)
    VALUES (?, ?, 'tpl-personal', '床', '实木床', '私人草稿', '私人草稿', '标题：私人草稿标题\n正文：只属于甲自己的测试文案内容。',
       '', '', '钩子>痛点>卖点>逼单', 'fallback', '{}', '全部模板', 2, ?, 'legacy-hash', 'usable', '', 'import', '2026-10-01T00:00:00.000Z')`)
    .run(`${options.revisionId}-entry`, options.revisionId, `legacy-sha-${options.libraryId}`);
  registerInheritedScope(db, {
    resourceType: 'viral_template_entry', resourceId: `${options.revisionId}-entry`,
    parent: { resourceType: 'viral_template_revision', resourceId: options.revisionId }, visibility: 'private',
  });
  db.prepare('UPDATE script_studio_viral_tpl_libraries SET currentRevisionId = ? WHERE id = ?')
    .run(options.revisionId, options.libraryId);
}

try {
  // ---- 1. 发布前：团队没有版本，员工读请求返回真实空状态且不建私人库 ----
  assert.equal(findTeamViralTemplateLibrary(db), null, '发布前不存在团队模板库');
  const beforePublish = runWithAccessContext(contextC, () => getViralTemplateLibraryView(db));
  assert.equal(beforePublish.library, null, '团队模式读请求在无团队版本时不得创建员工私人库');
  assert.equal(beforePublish.source, null);
  assert.equal(beforePublish.current, null);
  assert.deepEqual(beforePublish.revisions, []);
  assert.deepEqual(libraryRows(), [], '员工读请求不得写入任何库行');
  assert.deepEqual(runWithAccessContext(contextC, () => listViralTemplateEntries(db)), []);
  const emptyRecommend = runWithAccessContext(contextC, () => recommendViralTemplates(db, { sellingPointTexts: ['实木框架'] }));
  assert.equal(emptyRecommend.recommendations.length, 0);
  assert.equal(emptyRecommend.usableCount, 0);
  assert.equal(emptyRecommend.hasCurrentRevision, false, '推荐接口必须如实报告团队没有当前版本');
  assert.equal(emptyRecommend.librarySource, null);

  // ---- 2. 员工不能导入 / 不能发布 ----
  await assert.rejects(
    () => runWithAccessContext(contextA, () => importViralTemplateLibrary(db, personalDraft, '员工导入.xlsx')),
    (error: unknown) => error instanceof ScriptStudioError && error.code === 'forbidden',
    '员工在团队模式不能导入私人爆文模板库',
  );
  await assert.rejects(
    () => runWithAccessContext(contextA, () => publishTeamViralTemplate(db, { buffer: v1, sourceFilename: 'v1.xlsx' })),
    (error: unknown) => error instanceof ScriptStudioError && error.code === 'forbidden',
    '员工调用团队发布必须被拒绝',
  );
  assert.deepEqual(libraryRows(), [], '被拒绝的导入/发布不得留下任何库行');

  // ---- 3. 管理员从上传文件原子发布 ----
  const first = await runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
    buffer: v1, sourceFilename: '种草爆文库_v1.xlsx', baseRevisionId: null,
  }));
  assert.equal(first.created, true);
  assert.equal(first.activated, true);
  assert.equal(first.revisionNumber, 1);
  assert.equal(first.report.canActivate, true);
  assert.equal(first.report.statusCounts.usable, 2, '发布报告沿用真实解析结果');

  const teamLibrary = findTeamViralTemplateLibrary(db);
  assert.ok(teamLibrary, '发布后存在团队模板库');
  assert.equal(teamLibrary.ownerKey, TEAM_VIRAL_TEMPLATE_OWNER_KEY, '团队库用明确哨兵身份，不是某个员工的个人库');
  assert.equal(teamLibrary.currentRevisionId, first.revisionId);
  assert.deepEqual(libraryRows().map((row) => row.ownerKey), [TEAM_VIRAL_TEMPLATE_OWNER_KEY], '发布不得创建个人库');

  // ---- 4. 员工读到同一团队版本（无个人库 / 个人空库 / 个人非空库） ----
  const viewA0 = runWithAccessContext(contextA, () => getViralTemplateLibraryView(db));
  assert.equal(viewA0.library?.id, teamLibrary.id);
  assert.equal(viewA0.source, 'team');
  assert.equal(viewA0.canManage, false, '员工不可管理团队版本');
  assert.equal(viewA0.current?.id, first.revisionId);
  assert.equal(viewA0.current?.entryCounts.total, 3);
  assert.equal(viewA0.current?.entryCounts.usable, 2);
  assert.equal(runWithAccessContext(contextA, () => listViralTemplateEntries(db, { status: 'usable' })).length, 2);

  // user-b：历史数据里已有一个空的个人库（旧缺陷里它会遮住公共库）
  seedLegacyPersonalLibrary('user-b', { libraryId: 'legacy-lib-b', revisionId: 'legacy-rev-b', withEntry: false });
  const viewB = runWithAccessContext(contextB, () => getViralTemplateLibraryView(db));
  assert.equal(viewB.library?.id, teamLibrary.id, '个人空库不得遮住团队当前版本');
  assert.equal(viewB.current?.id, first.revisionId);
  assert.equal(runWithAccessContext(contextB, () => listViralTemplateEntries(db, { status: 'usable' })).length, 2);

  // user-c：无个人库，直接读工作台
  const viewC = runWithAccessContext(contextC, () => getViralTemplateLibraryView(db));
  assert.equal(viewC.library?.id, teamLibrary.id);
  assert.equal(libraryRows().filter((row) => row.ownerKey === 'user-c').length, 0, '读请求仍然不得为员工建库');

  // user-a：历史数据里已有非空个人库
  seedLegacyPersonalLibrary('user-a', { libraryId: 'legacy-lib-a', revisionId: 'legacy-rev-a', withEntry: true });
  const viewA = runWithAccessContext(contextA, () => getViralTemplateLibraryView(db));
  assert.equal(viewA.library?.id, teamLibrary.id, '个人非空库不得遮住团队当前版本');
  assert.equal(viewA.current?.id, first.revisionId);
  assert.equal(viewA.revisions.length, 1, '员工只看团队当前版本，不列私人历史');
  assert.deepEqual(
    runWithAccessContext(contextA, () => listViralTemplateEntries(db, { status: 'all' })).map((entry) => entry.sourceTemplateId).sort(),
    ['tpl-a', 'tpl-b', 'tpl-f'],
    '员工搜索只看到团队当前版本',
  );
  assert.equal(runWithAccessContext(contextB, () => listViralTemplateEntries(db, { status: 'all' })).length, 3, '同事看不到甲的私人草稿');
  await assert.rejects(
    () => runWithAccessContext(contextB, () => importViralTemplateLibrary(db, personalDraft, '乙导入.xlsx')),
    /无|不能|管理员|团队/,
    '员工不能导入私人模板库',
  );
  assert.throws(
    () => runWithAccessContext(contextC, () => getViralTemplateEntriesByIds(db, ['legacy-rev-a-entry'])),
    /无权|不存在/,
    '私人未发布条目必须不可读',
  );

  // ---- 5. 发布后团队公共推荐与详情可读 ----
  const recommendations = runWithAccessContext(contextB, () => recommendViralTemplates(db, {
    sellingPointTexts: ['实木框架 用料扎实'], productCategory: '床',
  }));
  assert.ok(recommendations.recommendations.length > 0);
  assert.equal(recommendations.recommendations[0]!.entry.sourceTemplateId, 'tpl-a');
  assert.equal(recommendations.hasCurrentRevision, true);
  assert.equal(recommendations.librarySource, 'team');
  const teamEntryId = runWithAccessContext(contextB, () => listViralTemplateEntries(db, { status: 'usable' }))[0]!.id;
  assert.equal(runWithAccessContext(contextB, () => getViralTemplateEntriesByIds(db, [teamEntryId]))[0]!.id, teamEntryId);

  // ---- 6. 同内容重复提交幂等 ----
  const replay = await runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
    buffer: v1, sourceFilename: 'v1-again.xlsx', baseRevisionId: first.revisionId,
  }));
  assert.equal(replay.created, false, '同内容不产生重复团队版本');
  assert.equal(replay.activated, false, '已是指向的当前版本时不再切指针');
  assert.equal(replay.revisionId, first.revisionId);
  assert.equal(adminView().revisions.length, 1);

  // ---- 7. 新内容发布替换当前版本，旧版本保留读取 ----
  const second = await runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
    buffer: v2, sourceFilename: '种草爆文库_v2.xlsx', baseRevisionId: first.revisionId,
  }));
  assert.equal(second.created, true);
  assert.equal(second.revisionNumber, 2);
  const currentAfterV2 = runWithAccessContext(contextB, () => getViralTemplateLibraryView(db));
  assert.equal(currentAfterV2.current?.id, second.revisionId);
  assert.deepEqual(currentAfterV2.revisions.map((revision) => revision.id), [second.revisionId], '员工只看到当前团队版本');
  assert.deepEqual(
    runWithAccessContext(contextB, () => listViralTemplateEntries(db, { status: 'all' })).map((entry) => entry.sourceTemplateId).sort(),
    ['tpl-a', 'tpl-c'],
  );
  const oldSnapshot = runWithAccessContext(contextB, () => getViralTemplateEntriesByIds(db, [teamEntryId]));
  assert.equal(oldSnapshot[0]?.refText.includes('睡十年都不塌'), true, '旧团队版本条目仍可读（历史任务/断连重试）');
  assert.equal(
    runWithAccessContext(contextB, () => listViralTemplateEntries(db, { revisionId: first.revisionId, status: 'all' })).length,
    3,
    '旧团队版本条目保留',
  );

  // ---- 8. 并发发布基准冲突可见 ----
  await assert.rejects(
    () => runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
      buffer: v1, sourceFilename: 'v1-stale.xlsx', baseRevisionId: first.revisionId,
    })),
    (error: unknown) => error instanceof ScriptStudioError && error.code === 'conflict',
    '基准版本过期必须报冲突，不能无提示覆盖',
  );
  assert.equal(adminView().current?.id, second.revisionId, '冲突发布不改变当前团队版本');
  assert.equal(adminView().revisions.length, 2, '冲突发布不新增团队版本');

  // ---- 9. 解析失败 / 无可用条目不改变旧版本 ----
  await assert.rejects(
    () => runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
      buffer: broken, sourceFilename: 'bad.xlsx', baseRevisionId: second.revisionId,
    })),
  );
  await assert.rejects(
    () => runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
      buffer: noUsable, sourceFilename: 'empty.xlsx', baseRevisionId: second.revisionId,
    })),
    (error: unknown) => error instanceof ScriptStudioError && error.code === 'invalid_input',
    '没有任何可用条目的文件不得替换团队版本',
  );
  assert.equal(adminView().current?.id, second.revisionId);
  assert.equal(runWithAccessContext(contextC, () => listViralTemplateEntries(db, { status: 'all' })).length, 2);

  // ---- 10. 历史版本重导明确激活 ----
  const reactivated = await runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
    buffer: v1, sourceFilename: 'v1.xlsx', baseRevisionId: second.revisionId,
  }));
  assert.equal(reactivated.created, false);
  assert.equal(reactivated.activated, true, '旧内容重导必须明确激活该版本，而不是只回 created:false');
  assert.equal(reactivated.revisionId, first.revisionId);
  assert.equal(runWithAccessContext(contextB, () => getViralTemplateLibraryView(db)).current?.id, first.revisionId);

  // ---- 11. 从既有修订发布（无需重新上传文件） ----
  // 规格 §3「不能公开员工的私人历史资源」：admin 的 assertAccess 无条件放行，
  // 所以发布路径必须自己按 ownerKey 判归属。user-a 的私人修订对管理员不可发布。
  await assert.rejects(
    () => runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
      revisionId: 'legacy-rev-a', baseRevisionId: first.revisionId,
    })),
    (error: unknown) => error instanceof ScriptStudioError && error.code === 'not_found',
    '管理员不得发布他人的私人修订',
  );
  // 候选列表同样不得列出他人的私人修订。
  assert.equal(
    adminView().candidates.some((candidate) => candidate.revisionId === 'legacy-rev-a'),
    false,
    '他人的私人修订不得出现在管理员的候选列表里',
  );
  // 管理员发布**自己**的私人修订仍然可用（正则路径不能被误伤）。
  seedLegacyPersonalLibrary('admin', { libraryId: 'legacy-lib-admin', revisionId: 'legacy-rev-admin', withEntry: true });
  const fromRevision = await runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
    revisionId: 'legacy-rev-admin', baseRevisionId: first.revisionId,
  }));
  assert.equal(fromRevision.created, true);
  assert.equal(fromRevision.revisionNumber, 3);
  assert.equal(adminView().current?.id, fromRevision.revisionId);
  assert.deepEqual(
    runWithAccessContext(contextC, () => listViralTemplateEntries(db, { status: 'all' })).map((entry) => entry.sourceTemplateId),
    ['tpl-personal'],
    '发布的是选定修订的条目',
  );
  // 甲的私人库历史仍隔离：同事既看不到库也搜不到条目。
  assert.equal(libraryRows().filter((row) => row.ownerKey === 'user-a').length, 1, '发布不搬走也不新建个人库');
  assert.throws(
    () => runWithAccessContext(contextB, () => listViralTemplateEntries(db, { revisionId: 'legacy-rev-a', status: 'all' })),
    /无权|不存在/,
    '私人修订切走后仍不可读',
  );

  // ---- 12. 团队版本列表按文件名 / 版本 / 条目数可识别 ----
  const teamView = adminView();
  assert.equal(teamView.current?.id, fromRevision.revisionId);
  assert.deepEqual(teamView.revisions.map((revision) => revision.revisionNumber), [3, 2, 1]);
  assert.deepEqual(
    teamView.revisions.map((revision) => revision.sourceFilename),
    ['个人历史.xlsx', '种草爆文库_v2.xlsx', '种草爆文库_v1.xlsx'],
  );
  assert.deepEqual(teamView.revisions.map((revision) => revision.entryCount), [1, 2, 3]);
  assert.deepEqual(teamView.revisions.map((revision) => revision.current), [true, false, false]);
  assert.ok(
    teamView.candidates.some((candidate) => candidate.revisionId === 'legacy-rev-admin' && candidate.libraryOwner === 'personal'),
    '管理员本人的既有私人修订作为候选版本出现在发布入口',
  );
  assert.equal(
    teamView.candidates.some((candidate) => candidate.revisionId === 'legacy-rev-a'),
    false,
    '他人（user-a）的私人修订不得作为候选出现',
  );

  // ---- 13. 员工不能切团队版本；管理员可以 ----
  assert.throws(
    () => runWithAccessContext(contextB, () => setViralTemplateCurrentRevision(db, first.revisionId)),
    (error: unknown) => error instanceof ScriptStudioError && error.code === 'forbidden',
    '员工不得切换团队当前版本',
  );
  assert.equal(adminView().current?.id, fromRevision.revisionId);
  const switched = runWithAccessContext(contextAdmin, () => setViralTemplateCurrentRevision(db, first.revisionId));
  assert.equal(switched.currentRevisionId, first.revisionId);
  assert.equal(runWithAccessContext(contextB, () => getViralTemplateLibraryView(db)).current?.id, first.revisionId);

  console.log('PASS: team viral template atomic publish, identity, read parity, idempotency, conflict and history');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
