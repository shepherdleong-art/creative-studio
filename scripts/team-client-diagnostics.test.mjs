import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClientDiagnosticQueue } = require('../dist-desktop/client/client-diagnostics.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-client-diagnostics-'));
const filePath = path.join(root, 'accounts', 'account-a', 'diagnostics.json');
try {
  const queue = new ClientDiagnosticQueue(filePath, { maxEvents: 2 });
  const input = {
    clientEventId: 'ui-event-a', stage: 'client_ui', phase: 'unhandledrejection',
    code: 'async_rejection', clientVersion: '0.7.1',
    message: 'Cookie=secret Authorization: Bearer secret https://example.test/?signature=secret C:\\private\\original.png',
    stack: 'sensitive source text', requestBody: 'must not persist', cookies: 'must not persist',
  };
  const first = queue.capture(input);
  assert.equal(queue.capture(input).clientEventId, first.clientEventId);
  assert.equal(queue.pending().length, 1, '同一异常只能进入队列一次');
  assert.equal(queue.capture({ ...input, clientEventId: 'transfer-event-b', stage: 'download', transferId: 'transfer-b' }).kind, 'pending');
  assert.equal(queue.capture({ ...input, clientEventId: 'update-event-c', stage: 'client_update', phase: 'verification' }).kind, 'pending');
  assert.deepEqual(queue.pending().map((event) => event.clientEventId), ['transfer-event-b', 'update-event-c'], '容量满时保留最新且严格有界');
  const persisted = fs.readFileSync(filePath, 'utf8');
  for (const forbidden of ['secret', 'sensitive', 'requestBody', 'cookies', 'signature', 'private']) assert.equal(persisted.includes(forbidden), false, forbidden);

  const restarted = new ClientDiagnosticQueue(filePath, { maxEvents: 2 });
  assert.deepEqual(restarted.pending().map((event) => event.clientEventId), ['transfer-event-b', 'update-event-c'], '重开后保留待报事件');
  assert.equal(restarted.acknowledge('missing-event'), false);
  assert.equal(restarted.acknowledge('transfer-event-b'), true, '仅服务端成功才确认');
  assert.deepEqual(restarted.pending().map((event) => event.clientEventId), ['update-event-c']);
  assert.deepEqual(new ClientDiagnosticQueue(filePath).pending().map((event) => event.clientEventId), ['update-event-c']);
  console.log('PASS client diagnostic stable identity, bounded persistence and acknowledgement');
  const { ClientDiagnosticReporter } = require('../dist-desktop/client/client-diagnostic-reporter.js');
  let userId = 'alice';
  let csrf = 0;
  const sent = [];
  let offline = true;
  const session = {
    cookies: { async get() { return [{ name: '__Host-team_session', value: 'do-not-report' }]; } },
    async fetch(url, options) {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/team/auth/csrf') { csrf += 1; return Response.json({ csrfToken: 'csrf-token' }); }
      assert.equal(pathname, '/api/team/errors/report');
      if (offline) throw new Error('network_offline');
      sent.push(JSON.parse(options.body));
      return Response.json({ errorId: `server-${sent.length}` }, { status: 201 });
    },
  };
  const reporter = new ClientDiagnosticReporter({
    origin: 'https://studio.example.test', stateRoot: root, clientDeviceId: '11111111-1111-4111-8111-111111111111',
    clientVersion: '0.7.1', session,
  });
  reporter.capture({ stage: 'client_ui', phase: 'error', code: 'render_failed', clientEventId: 'logged-out-event' });
  assert.equal(reporter.pending().length, 0, '未登录事件不能绑定到之后的账号');
  reporter.setIdentity(userId);
  const event = { stage: 'download', phase: 'transport', code: 'network_offline', transferId: '22222222-2222-4222-8222-222222222222', clientEventId: 'transfer-alice' };
  reporter.capture(event);
  reporter.capture(event);
  await reporter.flush();
  assert.equal(sent.length, 0);
  assert.equal(reporter.pending().length, 1, '离线失败和重复通知只保留一个事件');
  offline = false;
  await reporter.flush();
  await reporter.flush();
  assert.equal(sent.length, 1, '重试不得生成重复上报请求');
  assert.equal(sent[0].clientEventId, 'transfer-alice');
  assert.equal(sent[0].transferId, event.transferId);
  assert.equal(reporter.pending().length, 0);
  assert.equal(JSON.stringify(sent).includes('do-not-report'), false, 'Cookie 不得进入诊断正文');
  reporter.setIdentity('bob');
  assert.equal(reporter.pending().length, 0);
  reporter.capture({ ...event, clientEventId: 'transfer-bob' });
  reporter.setIdentity('alice');
  assert.equal(reporter.pending().length, 0, '切回原账号不得读到其他账号事件');
  reporter.setIdentity('bob');
  reporter.capture({ ...event, actorUserId: 'alice', clientEventId: 'delayed-alice' });
  assert.equal(reporter.pending().some((event) => event.clientEventId === 'delayed-alice'), false, '延迟事件不得出现在当前 B 账号');
  reporter.setIdentity('alice');
  assert.equal(reporter.pending().some((event) => event.clientEventId === 'delayed-alice'), true, '延迟事件仍归原账号持久化');
  reporter.setIdentity('bob');
  reporter.setIdentity('bob');
  assert.equal(reporter.pending().length, 1);
  assert.ok(csrf >= 1);
  console.log('PASS client reporter offline retry, account isolation and safe transport');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
