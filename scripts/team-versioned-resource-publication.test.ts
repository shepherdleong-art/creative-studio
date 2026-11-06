import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NextRequest } from 'next/server.js';
import ExcelJS from 'exceljs';

// 通过真实上传、候选发布和员工读取接口验收完整版本，不调用生成供应商。
const repoRoot = path.resolve(import.meta.dirname, '..');
const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
interface ResolvedModule { url: string; format?: string | null; shortCircuit?: boolean }
type NextResolve = (specifier: string, context?: unknown) => ResolvedModule;
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base : extensions.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
        if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
        if (!specifier.startsWith('/')) return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-versioned-publication-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-versioned-publication',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-versioned-publication', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.notEqual((await (await import('../lib/script-studio/schema.ts')).ensureScriptStudioSchemaReady({
  db, backupRoot: path.join(root, 'script-backups'),
})).state, 'compatibility_only');
const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams: { N: 1024, r: 8, p: 1 } });
const service = createTeamAuthService({ db, kdf, passwordParams: { N: 1024, r: 8, p: 1 } });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-versioned-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-versioned-password' });
const adminPrincipal = adminSession.principal;
async function employee(employeeId: string, displayName: string) {
  const created = await service.createUser(adminPrincipal, { employeeId, displayName, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-versioned-password`);
  const session = await service.login({ employeeId, password: `${employeeId}-versioned-password` });
  return { principal: session.principal, cookie: sessionCookie(session.token).split(';', 1)[0] };
}
const adminCookie = sessionCookie(adminSession.token).split(';', 1)[0];
const userA = await employee('0001', '员工甲');
const userB = await employee('0002', '员工乙');
const publicRoute = await import('../app/api/team/public-resources/route.ts');
const catalogsRoute = await import('../app/api/script-studio/catalogs/route.ts');
const catalogRevisionRoute = await import('../app/api/script-studio/catalogs/[catalogId]/revisions/[revisionId]/route.ts');
const catalogCurrentRoute = await import('../app/api/script-studio/catalogs/[catalogId]/current/route.ts');
const strategyImportRoute = await import('../app/api/script-studio/catalogs/strategy/import/route.ts');
const templateImportRoute = await import('../app/api/script-studio/catalogs/template/import/route.ts');
const viralRoute = await import('../app/api/script-studio/viral-templates/route.ts');
const viralImportRoute = await import('../app/api/script-studio/viral-templates/import/route.ts');
const viralCurrentRoute = await import('../app/api/script-studio/viral-templates/current/route.ts');
const viralEntriesRoute = await import('../app/api/script-studio/viral-templates/entries/route.ts');

function request(pathname: string, cookie: string, method = 'GET', body?: unknown) {
  return new NextRequest(`https://studio.example.test${pathname}`, {
    method,
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test',
      'x-csrf-token': 'csrf', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function upload(route: { POST: (request: NextRequest) => Promise<Response> }, pathname: string, cookie: string, buffer: Buffer, filename: string) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(buffer)], filename, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  return route.POST(new NextRequest(`https://studio.example.test${pathname}`, {
    method: 'POST', body: form,
    headers: { Cookie: `${cookie}; __Host-team_csrf=csrf`, Origin: 'https://studio.example.test', 'x-csrf-token': 'csrf' },
  }));
}
async function workbook(kind: 'strategy' | 'template' | 'viral', marker: string): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  if (kind === 'strategy') {
    const sheet = book.addWorksheet('产品策略');
    sheet.addRow(['产品信息']);
    sheet.addRow(['型号']);
    sheet.addRow(['统一名称', '品类心智', '主卖点', '差异化', '搜索词']);
    sheet.addRow([`MODEL-${marker}`, `产品${marker}`, '生活', '真实卖点', '材质差异', `搜索${marker}`]);
  } else if (kind === 'template') {
    const framework = book.addWorksheet('脚本核心框架');
    framework.addRow(['视频类型', '核心结构', '适用产品', '首选钩子']);
    framework.addRow([`01 ${marker}框架`, '痛点+解决', '全品类', '痛点式']);
    const copy = book.addWorksheet('开头钩子文案');
    copy.addRow(['钩子类型', '核心机制', '公式', '文案示例']);
    copy.addRow(['痛点式', '共鸣', `为什么${marker}`, `${marker}示例`]);
    const visual = book.addWorksheet('开头钩子画面（待优化）');
    visual.addRow(['核心玩法', '裂变玩法', '画面公式', '适用品类', '搭配钩子']);
    visual.addRow(['实拍', `${marker}画面`, '产品→细节', '全品类', '痛点式']);
  } else {
    const sheet = book.addWorksheet('全部模板');
    sheet.addRow(['类目', '子类目', '模板名称', '标题', '参考文案', '结构拆解', '结构摘要', '模板ID', '是否私有', '脚本编号']);
    sheet.addRow(['床', '实木床', `${marker}爆文`, `${marker}标题`, `标题：${marker}\n正文：真实展示整块实木框架与静音床板，使用体验具体可信。`, '', '钩子>卖点>行动', `tpl-${marker}`, '否', 'J1']);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
interface Candidate {
  resourceType: string; resourceId: string; typeLabel: string; name: string;
  revisionNumber: number; sourceFilename: string; entryCount: number;
  parseStatus: string; preview: string; published: boolean; currentRevisionId: string | null;
}
async function candidates() {
  const response = await publicRoute.GET(request('/api/team/public-resources', adminCookie));
  assert.equal(response.status, 200);
  return (await response.json() as { candidates: Candidate[] }).candidates.filter((item) => ['script_catalog_revision', 'viral_template_revision'].includes(item.resourceType));
}
async function publish(candidate: Candidate, baseRevisionId: string | null = candidate.currentRevisionId) {
  return publicRoute.POST(request('/api/team/public-resources', adminCookie, 'POST', {
    resourceType: candidate.resourceType, resourceId: candidate.resourceId, baseRevisionId,
  }));
}
async function employeeRevision(cookie: string, catalogId: string, revisionId: string) {
  const response = await catalogRevisionRoute.GET(request(`/api/script-studio/catalogs/${catalogId}/revisions/${revisionId}`, cookie), {
    params: Promise.resolve({ catalogId, revisionId }),
  });
  return { response, body: await response.json() as { revision?: { id: string; strategyEntries: unknown[]; frameworkTemplates: unknown[]; copyHookTemplates: unknown[]; visualHookTemplates: unknown[] } } };
}

try {
  for (const kind of ['strategy', 'template', 'viral'] as const) {
    const route = kind === 'strategy' ? strategyImportRoute : kind === 'template' ? templateImportRoute : viralImportRoute;
    const pathname = kind === 'viral' ? '/api/script-studio/viral-templates/import' : `/api/script-studio/catalogs/${kind}/import`;
    const denied = await upload(route, pathname, userA.cookie, await workbook(kind, '越权'), `${kind}-denied.xlsx`);
    assert.equal(denied.status, 403, `${kind}：员工不能导入公共版本`);
  }
  const imported = {} as Record<'strategy' | 'template' | 'viral', { catalogId?: string; libraryId?: string; revisionId: string; created: boolean }>;
  for (const kind of ['strategy', 'template', 'viral'] as const) {
    const route = kind === 'strategy' ? strategyImportRoute : kind === 'template' ? templateImportRoute : viralImportRoute;
    const pathname = kind === 'viral' ? '/api/script-studio/viral-templates/import' : `/api/script-studio/catalogs/${kind}/import`;
    const response = await upload(route, pathname, adminCookie, await workbook(kind, 'V1'), `${kind}-v1.xlsx`);
    assert.equal(response.status, 201, `${kind} 上传：${await response.clone().text()}`);
    imported[kind] = await response.json() as typeof imported[typeof kind];
  }
  const before = await catalogsRoute.GET(request('/api/script-studio/catalogs', userA.cookie));
  assert.equal(before.status, 200);
  assert.ok((await before.json() as { catalogs: Array<{ current: unknown }> }).catalogs.every((catalog) => catalog.current === null), '上传不能提前对员工生效');
  const emptyViral = await viralRoute.GET(request('/api/script-studio/viral-templates', userB.cookie));
  const emptyViralBody = await emptyViral.json() as { library: { id: string }; current: unknown; revisions: unknown[] };
  assert.equal(emptyViralBody.library.id, '', '无团队版本时不创建遮挡公共库的私人空库');
  assert.equal(emptyViralBody.current, null);
  assert.deepEqual(emptyViralBody.revisions, []);
  assert.deepEqual((await (await viralEntriesRoute.GET(request('/api/script-studio/viral-templates/entries', userA.cookie))).json() as { entries: unknown[] }).entries, []);

  const initial = await candidates();
  assert.equal(initial.length, 3, '三类设置上传必须共用同一候选列表');
  for (const candidate of initial) {
    assert.equal(candidate.revisionNumber, 1);
    assert.equal(candidate.published, false);
    assert.equal(candidate.parseStatus, 'ready');
    assert.ok(candidate.entryCount > 0);
    assert.match(candidate.sourceFilename, /v1\.xlsx$/);
    assert.match(candidate.preview, /产品V1|V1框架|V1/);
    const targetRootId = candidate.resourceType === 'viral_template_revision' ? imported.viral.libraryId! : candidate.resourceId === imported.strategy.revisionId ? imported.strategy.catalogId! : imported.template.catalogId!;
    const privateDetail = await employeeRevision(userA.cookie, targetRootId, candidate.resourceId);
    assert.notEqual(privateDetail.response.status, 200, '员工不能提前读取私人未发布修订');
    const published = await publish(candidate);
    assert.equal(published.status, 200, `发布 ${candidate.typeLabel}：${await published.clone().text()}`);
    assert.equal((await published.json() as { alreadyPublished: boolean }).alreadyPublished, false);
    const detail = await employeeRevision(userB.cookie, targetRootId, candidate.resourceId);
    if (candidate.resourceType === 'script_catalog_revision') {
      assert.equal(detail.response.status, 200, `${candidate.typeLabel} 发布后员工可读实际条目`);
      const revision = detail.body.revision!;
      assert.equal(revision.strategyEntries.length + revision.frameworkTemplates.length + revision.copyHookTemplates.length + revision.visualHookTemplates.length > 0, true);
    }
  }
  const currentCatalogs = await catalogsRoute.GET(request('/api/script-studio/catalogs', userA.cookie));
  const currentBody = await currentCatalogs.json() as { catalogs: Array<{ kind: string; current: { id: string } }> };
  const { findTeamVersionedRoot } = await import('../lib/script-studio/team-publications.ts');
  if (!currentBody.catalogs.find((item) => item.kind === 'strategy')?.current) console.error('CURRENT_DEBUG', currentBody, db.prepare('SELECT * FROM script_studio_team_publications').all(), db.prepare("SELECT resourceType, resourceId, visibility, ownerUserId FROM team_resource_scopes WHERE resourceType IN ('script_catalog', 'script_catalog_revision')").all(), findTeamVersionedRoot(db, 'strategy'));
  assert.equal(currentBody.catalogs.find((item) => item.kind === 'strategy')?.current.id, imported.strategy.revisionId);
  assert.equal(currentBody.catalogs.find((item) => item.kind === 'template')?.current.id, imported.template.revisionId);
  const entries = await viralEntriesRoute.GET(request('/api/script-studio/viral-templates/entries?q=V1', userB.cookie));
  assert.equal(entries.status, 200);
  assert.equal((await entries.json() as { entries: Array<{ revisionId: string; name: string }> }).entries[0]?.revisionId, imported.viral.revisionId);
  for (const [route, pathname, body] of [
    [viralCurrentRoute, '/api/script-studio/viral-templates/current', { revisionId: imported.viral.revisionId }],
    [catalogCurrentRoute, `/api/script-studio/catalogs/${imported.strategy.catalogId}/current`, { revisionId: imported.strategy.revisionId }],
  ] as const) {
    const denied = await route.PUT(request(pathname, userA.cookie, 'PUT', body));
    assert.equal(denied.status, 403, '员工不能绕过候选接口切换公共版本');
  }
  console.log('PASS: three real uploads, candidates, complete publication and employee reads');

  // 通过既有领域创建另一名员工的私人非空库，再验证员工读取不会回退到它。
  const { createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
  const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
  const { getOrCreateCatalog, createCatalogRevision } = await import('../lib/script-studio/catalogs.ts');
  const personal = runWithAccessContext(createTeamAccessContext({ db, principal: userA.principal }), () => {
    const catalog = getOrCreateCatalog(db, 'strategy');
    return { catalogId: catalog.id, revisionId: createCatalogRevision(db, {
      catalogId: catalog.id, sourceFilename: 'personal.xlsx', sourceSha256: 'personal-strategy',
      importReport: {}, strategyEntries: [{ modelKey: 'PRIVATE', normalizedModelKey: 'private', canonicalName: '私人',
        categoryMindsetsJson: '[]', primarySellingPointsJson: '[]', differentiatorsJson: '[]', searchTermsJson: '[]', auxiliaryJson: '{}', sourceRowsJson: '[]', status: 'active' }],
    }).revisionId };
  });
  const stillTeam = await catalogsRoute.GET(request('/api/script-studio/catalogs', userA.cookie));
  assert.equal((await stillTeam.json() as { catalogs: Array<{ kind: string; current: { id: string } | null }> }).catalogs.find((item) => item.kind === 'strategy')?.current?.id, imported.strategy.revisionId);
  assert.equal(db.prepare('SELECT COUNT(*) FROM script_studio_viral_tpl_libraries WHERE ownerKey = ?').pluck().get(userB.principal.userId), 0, '员工读取没有创建个人空爆文库');

  const second = {} as Record<'strategy' | 'template' | 'viral', { revisionId: string }>;
  for (const kind of ['strategy', 'template', 'viral'] as const) {
    const route = kind === 'strategy' ? strategyImportRoute : kind === 'template' ? templateImportRoute : viralImportRoute;
    const pathname = kind === 'viral' ? '/api/script-studio/viral-templates/import' : `/api/script-studio/catalogs/${kind}/import`;
    const response = await upload(route, pathname, adminCookie, await workbook(kind, 'V2'), `${kind}-v2.xlsx`);
    assert.equal(response.status, 201);
    second[kind] = await response.json() as { revisionId: string };
  }
  const afterV2Upload = await catalogsRoute.GET(request('/api/script-studio/catalogs', userA.cookie));
  const afterV2Body = await afterV2Upload.json() as { catalogs: Array<{ kind: string; current: { id: string } }> };
  assert.equal(afterV2Body.catalogs.find((item) => item.kind === 'strategy')?.current.id, imported.strategy.revisionId, '上传 V2 不能替换团队 V1');
  assert.equal(afterV2Body.catalogs.find((item) => item.kind === 'template')?.current.id, imported.template.revisionId);
  assert.equal(db.prepare("SELECT visibility FROM team_resource_scopes WHERE resourceType = 'viral_template_revision' AND resourceId = ?").pluck().get(second.viral.revisionId), 'private', '上传 V2 即使库根已公开也只能形成私人待发布修订');
  assert.notEqual((await employeeRevision(userA.cookie, imported.strategy.catalogId!, second.strategy.revisionId)).response.status, 200, '员工不能读取上传后未发布的策略 V2');
  assert.notEqual((await employeeRevision(userA.cookie, imported.template.catalogId!, second.template.revisionId)).response.status, 200, '员工不能读取上传后未发布的模板 V2');
  const unpublishedEntries = await viralEntriesRoute.GET(request(`/api/script-studio/viral-templates/entries?revisionId=${second.viral.revisionId}`, userA.cookie));
  assert.notEqual(unpublishedEntries.status, 200, '员工不能提前读取未发布爆文条目');
  assert.equal((await (await viralEntriesRoute.GET(request('/api/script-studio/viral-templates/entries', userA.cookie))).json() as { entries: Array<{ revisionId: string }> }).entries[0]?.revisionId, imported.viral.revisionId);
  const afterV2Candidates = await candidates();
  assert.equal(afterV2Candidates.some((item) => item.resourceId === personal.revisionId), false, '其他账号的私人版本不能进入管理员候选');
  const crossAccountPublish = await publicRoute.POST(request('/api/team/public-resources', adminCookie, 'POST', { resourceType: 'script_catalog_revision', resourceId: personal.revisionId, baseRevisionId: null }));
  assert.equal(crossAccountPublish.status, 404, '伪造另一账号私人修订 ID 不能发布');
  assert.equal(db.prepare("SELECT visibility FROM team_resource_scopes WHERE resourceType = 'script_catalog_revision' AND resourceId = ?").pluck().get(personal.revisionId), 'private');
  for (const kind of ['strategy', 'template', 'viral'] as const) {
    const candidate = afterV2Candidates.find((item) => item.resourceId === second[kind].revisionId)!;
    assert.ok(candidate, '已上传的 V2 必须可从候选列表选择');
    const oldBase = kind === 'viral' ? imported.viral.revisionId : kind === 'strategy' ? imported.strategy.revisionId : imported.template.revisionId;
    const published = await publish(candidate, oldBase);
    assert.equal(published.status, 200, await published.clone().text());
    const repeat = await publish(candidate, oldBase);
    assert.equal(repeat.status, 200, '即使基准已旧，同一发布请求重试仍须幂等');
    assert.equal((await repeat.json() as { alreadyPublished: boolean }).alreadyPublished, true);
    const rollback = await publish(afterV2Candidates.find((item) => item.resourceId === oldBase)!, second[kind].revisionId);
    assert.equal(rollback.status, 200, '已存在但非当前版本必须真正激活，不能只按内容存在报完成');
    assert.equal((await rollback.json() as { alreadyPublished: boolean }).alreadyPublished, false);
  }
  console.log('PASS: private library precedence, V2 isolation, idempotency and existing revision activation');

  const thirdViral = await upload(viralImportRoute, '/api/script-studio/viral-templates/import', adminCookie, await workbook('viral', 'V3-独立内容'), 'viral-v3.xlsx');
  assert.equal(thirdViral.status, 201);
  const thirdViralBody = await thirdViral.json() as { revisionId: string };
  const stale = await publish((await candidates()).find((item) => item.resourceId === thirdViralBody.revisionId)!, second.viral.revisionId);
  assert.equal(stale.status, 409, '切换到不同目标时必须检测基准变化');
  const staleBody = await stale.json() as { error: string; message: string };
  assert.equal(staleBody.error, 'publication_conflict');
  assert.match(staleBody.message, /刷新/);
  assert.equal(db.prepare("SELECT currentRevisionId FROM script_studio_team_publications WHERE resourceType = 'viral'").pluck().get(), imported.viral.revisionId);
  assert.equal(db.prepare("SELECT visibility FROM team_resource_scopes WHERE resourceType = 'viral_template_revision' AND resourceId = ?").pluck().get(thirdViralBody.revisionId), 'private', '冲突不能留下半公开修订');
  for (const kind of ['strategy', 'template', 'viral'] as const) {
    const route = kind === 'strategy' ? strategyImportRoute : kind === 'template' ? templateImportRoute : viralImportRoute;
    const pathname = kind === 'viral' ? '/api/script-studio/viral-templates/import' : `/api/script-studio/catalogs/${kind}/import`;
    const failed = await upload(route, pathname, adminCookie, Buffer.from('not an xlsx'), `${kind}-broken.xlsx`);
    assert.notEqual(failed.status, 201);
    assert.notEqual(failed.status, 200);
  }
  assert.equal(db.prepare("SELECT currentRevisionId FROM script_studio_team_publications WHERE resourceType = 'viral'").pluck().get(), imported.viral.revisionId, '解析失败不改变团队当前版本');
  const preview = await upload(viralImportRoute, '/api/script-studio/viral-templates/import?mode=preview', adminCookie, await workbook('viral', 'CANCEL'), 'cancel.xlsx');
  assert.equal(preview.status, 200);
  assert.equal((await candidates()).some((item) => item.sourceFilename === 'cancel.xlsx'), false, '取消预览不能落库或进入候选');
  db.prepare('DELETE FROM team_resource_scopes WHERE resourceType = ? AND resourceId = ?').run('viral_template_entry', (db.prepare('SELECT id FROM script_studio_viral_tpl_entries WHERE revisionId = ? LIMIT 1').pluck().get(thirdViralBody.revisionId) as string));
  const failedPublication = await publish((await candidates()).find((item) => item.resourceId === thirdViralBody.revisionId)!, imported.viral.revisionId);
  assert.equal(failedPublication.status, 409, `必要条目权限缺失必须拒绝完整版本发布：${await failedPublication.clone().text()}`);
  assert.equal(db.prepare("SELECT currentRevisionId FROM script_studio_team_publications WHERE resourceType = 'viral'").pluck().get(), imported.viral.revisionId);
  assert.equal(db.prepare("SELECT visibility FROM team_resource_scopes WHERE resourceType = 'viral_template_revision' AND resourceId = ?").pluck().get(thirdViralBody.revisionId), 'private', '发布失败后新修订 scope 必须回滚');
  console.log('PASS: concurrent conflict, parse/cancel and atomic publication failures');

  // 创建接口只冻结输入并保存 queued；不启动供应商，重试读取同一快照。
  db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('fixture-provider', '零付费模拟', '', 'test-only', 'fixture-vision')").run();
  db.prepare("INSERT INTO script_providers (id, name, type, baseUrl, apiKey, model, apiStyle, enabled, supportsVision) VALUES ('fixture-script', '零付费模拟', 'openai-compatible', 'http://127.0.0.1:1', 'test-only', 'fixture-script', 'openai-compatible', 1, 1)").run();
  const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
  db.prepare("INSERT INTO projects (id, name, providerId, model, prompt, productCode) VALUES ('versioned-project', '版本快照项目', 'fixture-provider', 'fixture-vision', '', 'MODEL-V1')").run();
  registerRootScope(db, { resourceType: 'project', resourceId: 'versioned-project', ownerUserId: userA.principal.userId });
  const { getOrCreateViralTemplateLibrary } = await import('../lib/script-studio/viral-templates.ts');
  const personalViral = runWithAccessContext(createTeamAccessContext({ db, principal: userA.principal }), () => getOrCreateViralTemplateLibrary(db));
  assert.notEqual(personalViral.currentRevisionId, imported.viral.revisionId, '个人库不能冒充团队版本');
  const { createCatalogRevision: createPersonalRevision } = await import('../lib/script-studio/catalogs.ts');
  runWithAccessContext(createTeamAccessContext({ db, principal: userA.principal }), () => createPersonalRevision(db, {
    catalogId: personal.catalogId, sourceFilename: 'personal-v2.xlsx', sourceSha256: 'personal-v2', importReport: {},
  }));
  db.prepare("INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt) VALUES ('fixture-source-set', 'versioned-project', 'fixture-source', '[]', '2026-11-06')").run();
  db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES ('script_source_set', 'fixture-source-set', ?, 'private', 'project', 'versioned-project', 'project', 'versioned-project', '2026-11-06', '2026-11-06')`).run(userA.principal.userId);
  const { createLibraryRevision } = await import('../lib/script-studio/libraries.ts');
  const projectLibrary = runWithAccessContext(createTeamAccessContext({ db, principal: userA.principal }), () => createLibraryRevision(db, {
    projectId: 'versioned-project', sourceSetId: 'fixture-source-set', sourceFingerprint: 'fixture-source', category: '床',
    sellingPoints: [{ title: '实木框架', factText: '整块实木框架与静音床板', pointType: 'structure', detailText: '整块实木框架与静音床板' }],
  }));
  const recommendRoute = await import('../app/api/projects/[id]/script-studio/viral-template-recommend/route.ts');
  const taskParams = (taskId?: string) => ({ params: Promise.resolve({ id: 'versioned-project', ...(taskId ? { taskId } : {}) }) });
  const recommendation = await recommendRoute.POST(request('/api/projects/versioned-project/script-studio/viral-template-recommend', userA.cookie, 'POST', { libraryRevisionId: projectLibrary.id }), taskParams());
  assert.equal(recommendation.status, 200, await recommendation.clone().text());
  assert.equal((await recommendation.json() as { recommendations: Array<{ entry: { revisionId: string } }> }).recommendations[0]?.entry.revisionId, imported.viral.revisionId, '推荐与搜索必须解析同一个团队当前版本');
  const tasksRoute = await import('../app/api/projects/[id]/script-studio/tasks/route.ts');
  const retryRoute = await import('../app/api/projects/[id]/script-studio/tasks/[taskId]/retry/route.ts');
  const firstViralEntry = db.prepare('SELECT id FROM script_studio_viral_tpl_entries WHERE revisionId = ? LIMIT 1').pluck().get(imported.viral.revisionId) as string;
  const oldTaskResponse = await tasksRoute.POST(request('/api/projects/versioned-project/script-studio/tasks', userA.cookie, 'POST', {
    targetDurationSec: 15, productionMode: 'template_rewrite', requestedCount: 1,
    templateEntryIds: [firstViralEntry], providerId: 'fixture-script', requestKey: 'old-versioned-task',
  }), taskParams());
  assert.equal(oldTaskResponse.status, 202, await oldTaskResponse.clone().text());
  const oldTaskBody = await oldTaskResponse.json() as { task: { id: string; inputSnapshotJson?: string; inputSnapshot?: unknown } };
  const storedOld = db.prepare('SELECT inputSnapshotJson FROM script_studio_tasks WHERE id = ?').pluck().get(oldTaskBody.task.id) as string;
  assert.match(storedOld, /V1/);
  const oldKnowledge = JSON.parse(storedOld) as { knowledgeContext: {
    strategy: { strategyCatalogRevisionId: string; strategyEntryId: string };
    template: { templateCatalogRevisionId: string; usedCatalog: boolean }; recommendations: Array<{ framework: { name: string } }>;
  } };
  assert.equal(oldKnowledge.knowledgeContext.strategy.strategyCatalogRevisionId, imported.strategy.revisionId, '新任务冻结团队当前产品策略修订');
  assert.equal(oldKnowledge.knowledgeContext.strategy.strategyEntryId, (db.prepare('SELECT id FROM script_studio_strategy_entries WHERE revisionId = ?').pluck().get(imported.strategy.revisionId) as string), '员工创建实际解析到策略条目');
  assert.equal(oldKnowledge.knowledgeContext.template.templateCatalogRevisionId, imported.template.revisionId, '新任务冻结团队当前脚本模板修订');
  assert.equal(oldKnowledge.knowledgeContext.template.usedCatalog, true);
  assert.match(oldKnowledge.knowledgeContext.recommendations[0]?.framework.name ?? '', /V1/);
  db.prepare("UPDATE script_studio_tasks SET status = 'failed' WHERE id = ?").run(oldTaskBody.task.id);
  const publishV2 = await publish((await candidates()).find((item) => item.resourceId === second.viral.revisionId)!, imported.viral.revisionId);
  assert.equal(publishV2.status, 200);
  const secondViralEntry = db.prepare('SELECT id FROM script_studio_viral_tpl_entries WHERE revisionId = ? LIMIT 1').pluck().get(second.viral.revisionId) as string;
  const staleTask = await tasksRoute.POST(request('/api/projects/versioned-project/script-studio/tasks', userA.cookie, 'POST', {
    targetDurationSec: 15, productionMode: 'template_rewrite', requestedCount: 1,
    templateEntryIds: [firstViralEntry], providerId: 'fixture-script', requestKey: 'stale-versioned-task',
  }), taskParams());
  assert.equal(staleTask.status, 409, '前端旧选择在提交时不得静默改用其他版本');
  const newTask = await tasksRoute.POST(request('/api/projects/versioned-project/script-studio/tasks', userA.cookie, 'POST', {
    targetDurationSec: 15, productionMode: 'template_rewrite', requestedCount: 1,
    templateEntryIds: [secondViralEntry], providerId: 'fixture-script', requestKey: 'new-versioned-task',
  }), taskParams());
  assert.equal(newTask.status, 202, await newTask.clone().text());
  const retry = await retryRoute.POST(request(`/api/projects/versioned-project/script-studio/tasks/${oldTaskBody.task.id}/retry`, userA.cookie, 'POST', {}), taskParams(oldTaskBody.task.id));
  assert.equal(retry.status, 202, await retry.clone().text());
  const retryBody = await retry.json() as { task: { id: string } };
  const retrySnapshot = db.prepare('SELECT inputSnapshotJson FROM script_studio_tasks WHERE id = ?').pluck().get(retryBody.task.id) as string;
  assert.match(retrySnapshot, /V1/);
  assert.doesNotMatch(retrySnapshot, /V2/);
  const employeePatch = await (await import('../app/api/script-studio/viral-templates/entries/[entryId]/route.ts')).PATCH(request(`/api/script-studio/viral-templates/entries/${secondViralEntry}`, userA.cookie, 'PATCH', { status: 'unusable', reason: '越权' }), { params: Promise.resolve({ entryId: secondViralEntry }) });
  assert.equal(employeePatch.status, 403);
  console.log('PASS: new-task current revision, stale selection rejection and old-task retry snapshot');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
