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
   * 票 01：第 2 步要「多个历史版本 + 切旧版」才量得出全部网格和旧版标记。
   *
   * `workbenchAssets` 只造了空分镜组；正式接口没有「不生成就产出一条结果」的入口，
   * 所以结果候选按隔离数据根里的 SQLite 造（界面仍走正式 `/api/shot-sets/[id]` 读）。
   * 三个候选直接复用 workbenchAssets 已上传的三张正式图片（都经过受控上传并登记），
   * 不另写文件、不碰 team_files 授权、不触发任何供应商调用。
   * 依赖 `workbenchAssets`；屏幕的 `skipUnless` 要按顺序同时声明两个钩子。
   */
  async storyboardVersions(ctx) {
    assert.ok(ctx.shotSet?.id, 'storyboardVersions 依赖 workbenchAssets 先造出分镜组');
    assert.ok(ctx.sceneSeed?.id && ctx.shotSourceA?.id && ctx.shotSourceB?.id, 'storyboardVersions 需要 workbenchAssets 上传的三张图');
    const projectId = ctx.project.id;
    const detail = await ctx.api.json(ctx.employeeSession, `/api/shot-sets/${ctx.shotSet.id}`);
    const shot = detail.shots?.[0];
    assert.ok(shot?.id, '分镜组必须至少有一个分镜');
    const db = await ctx.openIsolatedDatabase();
    try {
      const now = '2026-11-11T08:00:00Z';
      const assets = [ctx.sceneSeed, ctx.shotSourceA, ctx.shotSourceB];
      assets.forEach((asset, index) => {
        const suffix = `v${index + 1}`;
        const jobId = `ui-storyboard-job-${suffix}`;
        db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, size, status, outputImageId, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?)`).run(
          jobId, projectId, shot.sourceImageId, ctx.provider.id, 'gpt-image-2', '验收分镜版本', '1024x1024', asset.id, now,
        );
        db.prepare(`INSERT INTO shot_result_candidates (id, shotId, jobId, imageAssetId, createdAt) VALUES (?, ?, ?, ?, ?)`)
          .run(`ui-storyboard-candidate-${suffix}`, shot.id, jobId, asset.id, `2026-11-11T08:00:0${index}Z`);
      });
      // 默认选用最新一版（V3）；「切旧版」由屏幕动作点「使用上一版」触发，走正式 PATCH。
      db.prepare(`UPDATE shots SET latestGeneratedImageId = ?, latestJobId = ? WHERE id = ?`)
        .run(ctx.shotSourceB.id, 'ui-storyboard-job-v3', shot.id);
    } finally {
      db.close();
    }
    ctx.storyboardVersionShotId = shot.id;
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

  /**
   * 02 号票：待核对页要有真实证据形态的 fixture 才量得出「默认卡片 / 核对详情 / 人工核对」。
   *
   * 这里只在**隔离数据根**里造统一任务与执行证据（正式接口没有「直接造一条待核对任务」的入口），
   * 造出来的六个任务正好覆盖验收要求的六种形态：
   *   1. 结果已就绪、下载未完成（业务 providerStatus=download_failed），并带一个未提交的腾讯候选通道；
   *   2. 远端身份缺失（已受理但没有远端 ID）；
   *   3. 提交结果未知（maybe_sent、没有终态）；
   *   4. 生成成功但费用未知（业务 needs_check + costState=unknown）；
   *   5. 已请求取消、但已提交的部分还在等结果；
   *   6. 成功且已核账（只会出现在「全部记录」里，用来说明历史记录无需逐条核对）。
   *
   * 红线：不调用供应商、不写真实数据根、不绕过业务校验去改状态；只写隔离 SQLite 的领域表，
   * 供应商是 base 钩子建的 fixture 占位供应商。
   */
  async reconcileQueue(ctx) {
    const db = await ctx.openIsolatedDatabase();
    try {
      const projectId = ctx.project.id;
      const employee = db.prepare('SELECT id FROM team_users WHERE employeeId = ?')
        .get(ctx.employee.employeeId);
      assert.ok(employee?.id, '待核对夹具需要 base 钩子建好的员工账号');
      const instanceId = db.prepare('SELECT instanceId FROM execution_instances ORDER BY startedAt DESC LIMIT 1')
        .pluck().get() ?? 'ui-reconcile-instance';
      const at = (minute) => new Date(Date.UTC(2026, 10, 11, 7, minute, 0)).toISOString();
      const createdAt = at(0);
      const placeholders = (count) => Array.from({ length: count }, () => '?').join(', ');

      const imageId = 'ui-reconcile-input';
      db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
        VALUES (?, ?, 'input', ?, ?, 'image/png')`)
        .run(imageId, projectId, 'ui-reconcile-input.png', 'ui-reconcile/input.png');
      const insertJob = db.prepare(`INSERT INTO jobs (
        id, projectId, inputImageId, providerId, model, prompt, status, providerStatus, createdAt
      ) VALUES (${placeholders(9)})`);
      const insertTask = db.prepare(`INSERT INTO execution_media_tasks (
        id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
        inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
        status, cancelRequestedAt, currentChannelKey, nextEligibleAt, waitReason, waitDetailJson,
        resultJson, createdAt, updatedAt, reconcileVersion
      ) VALUES (${placeholders(25)})`);
      const insertChannel = db.prepare(`INSERT INTO execution_media_channels (
        id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority, state,
        executionRevision, operationId, remoteId, evidenceJson, nextEligibleAt, createdAt, updatedAt
      ) VALUES (${placeholders(15)})`);
      const insertOperation = db.prepare(`INSERT INTO execution_operations (
        id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
        businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
        providerSnapshotJson, configVersion, credentialVersionRef, requiredPoolsJson, quoteJson,
        status, readySeq, waitReason, waitDetail, currentPermitId, currentAttemptId, resultJson,
        createdAt, updatedAt, mediaTaskId, channelKey, admissionPriority, admissionCandidateCount,
        admissionTraceJson
      ) VALUES (${placeholders(33)})`);
      const insertAttempt = db.prepare(`INSERT INTO execution_attempts (
        id, operationId, permitId, actorId, businessAttemptNo, submitRound, transportSeq,
        requestHash, providerSnapshotJson, pricingSnapshotJson, submissionState, terminalState,
        instanceId, fence, leaseOwner, leaseUntil, remoteId, receiptJson, intentJournalSeq,
        receiptJournalSeq, errorCode, policyVersion, accountingPeriod, currency, reservedMinor,
        actualMinor, costState, createdAt, updatedAt
      ) VALUES (${placeholders(29)})`);

      const attempt = (id, overrides = {}) => ({
        id, submission: 'maybe_sent', terminal: null, remoteId: null, receiptRemoteId: null,
        errorCode: null, reserved: 40, actual: null, costState: 'reserved', ...overrides,
      });
      /** updatedAt 越晚越靠前：第一条「下载未完成」同时带成功通道与未提交的备用通道。 */
      const tasks = [
        {
          id: 'ui-reconcile-download', jobId: 'ui-reconcile-job-download',
          jobStatus: 'succeeded', jobProviderStatus: 'download_failed',
          status: 'succeeded', updatedAt: at(50),
          channels: [
            {
              channelKey: 'qiniu', priority: 0, state: 'succeeded', operationStatus: 'succeeded',
              remoteId: 'qiniu-download-1',
              attempts: [attempt('ui-reconcile-attempt-download', {
                submission: 'terminal', terminal: 'succeeded', remoteId: 'qiniu-download-1',
                receiptRemoteId: 'qiniu-download-1', reserved: 120, actual: 120, costState: 'settled',
              })],
            },
            { channelKey: 'tencent', priority: 1, state: 'candidate', operationStatus: null, remoteId: null, attempts: [] },
          ],
        },
        {
          id: 'ui-reconcile-remote-missing', jobId: 'ui-reconcile-job-remote-missing',
          jobStatus: 'accepted', jobProviderStatus: 'unknown',
          status: 'unknown', updatedAt: at(40),
          channels: [{
            channelKey: 'qiniu', priority: 0, state: 'accepted', operationStatus: 'accepted',
            remoteId: null,
            attempts: [attempt('ui-reconcile-attempt-remote-missing', {
              submission: 'accepted', reserved: 60, costState: 'reserved',
            })],
          }],
        },
        {
          id: 'ui-reconcile-submit-unknown', jobId: 'ui-reconcile-job-submit-unknown',
          jobStatus: 'unknown', jobProviderStatus: 'unknown',
          status: 'unknown', updatedAt: at(30),
          channels: [{
            channelKey: 'qiniu', priority: 0, state: 'unknown', operationStatus: 'unknown',
            remoteId: null,
            attempts: [attempt('ui-reconcile-attempt-submit-unknown', {
              submission: 'maybe_sent', reserved: 50, costState: 'unknown',
            })],
          }],
        },
        {
          id: 'ui-reconcile-cost-unknown', jobId: 'ui-reconcile-job-cost-unknown',
          jobStatus: 'needs_check', jobProviderStatus: 'succeeded',
          status: 'succeeded', updatedAt: at(20),
          channels: [{
            channelKey: 'qiniu', priority: 0, state: 'succeeded', operationStatus: 'succeeded',
            remoteId: 'qiniu-cost-1',
            attempts: [attempt('ui-reconcile-attempt-cost-unknown', {
              submission: 'terminal', terminal: 'succeeded', remoteId: 'qiniu-cost-1',
              reserved: 200, costState: 'unknown',
            })],
          }],
        },
        {
          id: 'ui-reconcile-canceled', jobId: 'ui-reconcile-job-canceled',
          jobStatus: 'unknown', jobProviderStatus: 'unknown',
          status: 'unknown', cancelRequestedAt: at(15), updatedAt: at(10),
          channels: [{
            channelKey: 'qiniu', priority: 0, state: 'unknown', operationStatus: 'unknown',
            remoteId: null,
            attempts: [attempt('ui-reconcile-attempt-canceled', {
              submission: 'maybe_sent', reserved: 40, costState: 'reserved',
            })],
          }],
        },
        {
          id: 'ui-reconcile-settled', jobId: 'ui-reconcile-job-settled',
          jobStatus: 'succeeded', jobProviderStatus: 'succeeded',
          status: 'succeeded', updatedAt: at(1),
          channels: [{
            channelKey: 'qiniu', priority: 0, state: 'succeeded', operationStatus: 'succeeded',
            remoteId: 'qiniu-settled-1',
            attempts: [attempt('ui-reconcile-attempt-settled', {
              submission: 'terminal', terminal: 'succeeded', remoteId: 'qiniu-settled-1',
              receiptRemoteId: 'qiniu-settled-1', reserved: 88, actual: 88, costState: 'settled',
            })],
          }],
        },
      ];

      let readySeq = 810001;
      for (const task of tasks) {
        insertJob.run(
          task.jobId, projectId, imageId, ctx.provider.id, 'gpt-image-2', '界面验收待核对夹具',
          task.jobStatus, task.jobProviderStatus, task.updatedAt,
        );
        insertTask.run(
          task.id, `fixture:${task.id}`, employee.id, 'project', projectId, 'image', task.jobId,
          'image2', 'unified-media-2026-11-10-v1', 'fixture-input-hash', '{}', '{}',
          'project', projectId, '{}', task.status, task.cancelRequestedAt ?? null,
          task.channels[0]?.channelKey ?? null, null, null, null, null, createdAt, task.updatedAt, 3,
        );
        for (const channel of task.channels) {
          const operationId = channel.attempts.length > 0
            ? `${task.id}-${channel.channelKey}-operation`
            : null;
          insertChannel.run(
            `${task.id}-${channel.channelKey}`, task.id, channel.channelKey, 'providers',
            ctx.provider.id, 'gpt-image-2', channel.priority, channel.state, 1, operationId,
            channel.remoteId ?? null, null, null, task.updatedAt, task.updatedAt,
          );
          if (!operationId) continue;
          insertOperation.run(
            operationId, `${task.id}:${channel.channelKey}:submit`, employee.id, 'project', projectId,
            'image', task.jobId, 'submit', 'fixture-revision', `${task.id}-business-attempt`, 1,
            'fixture-input-hash', '{}', `${task.id}-continuation`,
            JSON.stringify({
              providerId: ctx.provider.id, model: 'gpt-image-2',
              configVersion: 'fixture-config', credentialVersionRef: 'fixture-credential',
            }),
            'fixture-config', 'fixture-credential', '[]', '{"minor":0}',
            channel.operationStatus, readySeq++, null, null,
            `${task.id}-${channel.channelKey}-permit`, channel.attempts[0].id, null,
            task.updatedAt, task.updatedAt, task.id, channel.channelKey, 0, 1, null,
          );
          channel.attempts.forEach((item, index) => {
            insertAttempt.run(
              item.id, operationId, `${task.id}-${channel.channelKey}-permit`, employee.id,
              1, 1, index + 1, 'fixture-request-hash', '{}', '{}',
              item.submission, item.terminal ?? null, instanceId, 0, 'fixture',
              '2099-01-01T00:00:00.000Z', item.remoteId ?? null,
              item.receiptRemoteId ? JSON.stringify({ remoteId: item.receiptRemoteId }) : null,
              null, null, item.errorCode ?? null, 1, '2026-11', 'CNY',
              item.reserved, item.actual ?? null, item.costState, task.updatedAt, task.updatedAt,
            );
          });
        }
      }
      const inserted = db.prepare('SELECT COUNT(*) FROM execution_media_tasks').pluck().get();
      assert.equal(inserted, tasks.length, '待核对夹具必须把六个形态都造出来');
      // A released historical call stays unknown; release does not settle its result or cost.
      db.prepare(`INSERT INTO execution_reconciliation_orphans
        (attemptId, operationId, permitId, actorId, evidenceJson, state, createdAt, updatedAt)
        VALUES ('ui-historical-attempt', 'ui-historical-operation', 'ui-historical-permit', ?, '{}', 'unknown', ?, ?)`)
        .run(employee.id, at(0), at(0));
      for (const poolKey of ['llm:remote', 'actor:' + employee.id]) {
        db.prepare(`INSERT INTO execution_reservations
          (id, permitId, actorId, kind, poolKey, state, createdAt, releasedAt, releaseReason)
          VALUES (?, 'ui-historical-permit', ?, 'concurrency', ?, 'released', ?, ?, 'fixture-history')`)
          .run('ui-historical-' + poolKey, employee.id, poolKey, at(0), at(1));
      }
      ctx.reconcileTasks = tasks.map((task) => task.id);
      return ctx;
    } finally {
      db.close();
    }
  },

  /**
   * 05 号票：团队用量要有「多页明细 + 长 ID + 备用通道」才量得出二级页签、分页控件与详情弹窗。
   *
   * 只在**隔离数据根**里造统一任务 / 通道调用 / 非统一模型 / 待映射四类记录：
   *   - 管理员 60 个制作任务（3 页）+ 60 条通道调用，第一条带备用候选通道与超长远端 ID；
   *   - 员工 60 个制作任务（3 页）+ 非统一模型记录；
   *   - 管理员另有待映射记录，供「其他记录 → 待映射记录」页签使用。
   * 金额全部已结算且可手算；项目沿用 base 钩子建好的那个（不新增会溢出其他屏的长项目名）。
   * 红线：不调用供应商、不碰真实数据根、只写隔离 SQLite 的领域表。
   */
  async usageLedger(ctx) {
    const db = await ctx.openIsolatedDatabase();
    const PERIOD = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
    const MONTH_START = Date.parse(`${PERIOD}-01T00:00:00+08:00`);
    const BASE = Math.max(Date.now() - 60_000, MONTH_START + 6 * 60 * 60 * 1000);
    const at = (position) => new Date(BASE - position * 60_000).toISOString();
    const LONG_REMOTE_ID = `remote-ui-usage-${'0123456789abcdef'.repeat(6)}`;
    const LONG_ERROR_CODE = `error_fixture_${'长错误码用于验证对话框内换行-'.repeat(3)}`;
    try {
      const projectId = ctx.project.id;
      const employee = db.prepare('SELECT id FROM team_users WHERE employeeId = ?').get(ctx.employee.employeeId);
      const admin = db.prepare('SELECT id FROM team_users WHERE employeeId = ?').get(ctx.admin.employeeId);
      assert.ok(employee?.id && admin?.id, '用量夹具需要 base 钩子建好的管理员与员工账号');

      const insertTask = db.prepare(`INSERT INTO execution_media_tasks (
        id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
        inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
        status, currentChannelKey, createdAt, updatedAt
      ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'image2', 'rules-2026-11-11',
        ?, '{}', '{}', 'project_scene', ?, '{}', 'succeeded', ?, ?, ?)`);
      const insertChannel = db.prepare(`INSERT INTO execution_media_channels (
        id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
        state, executionRevision, operationId, remoteId, createdAt, updatedAt
      ) VALUES (?, ?, ?, 'providers', ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
      const insertOperation = db.prepare(`INSERT INTO execution_operations (
        id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
        businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
        providerSnapshotJson, requiredPoolsJson, quoteJson, status, waitReason, readySeq,
        createdAt, updatedAt, mediaTaskId, channelKey
      ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'submit', 'r1', ?, 1, ?, '{}', 'image.submit',
        ?, '[]', ?, 'succeeded', NULL, ?, ?, ?, ?, ?)`);
      const insertAttempt = db.prepare(`INSERT INTO execution_attempts (
        id, operationId, permitId, actorId, businessAttemptNo, submitRound, transportSeq,
        providerSnapshotJson, pricingSnapshotJson, submissionState, terminalState,
        instanceId, fence, leaseOwner, leaseUntil, remoteId, receiptJson,
        intentJournalSeq, receiptJournalSeq, errorCode, policyVersion, accountingPeriod,
        currency, reservedMinor, actualMinor, costState, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, NULL, 'terminal', 'succeeded', 'ui-usage-accept', 1,
        'fixture', '2099-01-01T00:00:00.000Z', ?, NULL, 1, NULL, ?, 1, ?, 'CNY', ?, ?, 'settled', ?, ?)`);

      let readySeq = 950001;
      let attemptSeq = 0;
      db.transaction(() => {
        for (const [actorId, spec, prefix] of [
          [admin.id, { tasks: 60, legacy: 40, unmapped: 45 }, 'uad'],
          [employee.id, { tasks: 60, legacy: 55, unmapped: 20 }, 'uem'],
        ]) {
          for (let position = 1; position <= spec.tasks; position += 1) {
            const createdAt = at(position);
            const mediaTaskId = `ui-usage-task-${prefix}-${String(position).padStart(3, '0')}`;
            const operationId = `ui-usage-op-${prefix}-${String(position).padStart(3, '0')}`;
            const showcase = prefix === 'uad' && position === 1;
            insertTask.run(
              mediaTaskId, `media:${mediaTaskId}`, actorId, projectId, operationId,
              `hash-${mediaTaskId}`, projectId, 'tencent', createdAt, createdAt,
            );
            insertChannel.run(
              `${mediaTaskId}:tencent`, mediaTaskId, 'tencent', 'company-gateway-image2-medium',
              'image2-medium', 0, 'succeeded', operationId,
              showcase ? LONG_REMOTE_ID : `remote-${mediaTaskId}`, createdAt, createdAt,
            );
            insertOperation.run(
              operationId, `key-${operationId}`, actorId, projectId, operationId,
              `business-${operationId}`, `hash-${operationId}`,
              JSON.stringify({
                providerId: 'company-gateway-image2-medium', name: '腾讯通道',
                model: 'image2-medium', requestModel: 'image2-medium', unifiedModel: 'image2',
              }),
              '{"kind":"priced"}', readySeq + position + 1, createdAt, createdAt, mediaTaskId, 'tencent',
            );
            attemptSeq += 1;
            insertAttempt.run(
              `ui-usage-attempt-${prefix}-${String(position).padStart(3, '0')}`, operationId,
              `permit-${prefix}-${position}`, actorId,
              JSON.stringify({ model: 'image2-medium', unifiedModel: 'image2' }),
              showcase ? LONG_REMOTE_ID : `remote-${mediaTaskId}`,
              showcase ? LONG_ERROR_CODE : null, PERIOD, 25, 25, createdAt, createdAt,
            );
          }
          readySeq += 1000;
          for (let position = 1; position <= spec.legacy; position += 1) {
            const createdAt = at(position);
            const operationId = `ui-usage-legacy-op-${prefix}-${String(position).padStart(3, '0')}`;
            insertOperation.run(
              operationId, `key-${operationId}`, actorId, projectId, `ui-usage-legacy-${prefix}-${position}`,
              `business-${operationId}`, `hash-${operationId}`,
              JSON.stringify({ model: 'kimi-k2', name: '旧文本模型' }),
              '{"kind":"priced"}', readySeq + position + 1, createdAt, createdAt, null, null,
            );
            attemptSeq += 1;
            insertAttempt.run(
              `ui-usage-legacy-attempt-${prefix}-${String(position).padStart(3, '0')}`, operationId,
              `permit-legacy-${prefix}-${position}`, actorId, JSON.stringify({ model: 'kimi-k2' }),
              `remote-legacy-${prefix}-${position}`, null, PERIOD, 10, 10, createdAt, createdAt,
            );
          }
          readySeq += 1000;
          for (let position = 1; position <= spec.unmapped; position += 1) {
            const createdAt = at(position);
            const operationId = `ui-usage-orphan-op-${prefix}-${String(position).padStart(3, '0')}`;
            insertOperation.run(
              operationId, `key-${operationId}`, actorId, projectId, `ui-usage-orphan-${prefix}-${position}`,
              `business-${operationId}`, `hash-${operationId}`,
              JSON.stringify({ model: 'image2-medium', unifiedModel: 'image2' }),
              '{"kind":"priced"}', readySeq + position + 1, createdAt, createdAt,
              `ui-usage-missing-${prefix}-${position}`, 'qiniu',
            );
            attemptSeq += 1;
            insertAttempt.run(
              `ui-usage-orphan-attempt-${prefix}-${String(position).padStart(3, '0')}`, operationId,
              `permit-orphan-${prefix}-${position}`, actorId,
              JSON.stringify({ model: 'image2-medium', unifiedModel: 'image2' }),
              `remote-orphan-${prefix}-${position}`, null, PERIOD, 30, 30, createdAt, createdAt,
            );
          }
          readySeq += 1000;
        }
        // 备用候选通道：详情里必须单列「备用通道，未提交」，且不增加通道调用数。
        insertChannel.run(
          'ui-usage-task-uad-001:qiniu', 'ui-usage-task-uad-001', 'qiniu',
          'fixture-qiniu', 'image2-medium', 1, 'candidate', null, null, at(1), at(1),
        );
        assert.ok(attemptSeq > 0, '用量夹具至少要造出一条尝试');
      })();
      const taskCount = db.prepare('SELECT COUNT(*) FROM execution_media_tasks').pluck().get();
      const attemptCount = db.prepare('SELECT COUNT(*) FROM execution_attempts').pluck().get();
      assert.equal(taskCount, 120, '用量夹具必须为管理员与员工各造 60 个制作任务（各 3 页）');
      assert.equal(attemptCount, 120 + 40 + 45 + 55 + 20, '用量夹具的尝试条数不符合造数期望');
      ctx.usageLedger = { tasks: taskCount, attempts: attemptCount };
      return ctx;
    } finally {
      db.close();
    }
  },

  /**
   * 06 号票：全员任务页的「服务端分页 + 完整总数 + 分组/平铺 + 旧链接/末页 + 长项目名」数据。
   *
   * 造 503 个制作任务 / 505 条执行记录：其中一个统一任务有 3 条执行记录（员工发起、
   * 挂在一个超长项目名下）、两个失败任务（其一可走原重试入口）、一条只存在于第 505 条
   * 记录的关键词。只写隔离数据根；可重试任务带一条已失败的 jobs 行，不会触发任何供应商调用。
   */
  async taskHistory(ctx) {
    const db = await ctx.openIsolatedDatabase();
    try {
      const employee = db.prepare('SELECT id FROM team_users WHERE employeeId = ?').get(ctx.employee.employeeId);
      const admin = db.prepare('SELECT id FROM team_users WHERE employeeId = ?').get(ctx.admin.employeeId);
      assert.ok(employee?.id && admin?.id, '任务分页夹具需要 base 钩子建好的管理员与员工账号');
      // 超长项目名：主表列宽（省略号 + tooltip）与详情换行的验收素材。走正式接口建项目，
      // 再用隔离数据根改长名字（不让长名污染 base 项目与其他屏）。
      const longProject = await ctx.api.createProject(ctx.employeeSession, {
        providerId: ctx.provider.id, productCode: 'UI-TASK-LONG-NAME',
      });
      const LONG_PROJECT_NAME = `超长项目名用于验证任务页主表列宽与详情换行-夏季新品详情页重制计划-第二批次-${'继续追加产品卖点与场景描述-'.repeat(3)}`;
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(LONG_PROJECT_NAME, longProject.id);

      const insertOperation = db.prepare(`INSERT INTO execution_operations (
        id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
        businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
        providerSnapshotJson, requiredPoolsJson, quoteJson, status, waitReason, readySeq,
        createdAt, updatedAt, mediaTaskId, channelKey
      ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'submit', ?, ?, 1, 'hash', '{}', 'image.submit', ?, '[]', '{}', ?, NULL, ?, ?, ?, ?, NULL)`);
      const providerSnapshot = JSON.stringify({ name: '任务页验收供应商', model: 'fixture-image-model' });
      const now = Date.now();
      let readySeq = 810_000;
      db.transaction(() => {
        for (let index = 1; index <= 3; index += 1) {
          const operationId = `ui-task-unified-op-${index}`;
          const at = new Date(now - 10_000 - index).toISOString();
          insertOperation.run(
            operationId, `key-${operationId}`, employee.id, longProject.id, 'ui-task-unified-showcase', `r${index}`,
            `ui-task-unified-biz-${index}`, providerSnapshot, 'succeeded', readySeq + index, at, at, 'ui-task-media-unified',
          );
        }
        readySeq += 100;
        for (let index = 1; index <= 502; index += 1) {
          const operationId = `ui-task-single-op-${String(index).padStart(3, '0')}`;
          const taskId = index === 502
            ? 'ui-task-deep-history-keyword'
            : `ui-task-single-${String(index).padStart(3, '0')}`;
          const actorId = index === 502 ? employee.id : admin.id;
          const status = index === 3 || index === 4 ? 'failed' : 'succeeded';
          const at = new Date(now - 60_000 - index * 1000).toISOString();
          insertOperation.run(
            operationId, `key-${operationId}`, actorId, ctx.project.id, taskId, 'r1',
            `ui-task-biz-${index}`, providerSnapshot, status, readySeq + index, at, at, null,
          );
          if (status === 'failed') {
            db.prepare('UPDATE execution_operations SET status = ? WHERE id = ?').run(status, operationId);
          }
        }
        // 可重试的图片任务：原重试入口要求 jobs 行存在且已失败；不会真的提交供应商。
        db.prepare("INSERT OR IGNORE INTO image_assets (id, projectId, role, filename, path) VALUES ('ui-task-fixture-input', ?, 'input', '任务页验收输入.png', 'storage/ui-task-fixture-input.png')")
          .run(longProject.id);
        db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, status)
          VALUES (?, ?, 'ui-task-fixture-input', ?, 'fixture-image-model', 'fixture', 'failed')`)
          .run('ui-task-single-003', longProject.id, ctx.provider.id);
        // 原重试入口是受控资源路由：按正式登记格式给 job 补归属（父级=项目），只写隔离数据根。
        const scopeAt = new Date(now - 61_000).toISOString();
        db.prepare(`INSERT INTO team_resource_scopes (
          resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt
        ) VALUES ('job', 'ui-task-single-003', ?, 'private', 'project', ?, 'project', ?, ?, ?)`)
          .run(employee.id, longProject.id, longProject.id, scopeAt, scopeAt);
      })();
      const groups = db.prepare(`SELECT COUNT(DISTINCT groupId) FROM (
        SELECT CASE WHEN NULLIF(mediaTaskId, '') IS NOT NULL THEN 'unified:' || mediaTaskId ELSE 'operation:' || id END AS groupId
        FROM execution_operations WHERE id LIKE 'ui-task-%'
      )`).pluck().get();
      const records = db.prepare("SELECT COUNT(*) FROM execution_operations WHERE id LIKE 'ui-task-%'").pluck().get();
      assert.equal(groups, 503, '任务分页夹具必须造出 503 个制作任务');
      assert.equal(records, 505, '任务分页夹具必须造出 505 条执行记录');
      ctx.taskHistory = {
        groups,
        records,
        longProjectName: LONG_PROJECT_NAME,
        deepOperationId: 'ui-task-single-op-502',
        retryOperationId: 'ui-task-single-op-003',
        lastPageOperationId: 'ui-task-single-op-501',
      };
      return ctx;
    } finally {
      db.close();
    }
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
