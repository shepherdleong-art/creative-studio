import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runIndependentUpdateJob } = require('../dist-desktop/client/update-helper.js');
const { ClientDiagnosticQueue } = require('../dist-desktop/client/client-diagnostics.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-client-update-diagnostics-'));
try {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(root, 'update-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  const jobId = crypto.randomUUID();
  const actorUserId = 'alice';
  const clientDeviceId = crypto.randomUUID();
  const job = {
    schemaVersion: 1, jobId, installRoot: root,
    manifestUrl: 'https://studio.example.test/client-updates/missing.json', serverOrigin: 'https://studio.example.test',
    currentPid: 99999999, platform: 'win32', arch: 'x64', actorUserId, clientDeviceId, clientVersion: '0.7.1',
  };
  const jobFile = path.join(root, 'updates', 'jobs', `${jobId}.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const result = await runIndependentUpdateJob(jobFile);
  assert.equal(result.status, 'rejected');
  assert.equal(result.phase, 'check');
  assert.match(result.clientEventId, /^[a-f0-9-]{36}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'updates', 'jobs', `${jobId}.result.json`), 'utf8')).clientEventId, result.clientEventId);
  const accountKey = crypto.createHash('sha256').update(`\n${job.serverOrigin}\n${actorUserId}\n${clientDeviceId}`).digest('hex');
  const queue = new ClientDiagnosticQueue(path.join(root, 'client-state', 'accounts', accountKey, 'diagnostics.json'));
  const events = queue.pending();
  assert.equal(events.length, 1, '独立更新失败须在主进程退出后仍可补报');
  assert.equal(events[0].clientEventId, result.clientEventId);
  assert.equal(events[0].phase, 'check');
  assert.equal(events[0].stage, 'client_update');
  assert.equal(Object.hasOwn(events[0], 'message'), false);
  assert.equal(Object.hasOwn(events[0], 'manifestUrl'), false);
  console.log('PASS independent helper persists safe, attributable update failure');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
