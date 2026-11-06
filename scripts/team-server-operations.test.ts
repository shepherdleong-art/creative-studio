import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleTeamOperation } from '../lib/team-service/operations.ts';
import { teamRoutePolicy } from '../lib/team-service/route-policy.ts';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-operation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentialPath = path.join(root, 'control.json');
  const token = 'fixture-only-control-token-not-a-real-secret';
  fs.writeFileSync(credentialPath, JSON.stringify({ schemaVersion: 1, deploymentId: 'studio-prod', token }));
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  Object.assign(process.env, {
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_PORT: '3300',
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'studio-prod',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
    CREATIVE_STUDIO_CONTROL_CREDENTIAL_FILE: credentialPath,
  });
  const state = { live: true as const, ready: true, maintenance: false, phase: 'ready' as const, instanceId: 'instance-a', fence: 7 };
  const calls: Array<unknown> = [];
  return {
    token,
    state,
    calls,
    dependencies: {
      getState: () => state,
      shutdown: async () => { calls.push('shutdown'); return { stopped: true, pendingTasks: 0 }; },
      scheduleExit: () => { calls.push('exit'); },
      pid: 456,
    },
  };
}

function request(token: string, method = 'GET', body?: unknown) {
  return new Request('http://127.0.0.1:3300/api/team/operations/status', {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('本机凭据运维不叠加浏览器 Origin/CSRF，且不得变成公共远程 shutdown', () => {
  assert.equal(teamRoutePolicy('/api/team/operations/shutdown', 'POST').csrf, false);
  assert.equal(teamRoutePolicy('/api/shutdown', 'POST').category, 'local_only');
});

test('status 需要本机控制凭据并返回实例、PID 和生命周期证据', async (t) => {
  const context = fixture(t);
  const denied = await handleTeamOperation(request('wrong'), 'status', context.dependencies);
  assert.equal(denied.status, 401);
  assert.equal(context.calls.length, 0);
  const response = await handleTeamOperation(request(context.token), 'status', context.dependencies);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    deploymentId: 'studio-prod', instanceId: 'instance-a', pid: 456,
    ready: true, maintenance: false, phase: 'ready', fence: 7,
    modules: {
      batch: true, batchWorkerRunning: false, canvas: false,
      scriptStudio: true, scriptStudioScheduler: false, scriptStudioWorkerRunning: false,
    },
  });
  assert.equal(JSON.stringify(body).includes(context.token), false);
});

test('shutdown 绑定当前 instance 并调用唯一 gracefulShutdown，不触碰独立 LiteLLM', async (t) => {
  const context = fixture(t);
  const wrong = await handleTeamOperation(request(context.token, 'POST', { instanceId: 'stale' }), 'shutdown', context.dependencies);
  assert.equal(wrong.status, 409);
  assert.equal(context.calls.length, 0);
  const response = await handleTeamOperation(request(context.token, 'POST', { instanceId: 'instance-a' }), 'shutdown', context.dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(context.calls, ['shutdown', 'exit']);
  assert.deepEqual(await response.json(), {
    deploymentId: 'studio-prod', instanceId: 'instance-a', stopped: true, pendingTasks: 0,
  });
});

test('local 模式、缺失凭据文件和额外停机字段都 fail closed', async (t) => {
  const context = fixture(t);
  process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
  assert.equal((await handleTeamOperation(request(context.token), 'status', context.dependencies)).status, 404);
  process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
  process.env.CREATIVE_STUDIO_CONTROL_CREDENTIAL_FILE = path.join(path.dirname(process.env.CREATIVE_STUDIO_CONTROL_CREDENTIAL_FILE!), 'missing.json');
  assert.equal((await handleTeamOperation(request(context.token), 'status', context.dependencies)).status, 401);
});
