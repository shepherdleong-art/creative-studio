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
