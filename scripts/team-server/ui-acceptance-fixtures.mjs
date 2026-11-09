/**
 * 界面验收的测试数据入口（第 04 号票）。
 *
 * ===========================================================================
 * 怎么给某一屏补测试数据（05–14 号票看这里）
 * ===========================================================================
 *
 * 基础数据由 `base` 钩子准备，够现有全部页面用：
 *   - 管理员账号（隔离数据根里的首管理员，一次性凭据已换成稳定密码）
 *   - 员工账号（管理员经正式 API 创建，同样已改密）
 *   - 一个项目（员工经正式 API 创建，供应商是 fixture key，不会真的发起调用）
 *
 * 某屏需要更复杂的数据（分镜组、视频、混剪分组、批次……）时，在 `FIXTURE_HOOKS`
 * 里追加一个钩子，并在屏幕声明里写 `skipUnless: '<钩子 id>'`：
 *
 *   FIXTURE_HOOKS.videos = async (ctx) => {
 *     // ctx.api 是带 CSRF/Cookie 的正式 HTTP 客户端；ctx.employeeSession 是员工会话。
 *     // 只准走 /api/* 正式接口或隔离 SQLite；不许联网、不许碰真实数据根。
 *     const shotSet = await ctx.api.json(ctx.employeeSession, '/api/shot-sets', 'POST', {
 *       projectId: ctx.project.id, name: '验收分镜组',
 *     });
 *     ctx.shotSet = shotSet;
 *     return ctx;
 *   };
 *
 * 钩子写完后，跑 `TEAM_ACCEPTANCE_UI_SCREENS=project-video node scripts/ui-acceptance.playwright.test.mjs`
 * 只跑你那一屏，确认它真的量到了东西（`details.measured` 不为 0）。
 *
 * 注意三条红线：
 *   1. 钩子只能通过正式接口或隔离数据根里的 SQLite 造数据，不许打补丁绕过业务校验。
 *   2. 钩子不得触发任何供应商调用（fixture key 提交的任务也只受理不执行）。
 *   3. 数据造出来后，屏幕的 `ready` 要等「这一屏真的把数据画出来」再量，不要 sleep 顶替。
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** 造一张纯色 PNG（验收夹具用；不联网、不依赖 sharp）。 */
export function makeSolidPng(width = 96, height = 128, rgb = [200, 200, 205]) {
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 正式 HTTP 客户端：与 scripts/team-acceptance-http.playwright.test.mjs 同一套登录/CSRF 约定。 */
export function createUiAcceptanceApi(baseUrl) {
  const secrets = new Set();
  const remember = (value) => { if (value) secrets.add(value); return value; };
  const cookiePair = (response) => {
    const value = response.headers.get('set-cookie');
    assert.ok(value, '认证响应必须设置 cookie');
    return value.split(';', 1)[0];
  };
  async function raw(session, pathname, options = {}) {
    const headers = new Headers(options.headers);
    if (session) {
      headers.set('Cookie', session.cookies.join('; '));
      headers.set('Origin', baseUrl);
      if (options.method && options.method !== 'GET') headers.set('x-csrf-token', session.csrf);
    }
    if (!headers.has('x-creative-studio-client-version')) headers.set('x-creative-studio-client-version', '0.7.1');
    if (!headers.has('x-creative-studio-client-api')) headers.set('x-creative-studio-client-api', '1');
    const { json, ...init } = options;
    if (json !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(300_000),
      ...init,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    return response;
  }
  async function json(session, pathname, method = 'GET', body = undefined, expected = 200) {
    const response = await raw(session, pathname, { method, ...(body === undefined ? {} : { json: body }) });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    assert.equal(response.status, expected, `${method} ${pathname} 期望 ${expected}，实际 ${response.status}：${text.slice(0, 600)}`);
    return parsed;
  }
  async function login(employeeId, password) {
    const csrfResponse = await raw(null, '/api/team/auth/csrf');
    assert.equal(csrfResponse.status, 200);
    const csrfCookie = cookiePair(csrfResponse);
    const csrf = (await csrfResponse.json()).csrfToken;
    const loginResponse = await fetch(`${baseUrl}/api/team/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: csrfCookie, Origin: baseUrl, 'x-csrf-token': csrf },
      body: JSON.stringify({ employeeId, password }),
    });
    assert.equal(loginResponse.status, 200, `登录 ${employeeId} 失败：${await loginResponse.clone().text()}`);
    return { employeeId, csrf, cookies: [csrfCookie, cookiePair(loginResponse)] };
  }
  /** 一次性凭据登录 → 改密 → 用新密码重新登录（改密会撤销旧会话）。 */
  async function activate(employeeId, credential, newPassword) {
    remember(credential);
    const initial = await login(employeeId, credential);
    const changed = await json(initial, '/api/team/auth/change-password', 'POST', { currentPassword: credential, newPassword });
    assert.equal(changed.requiresReauthentication, true);
    remember(newPassword);
    return login(employeeId, newPassword);
  }
  return {
    baseUrl,
    raw,
    json,
    login,
    activate,
    secrets,
    /**
     * 走正式分片上传接口往项目里放一张真图（07 号票加的：第 1/2 步要有素材才画得出对照）。
     * 团队版 `/api/upload` 在 server 模式下是关闭的（controlledUploadRequired），
     * 所以这里和三段式上传走同一条路：create → put parts → complete。
     */
    async uploadProjectImage(session, projectId, { bytes, name, usage = 'scene_seed', mimeType = 'image/png' }) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const created = await json(session, '/api/team/uploads', 'POST', {
        targetKind: 'project_image',
        targetScope: { resourceType: 'project', resourceId: projectId },
        usage: 'image',
        relativeName: name,
        mimeType,
        expectedSize: bytes.length,
        expectedSha256: sha256,
        sourceFingerprint: `${bytes.length}:0:${sha256}`,
        idempotencyKey: randomUUID(),
        imageOptions: { role: 'input', usage, preprocessEnabled: true, targetMaxSide: 1536, jpegQuality: 85 },
      });
      const upload = created.upload ?? created.uploads?.[0];
      assert.ok(upload?.id, '分片上传必须返回 uploadId');
      for (const part of upload.missingParts ?? []) {
        const start = (part - 1) * upload.partSize;
        const end = Math.min(start + upload.partSize, bytes.length);
        const response = await raw(session, `/api/team/uploads/${upload.id}/parts/${part}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes.subarray(start, end),
        });
        const text = await response.text();
        assert.equal(response.status, 200, `上传分片 ${part} 失败（${response.status}）：${text.slice(0, 400)}`);
      }
      const completed = await json(session, `/api/team/uploads/${upload.id}/complete`, 'POST', {
        expectedSha256: sha256,
        sourceFingerprint: `${bytes.length}:0:${sha256}`,
      });
      assert.ok(completed.uploadedFile?.id, '上传完成必须返回归库后的图片');
      return completed.uploadedFile;
    },
    async createEmployee(adminSession, { employeeId, displayName, role = 'employee' }) {
      const created = await json(adminSession, '/api/team/users', 'POST', { employeeId, displayName, role }, 201);
      return created;
    },
    async createProvider(adminSession, { name, apiKey = 'fixture-not-a-real-key' }) {
      return json(adminSession, '/api/providers', 'POST', {
        name, baseUrl: 'http://127.0.0.1:9', apiKey, model: 'gpt-image-2', type: 'openai-compatible',
      });
    },
    async createProject(session, { providerId, productCode = 'UI-ACCEPT', editorName = '界面验收' }) {
      return json(session, '/api/projects', 'POST', {
        storeCode: 'B店', productCode, productSubmodel: '', productionType: 'AI种草',
        editorName, providerId, model: 'gpt-image-2', size: '1024x1024',
      });
    },
  };
}

/**
 * 数据钩子。按声明顺序执行，每个钩子拿到同一个 ctx 并可往上追加字段。
 * 后续票只往这里加自己的钩子，不要改别的钩子。
 */
export const FIXTURE_HOOKS = {
  /** 基础数据：一个项目（员工经正式 API 创建）。所有现有屏幕都依赖它。 */
  async base(ctx) {
    const provider = await ctx.api.createProvider(ctx.adminSession, { name: '界面验收 fixture 供应商' });
    ctx.provider = provider;
    ctx.project = await ctx.api.createProject(ctx.employeeSession, { providerId: provider.id });
    assert.ok(ctx.project?.id, '基础数据必须产出一个项目');
    return ctx;
  },

  /** 展开多脚本后的纵向布局；只导入文案，不启动生产或试听。 */
  async batchScripts(ctx) {
    const projectId = ctx.project.id;
    ctx.scriptLayoutBatch = await ctx.api.json(ctx.employeeSession, '/api/batch-production/batches', 'POST', {
      projectId, name: '脚本布局验收批次',
    }, 201);
    await ctx.api.json(ctx.employeeSession, '/api/batch-production/scripts', 'POST', {
      projectId,
      scripts: Array.from({ length: 6 }, (_, index) => ({
        title: `布局验收脚本 ${index + 1}`,
        bodyText: '客厅里的沙发承载一家人的日常。靠坐、休息、聊天，每一个角度都应清楚展示。'.repeat(3),
        targetDurationSec: 15,
      })),
    }, 201);
    return ctx;
  },

  /**
   * 07 号票：第 1/2 步要有素材与分镜组才画得出对照视图。
   * 只走正式接口 —— 项目图片用分片上传，分镜组用 `/api/projects/[id]/shot-sets`，
   * 不直接写 SQLite（不然绕过业务校验，量出来的界面也不是真实数据）。
   */
  async workbenchAssets(ctx) {
    const projectId = ctx.project.id;
    const upload = (usage, name, rgb) => ctx.api.uploadProjectImage(ctx.employeeSession, projectId, {
      bytes: makeSolidPng(96, 128, rgb),
      name,
      usage,
    });
    // 一张原始场景图 A（第 1 步左栏）
    ctx.sceneSeed = await upload('scene_seed', '验收-原始场景图.png', [210, 210, 214]);
    // 两张原始分镜图（第 2 步左栏 + 新建分镜组窗口）
    ctx.shotSourceA = await upload('shot_source', '验收-分镜图-1.png', [214, 208, 200]);
    ctx.shotSourceB = await upload('shot_source', '验收-分镜图-2.png', [200, 208, 214]);
    const created = await ctx.api.json(ctx.employeeSession, `/api/projects/${projectId}/shot-sets`, 'POST', {
      name: '验收分镜组',
      shotImageIds: [ctx.shotSourceA.id, ctx.shotSourceB.id],
    });
    assert.ok(created?.id, '分镜组创建必须返回 id');
    ctx.shotSet = created;
    return ctx;
  },

  /**
   * 11 号票：导出页要有四种状态的成片才量得出来
   * （已导出 / 修改未导出 / 从没导出 / 渲染失败）。
   *
   * 只用**正式接口 + 隔离数据根 SQLite**：
   * - 批次与项目走 `/api/batch-production/batches`；
   * - 成片计划、版本、正式产物与渲染任务用隔离库里的领域表造（这些没有对外
   *   「直接造一条已导出成片」的接口，强行调渲染会真的跑 ffmpeg）。
   * - 正式产物文件写进隔离 `storage/`，字节数与指纹与 artifact 行一致，
   *   这样清单接口的「每项带大小」在 UI 上也是真的。
   */
  async batchExportStates(ctx) {
    const projectId = ctx.project.id;
    const created = await ctx.api.json(ctx.employeeSession, '/api/batch-production/batches', 'POST', {
      projectId, name: '导出验收批次',
    }, 201);
    assert.ok(created?.id, '批次创建必须返回 id');
    const batchId = created.id;

    // 写正式产物文件（隔离 storage，绝不碰真实数据根）。
    const fs = await import('node:fs');
    const nodePath = await import('node:path');
    const { createHash } = await import('node:crypto');
    const storageRoot = nodePath.join(ctx.dataRoot ?? process.env.CREATIVE_STUDIO_DATA_ROOT, 'storage');
    const identityDir = 'UI-ACCEPT-20261101';
    const writeArtifact = (filename, bytes) => {
      const relativePath = nodePath.join('projects', identityDir, '成片', filename).split(nodePath.sep).join('/');
      const absolute = nodePath.join(storageRoot, relativePath);
      fs.mkdirSync(nodePath.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, bytes);
      return { relativePath, checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };

    const db = await ctx.openIsolatedDatabase();
    try {
      const { resolveCoverContractHash } = await import('../../lib/batch-production/cover-contract.ts');
      const now = new Date().toISOString();
      const batchVersionId = 'ui-accept-bv';
      const arrangementJson = JSON.stringify({
        productionReady: true, preset: '3:4', editRevision: 0,
        review: { decision: 'approved', decidedAt: now },
        clips: [{ clipId: 'ui-clip', assetId: 'ui-asset', sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000 }],
        cover: { assetId: 'ui-asset', timeUs: 0 },
        warnings: [], blockers: [],
      });
      db.prepare(`INSERT INTO batch_production_versions (id,batchId,versionNumber,copyCount,defaultsJson,inputState,frozenAt,createdAt)
        VALUES (?,?,1,4,'{}','frozen',?,?)`).run(batchVersionId, batchId, now, now);
      db.prepare(`UPDATE batch_productions SET currentVersionId = ?, status = 'running', controlState = 'running' WHERE id = ?`)
        .run(batchVersionId, batchId);
      db.prepare(`INSERT INTO batch_assets (id,projectId,sourceKind,locationJson,contentFingerprint,mediaKind,mediaJson,status,currentAnalysisId,createdAt,updatedAt)
        VALUES (?,?,'managed','{}','sha256:ui-accept-asset','video',?,'online','ui-analysis',?,?)`)
        .run('ui-asset', projectId, JSON.stringify({ durationSec: 6 }), now, now);
      db.prepare(`INSERT INTO batch_asset_analysis (id,assetId,analyzerVersion,providerId,model,analysisJson,status,analyzedAt,createdAt)
        VALUES ('ui-analysis','ui-asset','fixture','fixture','fixture',?,'ready',?,?)`)
        .run(JSON.stringify({ durationUs: 6_000_000 }), now, now);
      db.prepare(`INSERT INTO batch_asset_pool_items (id,batchVersionId,assetId,analysisId,selectionState,createdAt)
        VALUES ('ui-pool',?, 'ui-asset','ui-analysis','selected',?)`).run(batchVersionId, now);
      db.prepare(`INSERT INTO batch_scripts (id,projectId,sourceKind,sourceId,title,bodyText,sourceVersion,createdAt,updatedAt)
        VALUES ('ui-batch-script',?,'script_draft','ui-src','导出验收脚本','正文','v1',?,?)`).run(projectId, now, now);
      db.prepare(`INSERT INTO batch_script_snapshots (id,batchVersionId,sourceScriptId,title,bodyText,sourceVersion,copyCount,createdAt)
        VALUES ('ui-ss',?, 'ui-batch-script','导出验收脚本','正文','v1',4,?)`).run(batchVersionId, now);

      const insertPlan = db.prepare(`INSERT INTO batch_output_plans (id,batchVersionId,scriptSnapshotId,seq,planJson,currentVersionId,currentArtifactId,createdAt)
        VALUES (?,?,?,?,'{}',?,?,?)`);
      const insertVersion = db.prepare(`INSERT INTO batch_output_versions (id,planId,versionNumber,arrangementJson,createdAt) VALUES (?,?,?,?,?)`);
      const insertArtifact = db.prepare(`INSERT INTO batch_artifacts (id,projectId,batchId,batchVersionId,outputPlanId,outputVersionId,kind,relativePath,checksum,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);

      // 01 已导出
      insertPlan.run('ui-plan-exported', batchVersionId, 'ui-ss', 1, 'ui-ov-exported', 'ui-video-exported', now);
      insertVersion.run('ui-ov-exported', 'ui-plan-exported', 1, arrangementJson, now);
      // 02 修改未导出：正式产物属于旧版本，当前版本是 v2
      insertPlan.run('ui-plan-reworked', batchVersionId, 'ui-ss', 2, 'ui-ov-reworked', 'ui-video-reworked', now);
      insertVersion.run('ui-ov-reworked-old', 'ui-plan-reworked', 1, arrangementJson, now);
      insertVersion.run('ui-ov-reworked', 'ui-plan-reworked', 2, arrangementJson, now);
      // 03 从没导出
      insertPlan.run('ui-plan-never', batchVersionId, 'ui-ss', 3, 'ui-ov-never', null, now);
      insertVersion.run('ui-ov-never', 'ui-plan-never', 1, arrangementJson, now);
      // 04 渲染失败
      insertPlan.run('ui-plan-failed', batchVersionId, 'ui-ss', 4, 'ui-ov-failed', null, now);
      insertVersion.run('ui-ov-failed', 'ui-plan-failed', 1, arrangementJson, now);

      const exportedVideo = writeArtifact('UI-ACCEPT-01.mp4', Buffer.alloc(4096, 7));
      const exportedCover = writeArtifact('UI-ACCEPT-01-封面.jpg', Buffer.alloc(1024, 8));
      const reworkedVideo = writeArtifact('UI-ACCEPT-02.mp4', Buffer.alloc(2048, 9));
      const reworkedCover = writeArtifact('UI-ACCEPT-02-封面.jpg', Buffer.alloc(512, 10));
      for (const [id, planId, versionId, kind, file] of [
        ['ui-video-exported', 'ui-plan-exported', 'ui-ov-exported', 'video', exportedVideo],
        ['ui-cover-exported', 'ui-plan-exported', 'ui-ov-exported', 'cover', exportedCover],
        ['ui-video-reworked', 'ui-plan-reworked', 'ui-ov-reworked-old', 'video', reworkedVideo],
        ['ui-cover-reworked', 'ui-plan-reworked', 'ui-ov-reworked-old', 'cover', reworkedCover],
      ]) {
        insertArtifact.run(id, projectId, batchId, batchVersionId, planId, versionId, kind, file.relativePath, file.checksum, now);
      }

      // 已导出的那条要「新鲜」：一条成功的完整渲染 = 当前封面契约。
      const coverContractHash = resolveCoverContractHash(db, 'ui-ov-exported');
      db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,requestKey,expectedState,progressJson,attemptCount,createdAt,updatedAt)
        VALUES ('ui-cover-task',?,?,'render','output_version_cover','ui-ov-exported','succeeded',?,'running','{}',1,?,?)`)
        .run(projectId, batchId, `cover:ui-ov-exported:${coverContractHash}`, now, now);
      // 修改未导出：那条成片不应有「当前契约」的成功渲染，所以不建整片任务。
      db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,requestKey,expectedState,progressJson,attemptCount,createdAt,updatedAt)
        VALUES ('ui-failed-task',?,?,'render','output_version','ui-ov-failed','failed',NULL,'running','{}',1,?,?)`)
        .run(projectId, batchId, now, now);
      db.prepare(`INSERT INTO batch_task_attempts (id,taskId,attemptNumber,status,progressJson,errorCode,errorMessage,startedAt,finishedAt,createdAt)
        VALUES ('ui-failed-attempt','ui-failed-task',1,'failed','{}','render_failed','验收夹具：模拟渲染失败',?,?,?)`).run(now, now, now);

      // 从没导出：给它一条成功的封面尝试，检查成片里就有合成预览可播。
      const neverCoverHash = resolveCoverContractHash(db, 'ui-ov-never');
      db.prepare(`INSERT INTO batch_tasks (id,projectId,batchId,workType,targetKind,targetId,status,requestKey,expectedState,progressJson,attemptCount,createdAt,updatedAt)
        VALUES ('ui-never-cover-task',?,?,'render','output_version_cover','ui-ov-never','succeeded',?,'running','{}',1,?,?)`)
        .run(projectId, batchId, `cover:ui-ov-never:${neverCoverHash}`, now, now);
    } finally {
      db.close();
    }

    ctx.batch = { id: batchId, name: '导出验收批次' };
    return ctx;
  },

  /**
   * 07 号票：新项目（一张图都没有）用于验收「每步都有空状态」。
   * 只建项目本身，不传任何素材 —— 这样三步的空状态才有可断言的前提。
   */
  async emptyProject(ctx) {
    const project = await ctx.api.createProject(ctx.employeeSession, {
      providerId: ctx.provider.id, productCode: 'UI-ACCEPT-EMPTY', editorName: '空项目验收',
    });
    assert.ok(project?.id, '空项目必须创建成功');
    ctx.emptyProject = project;
    return ctx;
  },
};

/** 屏幕声明的 skipUnless 用它判断；缺钩子时该屏记 blocked，绝不静默当通过。 */
export function resolveHooks(ctx, requiredIds, hooks = FIXTURE_HOOKS) {
  const missing = requiredIds.filter((id) => typeof hooks[id] !== 'function');
  return { missing, available: requiredIds.filter((id) => typeof hooks[id] === 'function') };
}

export async function runFixtureHooks(ctx, requiredIds, hooks = FIXTURE_HOOKS) {
  const { available, missing } = resolveHooks(ctx, requiredIds, hooks);
  if (missing.length) return { ctx, missing };
  for (const id of available) {
    const next = await hooks[id](ctx);
    if (next && typeof next === 'object') Object.assign(ctx, next);
  }
  return { ctx, missing: [] };
}
