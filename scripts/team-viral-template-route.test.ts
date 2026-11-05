import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import { NextRequest } from 'next/server.js';

/**
 * 团队公共爆文模板路由合同（票 01 / 规格 §3）。
 *
 * 走**真实**团队路由编排：withTeamRoute 的权限分类、CSRF/来源校验、
 * team_resource_scopes 资源授权全部真实生效，不 mock assertAccess。
 * 会话用真实 createTeamAuthService 登录签发的 session cookie。
 */

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-viral-route-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3312',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-viral-route',
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
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
const {
  findTeamViralTemplateLibrary, listViralTemplateEntries, getViralTemplateLibraryView,
  TEAM_VIRAL_TEMPLATE_OWNER_KEY,
} = await import('../lib/script-studio/viral-templates.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3312,
  deploymentId: 'deployment-viral-route', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.notEqual((await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'script-backups') })).state, 'compatibility_only');

const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);

const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
const adminPrincipal = await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-viral-route-password');
const adminCookie = sessionCookie(adminLogin.token).split(';', 1)[0];

async function account(employeeId: string, displayName: string) {
  const created = await service.createUser(adminPrincipal, { employeeId, displayName, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-viral-route-password`);
  return { principal: login.principal, cookie: sessionCookie(login.token).split(';', 1)[0] };
}
const userA = await account('0001', '甲');
const userB = await account('0002', '乙');

const HEADER = ['类目', '子类目', '模板名称', '标题', '参考文案', '结构摘要', '模板ID'];
async function workbook(text: string): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('全部模板');
  sheet.addRow(HEADER);
  sheet.addRow(['床', '实木床', '团队模板', '床的选择', text, '钩子>卖点>结尾', 'tpl-team']);
  return Buffer.from(await book.xlsx.writeBuffer());
}
const v1 = await workbook('标题：团队模板一\n正文：第一版团队公共模板文案内容。');
const v2 = await workbook('标题：团队模板二\n正文：第二版团队公共模板文案内容。');

const ORIGIN = 'https://studio.example.test';
const CSRF = 'route-csrf-token';

function get(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : {} });
}
/** 表单上传：真实 multipart + Origin + CSRF。 */
function uploadForm(url: string, cookie: string, file: Buffer, filename: string, options: { csrf?: string; origin?: string } = {}): NextRequest {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), filename);
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      Cookie: `${cookie}; __Host-team_csrf=${options.csrf ?? CSRF}`,
      Origin: options.origin ?? ORIGIN,
      'x-csrf-token': options.csrf ?? CSRF,
      'x-creative-studio-client-version': '0.7.1',
      'x-creative-studio-client-api': '1',
    },
    body: form,
  });
}
function jsonWrite(url: string, cookie: string, body: unknown, options: { csrf?: string; origin?: string } = {}): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${cookie}; __Host-team_csrf=${options.csrf ?? CSRF}`,
      Origin: options.origin ?? ORIGIN,
      'x-csrf-token': options.csrf ?? CSRF,
      'x-creative-studio-client-version': '0.7.1',
      'x-creative-studio-client-api': '1',
    },
    body: JSON.stringify(body),
  });
}

const viralRoute = await import('../app/api/team/public-resources/viral-templates/route.ts');
const generalRoute = await import('../app/api/team/public-resources/route.ts');
const entriesRoute = await import('../app/api/script-studio/viral-templates/entries/route.ts');
const currentRoute = await import('../app/api/script-studio/viral-templates/current/route.ts');
const viewRoute = await import('../app/api/script-studio/viral-templates/route.ts');

const URL_TEAM = `${ORIGIN}/api/team/public-resources/viral-templates`;
/** 发布必须显式带基准版本（空串表示「认定团队尚无版本」），用于并发 CAS。 */
const teamUrl = (baseRevisionId: string) => `${URL_TEAM}?baseRevisionId=${encodeURIComponent(baseRevisionId)}`;

try {
  // ---- 未登录：团队发布入口 401，员工读取入口也 401 ----
  assert.equal((await viralRoute.GET(get(URL_TEAM))).status, 401);
  assert.equal((await viralRoute.POST(jsonWrite(URL_TEAM, '', {}))).status, 401);

  // ---- 员工：能读状态（真实团队上下文），不能发布/上传/切版本/改条目 ----
  const employeeView = await viralRoute.GET(get(URL_TEAM, userA.cookie));
  assert.equal(employeeView.status, 403, '员工无权访问管理员发布入口');
  const employeeReadView = await viewRoute.GET(get(`${ORIGIN}/api/script-studio/viral-templates`, userA.cookie));
  assert.equal(employeeReadView.status, 200);
  const readBody = await employeeReadView.json() as { library: unknown; source: string | null; canManage: boolean };
  assert.equal(readBody.library, null, '未发布时员工拿到真实空状态');
  assert.equal(readBody.source, null);
  assert.equal(readBody.canManage, false);

  const employeeUpload = await viralRoute.POST(uploadForm(teamUrl(''), userA.cookie, v1, 'v1.xlsx'));
  assert.equal(employeeUpload.status, 403, '员工上传发布必须被拒绝');
  const employeePublish = await viralRoute.POST(jsonWrite(URL_TEAM, userA.cookie, { revisionId: 'x', baseRevisionId: null }));
  assert.equal(employeePublish.status, 403, '员工发布必须被拒绝');
  assert.equal(findTeamViralTemplateLibrary(db), null, '被拒绝的请求不得创建团队库');
  const employeeImport = await (await import('../app/api/script-studio/viral-templates/import/route.ts')).POST(
    uploadForm(`${ORIGIN}/api/script-studio/viral-templates/import`, userA.cookie, v1, 'v1.xlsx'),
  );
  assert.equal(employeeImport.status, 403, `员工个人导入在团队模式被拒绝：${await employeeImport.clone().text()}`);

  // ---- CSRF / 来源校验真实生效（double-submit：cookie 与 header 不一致即拒绝） ----
  const mismatchedCsrf = new NextRequest(teamUrl(''), {
    method: 'POST',
    headers: {
      Cookie: `${adminCookie}; __Host-team_csrf=${CSRF}`,
      Origin: ORIGIN,
      'x-csrf-token': 'different-token',
    },
    body: (() => { const form = new FormData(); form.append('file', new Blob([new Uint8Array(v1)]), 'v1.xlsx'); return form; })(),
  });
  const csrfResponse = await viralRoute.POST(mismatchedCsrf);
  assert.equal(csrfResponse.status, 403, await csrfResponse.clone().text());
  assert.match(JSON.stringify(await csrfResponse.json()), /csrf/i);
  const missingCsrf = new NextRequest(teamUrl(''), {
    method: 'POST',
    headers: { Cookie: adminCookie, Origin: ORIGIN },
    body: (() => { const form = new FormData(); form.append('file', new Blob([new Uint8Array(v1)]), 'v1.xlsx'); return form; })(),
  });
  assert.equal((await viralRoute.POST(missingCsrf)).status, 403, '缺少 CSRF token 必须拒绝');
  const badOrigin = await viralRoute.POST(uploadForm(teamUrl(''), adminCookie, v1, 'v1.xlsx', { origin: 'https://evil.example.test' }));
  assert.equal(badOrigin.status, 403, '跨站来源必须拒绝');
  // 逐条发布入口不得再接受爆文模板类型：必须引导到原子发布入口，避免「只公开库根、条目仍私有」。
  for (const resourceType of ['viral_template_library', 'viral_template_revision', 'viral_template_entry']) {
    const strayPublish = await generalRoute.POST(jsonWrite(
      `${ORIGIN}/api/team/public-resources`, adminCookie, { resourceType, resourceId: 'missing' },
    ));
    assert.equal(strayPublish.status, 400, `${resourceType} 不得走逐条发布入口`);
    assert.equal((await strayPublish.json() as { error: string }).error, 'use_team_publish');
  }

  // ---- 管理员预览：不落库 ----
  const preview = await viralRoute.POST(uploadForm(`${URL_TEAM}?mode=preview`, adminCookie, v1, 'v1.xlsx'));
  assert.equal(preview.status, 200, await preview.clone().text());
  const previewBody = await preview.json() as { preview: boolean; report: { totalRows: number; canActivate: boolean; statusCounts: { usable: number }; entries?: unknown } };
  assert.equal(previewBody.preview, true);
  assert.equal(previewBody.report.totalRows, 1);
  assert.equal(previewBody.report.statusCounts.usable, 1);
  assert.equal(previewBody.report.entries, undefined, '预览不返回全部条目内容');
  assert.equal(findTeamViralTemplateLibrary(db), null, '预览不得落库');

  // 缺少基准版本必须拒绝（否则无法检测并发冲突）。
  const noBase = await viralRoute.POST(uploadForm(URL_TEAM, adminCookie, v1, 'v1.xlsx'));
  assert.equal(noBase.status, 400, await noBase.clone().text());

  // ---- 管理员发布 ----
  const published = await viralRoute.POST(uploadForm(teamUrl(''), adminCookie, v1, '团队爆文库v1.xlsx'));
  assert.equal(published.status, 201, await published.clone().text());
  const publishedBody = await published.json() as { revisionId: string; revisionNumber: number; created: boolean; activated: boolean };
  assert.equal(publishedBody.created, true);
  assert.equal(publishedBody.revisionNumber, 1);

  const teamLibrary = findTeamViralTemplateLibrary(db);
  assert.equal(teamLibrary?.ownerKey, TEAM_VIRAL_TEMPLATE_OWNER_KEY);
  // 团队库及其修订/条目的可读权限一致生效（员工能读到条目，不是只公开库根）。
  const employeeEntries = await entriesRoute.GET(get(`${ORIGIN}/api/script-studio/viral-templates/entries?status=usable`, userB.cookie));
  assert.equal(employeeEntries.status, 200, await employeeEntries.clone().text());
  assert.equal((await employeeEntries.json() as { entries: unknown[] }).entries.length, 1);

  // ---- 员工读取：个人空库不能遮住团队当前版本 ----
  // 员工无个人库时，读视图与条目都来自团队版本。
  const employeeStillView = await viewRoute.GET(get(`${ORIGIN}/api/script-studio/viral-templates`, userB.cookie));
  const stillView = await employeeStillView.json() as { library: { id: string } | null; source: string | null; current: { id: string } | null };
  assert.equal(stillView.library?.id, teamLibrary!.id);
  assert.equal(stillView.source, 'team');
  assert.equal(stillView.current?.id, publishedBody.revisionId);

  // ---- 重复上传同一内容幂等 ----
  const replay = await viralRoute.POST(uploadForm(teamUrl(publishedBody.revisionId), adminCookie, v1, '团队爆文库v1-again.xlsx'));
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { created: boolean; activated: boolean; revisionId: string };
  assert.equal(replayBody.created, false);
  assert.equal(replayBody.activated, false);
  assert.equal(replayBody.revisionId, publishedBody.revisionId);

  // ---- 并发冲突：baseRevisionId 过期必须 409 ----
  const conflict = await viralRoute.POST(jsonWrite(URL_TEAM, adminCookie, {
    revisionId: publishedBody.revisionId, baseRevisionId: 'stale-revision-id',
  }));
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.equal((await conflict.json() as { error: string }).error, 'conflict');
  // 上传路径同样做 CAS
  const staleUpload = await viralRoute.POST(uploadForm(teamUrl('stale-revision-id'), adminCookie, v2, '团队爆文库v2.xlsx'));
  assert.equal(staleUpload.status, 409, '上传发布也必须检测基准版本冲突');

  // ---- 发布新版本 ----
  const secondPublish = await viralRoute.POST(uploadForm(teamUrl(publishedBody.revisionId), adminCookie, v2, '团队爆文库v2.xlsx'));
  assert.equal(secondPublish.status, 201, await secondPublish.clone().text());
  const secondBody = await secondPublish.json() as { revisionId: string; revisionNumber: number };

  const adminViewResponse = await viralRoute.GET(get(URL_TEAM, adminCookie));
  assert.equal(adminViewResponse.status, 200);
  const adminViewBody = await adminViewResponse.json() as {
    current: { id: string } | null;
    revisions: Array<{ id: string; sourceFilename: string; entryCount: number; current: boolean }>;
    candidates: Array<{ revisionId: string }>;
  };
  assert.equal(adminViewBody.current?.id, secondBody.revisionId);
  assert.deepEqual(adminViewBody.revisions.map((revision) => revision.sourceFilename), ['团队爆文库v2.xlsx', '团队爆文库v1.xlsx']);
  assert.deepEqual(adminViewBody.revisions.map((revision) => revision.entryCount), [1, 1]);
  assert.deepEqual(adminViewBody.revisions.map((revision) => revision.current), [true, false]);

  // ---- 管理员从历史版本发布（按文件名/版本识别，不需要手填内部 ID） ----
  const reactivate = await viralRoute.POST(jsonWrite(URL_TEAM, adminCookie, {
    revisionId: publishedBody.revisionId, baseRevisionId: secondBody.revisionId,
  }));
  assert.equal(reactivate.status, 200, await reactivate.clone().text());
  const reactivateBody = await reactivate.json() as { created: boolean; activated: boolean; revisionId: string };
  assert.equal(reactivateBody.created, false);
  assert.equal(reactivateBody.activated, true, '重激活历史版本必须明确报告 activated');

  // ---- 管理员从既有个人修订发布：digest 出现在 candidates，发布后个人修订仍私有 ----
  const adminImport = await (await import('../app/api/script-studio/viral-templates/import/route.ts')).POST(
    uploadForm(`${ORIGIN}/api/script-studio/viral-templates/import`, adminCookie, await workbook('标题：个人草稿\n正文：管理员此前在设置页导入的私有模板内容。'), '管理员个人草稿.xlsx'),
  );
  assert.equal(adminImport.status, 201, await adminImport.clone().text());
  const personalRevisionId = (await adminImport.json() as { revisionId: string }).revisionId;
  const candidatesView = await (await viralRoute.GET(get(URL_TEAM, adminCookie))).json() as {
    candidates: Array<{ revisionId: string; sourceFilename: string; libraryOwner: string; entryCount: number }>;
  };
  const personalCandidate = candidatesView.candidates.find((candidate) => candidate.revisionId === personalRevisionId);
  assert.ok(personalCandidate, '既有个人修订必须作为候选出现在发布入口');
  assert.equal(personalCandidate.libraryOwner, 'personal');
  assert.equal(personalCandidate.sourceFilename, '管理员个人草稿.xlsx');
  assert.equal(personalCandidate.entryCount, 1);
  const publishCandidate = await viralRoute.POST(jsonWrite(URL_TEAM, adminCookie, {
    revisionId: personalRevisionId, baseRevisionId: reactivateBody.revisionId,
  }));
  assert.equal(publishCandidate.status, 201, await publishCandidate.clone().text());
  const candidateBody = await publishCandidate.json() as { revisionId: string; revisionNumber: number };
  assert.equal(candidateBody.revisionNumber, 3);
  const publishedEntries = await (await entriesRoute.GET(get(`${ORIGIN}/api/script-studio/viral-templates/entries?status=all`, userA.cookie))).json() as { entries: unknown[] };
  assert.equal(publishedEntries.entries.length, 1, '发布后的条目对员工可见');
  // 个人库不搬走、不新建，历史仍隔离。
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM script_studio_viral_tpl_libraries WHERE ownerKey = ?").pluck().get(adminPrincipal.userId),
    1,
    '发布不搬走也不额外新建管理员个人库',
  );

  // ---- 员工不能切团队版本 ----
  const employeeSwitch = await currentRoute.PUT(new Request(`${ORIGIN}/api/script-studio/viral-templates/current`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json', Cookie: `${userA.cookie}; __Host-team_csrf=${CSRF}`,
      Origin: ORIGIN, 'x-csrf-token': CSRF,
    },
    body: JSON.stringify({ revisionId: secondBody.revisionId }),
  }));
  assert.equal(employeeSwitch.status, 403, await employeeSwitch.clone().text());
  // 管理员可以切
  const adminSwitch = await currentRoute.PUT(new Request(`${ORIGIN}/api/script-studio/viral-templates/current`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json', Cookie: `${adminCookie}; __Host-team_csrf=${CSRF}`,
      Origin: ORIGIN, 'x-csrf-token': CSRF,
    },
    body: JSON.stringify({ revisionId: secondBody.revisionId }),
  }));
  assert.equal(adminSwitch.status, 200, await adminSwitch.clone().text());

  // ---- 员工不能改公共条目状态 ----
  const entryId = (await (await entriesRoute.GET(get(`${ORIGIN}/api/script-studio/viral-templates/entries?status=all`, adminCookie))).json() as { entries: Array<{ id: string }> }).entries[0]!.id;
  const entryRoute = await import('../app/api/script-studio/viral-templates/entries/[entryId]/route.ts');
  const employeePatch = await entryRoute.PATCH(new Request(`${ORIGIN}/api/script-studio/viral-templates/entries/${entryId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json', Cookie: `${userA.cookie}; __Host-team_csrf=${CSRF}`,
      Origin: ORIGIN, 'x-csrf-token': CSRF,
    },
    body: JSON.stringify({ status: 'unusable', reason: '员工尝试修改' }),
  }), { params: Promise.resolve({ entryId }) });
  assert.equal(employeePatch.status, 403, await employeePatch.clone().text());

  // ---- 员工读取一致：三个人都看到同一团队当前版本 ----
  const adminCtx = createTeamAccessContext({ db, principal: adminPrincipal });
  const teamEntryCount = runWithAccessContext(adminCtx, () => listViralTemplateEntries(db, { status: 'all' })).length;
  assert.equal(teamEntryCount, 1);
  const finalView = runWithAccessContext(
    createTeamAccessContext({ db, principal: userA.principal }),
    () => getViralTemplateLibraryView(db),
  );
  assert.equal(finalView.source, 'team');
  assert.equal(finalView.canManage, false);

  console.log('PASS: team viral template routes — real admin/employee sessions, CSRF, publish, conflict, authorization');
} finally {
  setTeamAuthServiceForTests(null);
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
