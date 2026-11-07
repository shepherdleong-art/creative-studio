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
      signal: AbortSignal.timeout(120_000),
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
