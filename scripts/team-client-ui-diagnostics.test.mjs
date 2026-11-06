import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClientDiagnosticReporter } = require('../dist-desktop/client/client-diagnostic-reporter.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-client-ui-diagnostics-'));
try {
  const reports = [];
  const reporter = new ClientDiagnosticReporter({
    origin: 'https://studio.example.test', stateRoot: root, clientDeviceId: '11111111-1111-4111-8111-111111111111',
    clientVersion: '0.7.1', session: {
      cookies: { async get() { return []; } },
      async fetch(url, options) {
        if (url.endsWith('/csrf')) return Response.json({ csrfToken: 'csrf' });
        reports.push(JSON.parse(options.body));
        return Response.json({ errorId: 'diagnostic-1' }, { status: 201 });
      },
    },
  });
  reporter.setIdentity('alice');
  reporter.capture({ actorUserId: 'bob', stage: 'download', phase: 'content', code: 'offline', clientEventId: 'only-bob' });
  assert.equal(reporter.pending().length, 0, '归属不匹配的事件不得写入当前账号');
  reporter.capture({ actorUserId: 'alice', stage: 'download', phase: 'content', code: 'offline', clientEventId: 'original-alice' });
  await reporter.flush();
  assert.equal(reports.length, 1);
  assert.equal(Object.hasOwn(reports[0], 'actorUserId'), false, '归属由服务端会话重新确认，不发送可伪造 actor');

  const listeners = new Map();
  const target = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const errors = [];
  const detach = require('../dist-desktop/client/ui-diagnostics.js').installClientUiDiagnostics(target, {
    report: (event) => errors.push(event),
  });
  assert.equal(listeners.has('error'), true);
  assert.equal(listeners.has('unhandledrejection'), true);
  const prevented = { reason: new Error('private source URL=https://example.test/?signature=secret'), preventDefault() { this.defaultPrevented = true; } };
  listeners.get('unhandledrejection')(prevented);
  listeners.get('unhandledrejection')(prevented);
  listeners.get('error')({ error: prevented.reason, message: prevented.reason.message });
  assert.equal(errors.length, 1, '同一未处理异常重复通知只上报一次');
  assert.equal(errors[0].stage, 'client_ui');
  assert.equal(errors[0].code, 'unhandled_rejection');
  assert.match(errors[0].clientEventId, /^[a-f0-9-]{36}$/);
  assert.equal(JSON.stringify(errors).includes('secret'), false);
  const cancel = new DOMException('Aborted', 'AbortError');
  listeners.get('unhandledrejection')({ reason: cancel });
  listeners.get('unhandledrejection')({ reason: { response: { status: 400 } } });
  assert.equal(errors.length, 1, '主动取消和普通表单校验不得误报');
  listeners.get('unhandledrejection')({ reason: 'plain rejection' });
  assert.equal(errors.length, 2);
  detach();
  assert.equal(listeners.size, 0);
  console.log('PASS client UI/unhandled rejection capture, dedupe and account ownership');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
