import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import ExcelJS from 'exceljs';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-public-resources-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-public-resources',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createTeamAccessContext, requireResourceAccess, registerRootScope, registerInheritedScope } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { importFinalEditBgmFiles } = await import('../lib/final-edit/bgm-import.ts');
const { readBatchBgmPool } = await import('../lib/batch-production/bgm.ts');
const { publishTeamResource } = await import('../lib/team-service/files/publication.ts');
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
const { getOrCreateCatalog, createCatalogRevision, getCatalogCurrentRevisionId, getCatalogRevision, listCatalogRevisions } = await import('../lib/script-studio/catalogs.ts');
const {
  getViralTemplateLibraryView, listViralTemplateEntries, getViralTemplateEntriesByIds,
  getOrCreateViralTemplateLibrary, findTeamViralTemplateLibrary, TEAM_VIRAL_TEMPLATE_OWNER_KEY,
} = await import('../lib/script-studio/viral-templates.ts');
const { publishTeamViralTemplate, getTeamViralTemplateView } = await import('../lib/script-studio/viral-templates-team.ts');

/** 生成一个可解析的爆文模板工作簿（A–M 列表头，单条可用模板）。 */
async function viralWorkbook(refText: string): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('全部模板');
  sheet.addRow(['类目', '子类目', '模板名称', '标题', '参考文案', '结构摘要', '模板ID']);
  sheet.addRow(['床', '实木床', '团队模板', '床的选择', refText, '钩子>卖点>结尾', 'tpl-team']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-public-resources', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.notEqual((await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'script-backups') })).state, 'compatibility_only');
const insertUser = db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
) VALUES (?, ?, ?, ?, 'active', 'test', 0, 1, '2026-11-02', '2026-11-02')`);
insertUser.run('admin', '0000', '管理员', 'admin');
insertUser.run('user-a', '0001', '甲', 'employee');
insertUser.run('user-b', '0002', '乙', 'employee');
insertUser.run('user-c', '0003', '丙', 'employee');
const principal = (userId: string, role: 'employee' | 'admin' = 'employee') => ({
  kind: 'user' as const, userId, employeeId: userId, displayName: userId, role,
  sessionId: `session-${userId}`, sessionVersion: 1, mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
});
const admin = principal('admin', 'admin');
const userA = principal('user-a');
const userB = principal('user-b');
const userC = principal('user-c');
const contextA = createTeamAccessContext({ db, principal: userA });
const contextB = createTeamAccessContext({ db, principal: userB });
const contextC = createTeamAccessContext({ db, principal: userC });
const contextAdmin = createTeamAccessContext({ db, principal: admin });
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
const upload = path.join(root, 'same.mp3');
fs.writeFileSync(upload, Buffer.from('same audio bytes'));
const deps = { db, storageRoot, probeDurationSec: async () => 2 };

try {
  const importedA = await runWithAccessContext(contextA, () => importFinalEditBgmFiles(deps, [
    { filename: 'same.mp3', mimeType: 'audio/mpeg', temporaryPath: upload, size: 16 },
  ]));
  const trackA = importedA.imported[0];
  assert.ok(trackA);
  assert.deepEqual(runWithAccessContext(contextB, () => readBatchBgmPool(db)), []);

  const importedB = await runWithAccessContext(contextB, () => importFinalEditBgmFiles(deps, [
    { filename: 'same.mp3', mimeType: 'audio/mpeg', temporaryPath: upload, size: 16 },
  ]));
  const trackB = importedB.imported[0];
  assert.ok(trackB);
  assert.notEqual(trackA.id, trackB.id);
  assert.equal(runWithAccessContext(contextA, () => readBatchBgmPool(db)).length, 1);
  assert.equal(runWithAccessContext(contextB, () => readBatchBgmPool(db)).length, 1);
  assert.throws(() => contextA.authorizeFileRead!(path.join(storageRoot, trackB.relativePath)), /不存在或不可用/);
  assert.ok(contextB.authorizeFileRead!(path.join(storageRoot, trackB.relativePath)).fileId);

  publishTeamResource(db, admin, { resourceType: 'bgm', resourceId: trackB.id });
  assert.ok(contextA.authorizeFileRead!(path.join(storageRoot, trackB.relativePath)).fileId);
  assert.equal(runWithAccessContext(contextA, () => readBatchBgmPool(db)).length, 2);
  assert.throws(() => requireResourceAccess(db, userA, 'bgm', trackB.id, 'write'), /无权/);
  assert.throws(() => publishTeamResource(db, userA, { resourceType: 'bgm', resourceId: trackA.id }), /管理员/);

  const catalogA = runWithAccessContext(contextA, () => getOrCreateCatalog(db, 'template'));
  const catalogB = runWithAccessContext(contextB, () => getOrCreateCatalog(db, 'template'));
  assert.notEqual(catalogA.id, catalogB.id);
  const revisionA = runWithAccessContext(contextA, () => createCatalogRevision(db, {
    catalogId: catalogA.id, sourceFilename: 'same.xlsx', sourceSha256: 'same-hash', importReport: {},
  })).revisionId;
  const revisionB = runWithAccessContext(contextB, () => createCatalogRevision(db, {
    catalogId: catalogB.id, sourceFilename: 'same.xlsx', sourceSha256: 'same-hash', importReport: {},
  })).revisionId;
  assert.notEqual(revisionA, revisionB);
  assert.equal(runWithAccessContext(contextA, () => getCatalogCurrentRevisionId(db, 'template')), revisionA);
  assert.equal(runWithAccessContext(contextB, () => getCatalogCurrentRevisionId(db, 'template')), revisionB);
  assert.throws(() => runWithAccessContext(contextA, () => getCatalogRevision(db, revisionB)), /无权/);
  const revisionBPublic = runWithAccessContext(contextB, () => createCatalogRevision(db, {
    catalogId: catalogB.id, sourceFilename: 'public.xlsx', sourceSha256: 'public-hash', importReport: {},
  })).revisionId;
  publishTeamResource(db, admin, { resourceType: 'script_catalog', resourceId: catalogB.id });
  publishTeamResource(db, admin, { resourceType: 'script_catalog_revision', resourceId: revisionBPublic });
  assert.equal(runWithAccessContext(contextC, () => getCatalogCurrentRevisionId(db, 'template')), revisionBPublic);
  assert.deepEqual(
    runWithAccessContext(contextA, () => listCatalogRevisions(db, catalogB.id)).map((revision) => revision.id),
    [revisionBPublic],
    '公开当前修订不得连带暴露私人历史修订',
  );
  assert.throws(() => runWithAccessContext(contextA, () => getCatalogRevision(db, revisionB)), /无权/);
  assert.equal(runWithAccessContext(contextA, () => getCatalogRevision(db, revisionBPublic))?.id, revisionBPublic);
  assert.throws(() => requireResourceAccess(db, userA, 'script_catalog_revision', revisionBPublic, 'write'), /无权/);

  // 爆文模板：团队公共库有唯一显式身份；员工（无个人库/空库/非空库）都读同一团队当前版本，
  // 个人库永不遮住团队版本；读请求不创建员工私人库。
  assert.throws(() => runWithAccessContext(contextA, () => getOrCreateViralTemplateLibrary(db)), /员工|无权|不能/,
    '员工不得创建私人爆文模板库');
  const seedLegacyViralLibrary = (ownerUserId: string, libraryId: string, revisionId: string, withEntry: boolean) => {
    db.prepare(`INSERT INTO script_studio_viral_tpl_libraries (id, currentRevisionId, ownerKey, createdAt, updatedAt)
      VALUES (?, NULL, ?, '2026-10-01', '2026-10-01')`).run(libraryId, ownerUserId);
    registerRootScope(db, { resourceType: 'viral_template_library', resourceId: libraryId, ownerUserId, visibility: 'private' });
    if (!withEntry) return;
    db.prepare(`INSERT INTO script_studio_viral_tpl_revisions
        (id, libraryId, revisionNumber, sourceFilename, sourceSha256, importReportJson, createdAt)
      VALUES (?, ?, 1, '个人历史.xlsx', ?, '{}', '2026-10-01')`).run(revisionId, libraryId, `sha-${libraryId}`);
    registerInheritedScope(db, {
      resourceType: 'viral_template_revision', resourceId: revisionId,
      parent: { resourceType: 'viral_template_library', resourceId: libraryId }, visibility: 'private',
    });
    db.prepare(`INSERT INTO script_studio_viral_tpl_entries
        (id, revisionId, sourceTemplateId, name, refText, contentHash, status, statusReason, statusUpdatedBy, createdAt)
      VALUES (?, ?, 'tpl-personal', '私人草稿', '标题：私人草稿\n正文：只属于该员工自己的文案内容。', 'h', 'usable', '', 'import', '2026-10-01')`)
      .run(`${revisionId}-entry`, revisionId);
    registerInheritedScope(db, {
      resourceType: 'viral_template_entry', resourceId: `${revisionId}-entry`,
      parent: { resourceType: 'viral_template_revision', resourceId: revisionId }, visibility: 'private',
    });
    db.prepare('UPDATE script_studio_viral_tpl_libraries SET currentRevisionId = ? WHERE id = ?').run(revisionId, libraryId);
  };
  seedLegacyViralLibrary('user-a', 'legacy-viral-lib-a', 'legacy-viral-rev-a', true);
  seedLegacyViralLibrary('user-b', 'legacy-viral-lib-b', 'legacy-viral-rev-b', false);

  const teamViralBuffer = await viralWorkbook('标题：团队模板\n正文：这是管理员发布的团队公共模板文案。');
  const teamViral = await runWithAccessContext(contextAdmin, () => publishTeamViralTemplate(db, {
    buffer: teamViralBuffer,
    sourceFilename: '团队爆文库.xlsx',
    baseRevisionId: null,
  }));
  assert.equal(teamViral.created, true);
  const viralTeamLibrary = findTeamViralTemplateLibrary(db);
  assert.equal(viralTeamLibrary?.id, teamViral.libraryId);
  assert.equal(viralTeamLibrary?.ownerKey, TEAM_VIRAL_TEMPLATE_OWNER_KEY);

  // 无个人库（user-c）、空个人库（user-b）、非空个人库（user-a）都读到同一团队当前版本。
  for (const [label, context] of [['user-a', contextA], ['user-b', contextB], ['user-c', contextC]] as const) {
    const view = runWithAccessContext(context, () => getViralTemplateLibraryView(db));
    assert.equal(view.library?.id, teamViral.libraryId, `${label} 必须读到同一团队当前版本`);
    assert.equal(view.source, 'team');
    assert.equal(view.current?.id, teamViral.revisionId);
    assert.equal(runWithAccessContext(context, () => listViralTemplateEntries(db, { status: 'usable' })).length, 1);
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM script_studio_viral_tpl_libraries WHERE ownerKey = 'user-c'").pluck().get(),
    0,
    '读请求不得为员工创建空私人库',
  );
  assert.throws(() => runWithAccessContext(contextC, () => getViralTemplateEntriesByIds(db, ['legacy-viral-rev-a-entry'])), /无权|不存在/,
    '员工私人未发布条目仍不可读');
  await assert.rejects(
    () => runWithAccessContext(contextA, () => publishTeamViralTemplate(db, { revisionId: 'legacy-viral-rev-a', baseRevisionId: teamViral.revisionId })),
    /管理员|无权|不存在/,
    '员工不能把个人修订发布给团队',
  );
  assert.equal(
    runWithAccessContext(contextAdmin, () => getTeamViralTemplateView(db)).revisions.length,
    1,
    '团队版本列表只含团队库自己的修订',
  );

  db.prepare("UPDATE final_edit_bgm_tracks SET status = 'failed', errorMessage = 'test failure' WHERE id = ?").run(trackA.id);
  const restored = await runWithAccessContext(contextA, () => importFinalEditBgmFiles(deps, [
    { filename: 'same.mp3', mimeType: 'audio/mpeg', temporaryPath: upload, size: 16 },
  ]));
  assert.equal(restored.imported[0]?.id, trackA.id, '失败曲目重导入必须复用原实体');
  assert.ok(contextA.authorizeFileRead!(path.join(storageRoot, restored.imported[0].relativePath)).fileId);
  console.log('PASS: same-hash isolation, independent public revisions, and failed BGM re-import registration');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
