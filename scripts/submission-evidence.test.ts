import assert from 'node:assert/strict';

import {
  classifyCanvasSubmissionFailure,
  classifyImageSubmissionFailure,
  classifySubmissionOutcome,
  classifyVideoSubmissionFailure,
  providerHttpError,
  type SubmissionEvidence,
} from '../lib/media-core/submission-evidence.ts';

const secret = 'sk-live-secret';
const signedUrl = 'https://media.example.test/result.png?token=signed-secret';

function assertUnknown(evidence: SubmissionEvidence, label: string): void {
  assert.equal(evidence.state, 'unknown', label);
  assert.equal(evidence.occupancy.remote, 'hold', `${label}：结果不明不得释放远端名额`);
  assert.equal(evidence.allowedActions.includes('retry_submit'), false, `${label}：未知结果不得允许重提`);
  assert.ok(evidence.allowedActions.includes('reconcile'), `${label}：未知结果必须允许核查`);
  assert.match(evidence.employee.detail, /不会自动重复提交|不会重新生成/, `${label}：员工文案必须说明不会重提`);
}

for (const wrapper of [
  classifyImageSubmissionFailure,
  classifyVideoSubmissionFailure,
  classifyCanvasSubmissionFailure,
]) {
  const entry = wrapper === classifyImageSubmissionFailure ? 'image'
    : wrapper === classifyVideoSubmissionFailure ? 'video' : 'canvas';

  for (const status of [400, 401, 403, 404, 409, 413, 422]) {
    const evidence = wrapper({
      taskId: `${entry}-task-1`,
      businessAttemptNo: 3,
      adapterId: `${entry}-adapter`,
      stage: 'submit',
      source: 'adapter',
      error: providerHttpError(status, `上游拒绝 ${secret} ${signedUrl}`),
    });
    assert.equal(evidence.state, 'confirmed_not_created', `${entry} HTTP ${status}`);
    assert.equal(evidence.identity.taskId, `${entry}-task-1`, `${entry}：必须保留原任务身份`);
    assert.equal(evidence.identity.businessAttemptNo, 3, `${entry}：必须保留原业务次数`);
    assert.equal(evidence.occupancy.remote, 'release', `${entry} HTTP ${status}：明确拒绝应释放名额`);
    assert.equal(evidence.occupancy.releaseWhen, 'confirmed_not_created');
    assert.ok(evidence.allowedActions.includes('retry_submit'));
    assert.equal(JSON.stringify(evidence).includes(secret), false, `${entry}：不得回传密钥`);
    assert.equal(JSON.stringify(evidence).includes(signedUrl), false, `${entry}：不得回传签名 URL`);
    assert.equal(JSON.stringify(evidence).includes('上游拒绝'), false, `${entry}：不得回传完整上游响应`);
  }

  for (const error of [
    providerHttpError(429, `rate limited ${secret}`),
    providerHttpError(500, `gateway failed ${signedUrl}`),
    providerHttpError(503, 'temporarily unavailable'),
    new TypeError(`fetch failed: ${signedUrl}`),
    new SyntaxError(`unexpected token ${secret}`),
  ]) {
    assertUnknown(wrapper({
      taskId: `${entry}-unknown`,
      businessAttemptNo: 1,
      adapterId: `${entry}-adapter`,
      stage: 'submit',
      source: 'transport',
      error,
    }), `${entry} ${(error as { httpStatus?: number }).httpStatus ?? error.name}`);
  }

  const accepted = classifySubmissionOutcome({
    entry,
    taskId: `${entry}-accepted`,
    businessAttemptNo: 2,
    adapterId: `${entry}-adapter`,
    stage: 'poll',
    source: 'provider',
    outcome: 'accepted',
    remoteId: 'remote-123',
  });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.remoteId, 'remote-123', `${entry}：必须保留远端身份`);
  assert.equal(accepted.occupancy.remote, 'hold');
  assert.deepEqual(accepted.allowedActions, ['poll_remote']);

  const queryFailure = wrapper({
    taskId: `${entry}-poll-timeout`,
    businessAttemptNo: 2,
    adapterId: `${entry}-adapter`,
    stage: 'poll',
    source: 'transport',
    remoteId: 'remote-poll-123',
    error: new TypeError(`query timeout ${signedUrl}`),
  });
  assert.equal(queryFailure.state, 'unknown');
  assert.equal(queryFailure.issue, 'remote_query_failed', `${entry}：本地查询失败不能被写成远端失败`);
  assert.equal(queryFailure.remoteId, 'remote-poll-123', `${entry}：查询失败必须保留原远端身份`);
  assert.equal(queryFailure.occupancy.remote, 'hold');
  assert.deepEqual(queryFailure.allowedActions, ['poll_remote', 'reconcile']);

  const downloadFailure = wrapper({
    taskId: `${entry}-download`,
    businessAttemptNo: 2,
    adapterId: `${entry}-adapter`,
    stage: 'download',
    source: 'persisted',
    remoteId: 'remote-download-123',
    error: providerHttpError(502, `download failed ${signedUrl}`),
  });
  assert.equal(downloadFailure.state, 'terminal_succeeded', `${entry}：下载失败不等于生成失败`);
  assert.equal(downloadFailure.issue, 'download_failed');
  assert.equal(downloadFailure.remoteId, 'remote-download-123');
  assert.deepEqual(downloadFailure.allowedActions, ['retry_download']);
  assert.equal(downloadFailure.occupancy.remote, 'release');
  assert.match(downloadFailure.employee.detail, /不会重新调用模型/);

  const remoteFailure = classifySubmissionOutcome({
    entry,
    taskId: `${entry}-remote-failed`,
    businessAttemptNo: 2,
    adapterId: `${entry}-adapter`,
    stage: 'poll',
    source: 'provider',
    outcome: 'terminal_failed',
    remoteId: 'remote-failed-123',
    errorCode: 'content_rejected',
  });
  assert.equal(remoteFailure.state, 'terminal_failed');
  assert.equal(remoteFailure.issue, 'remote_terminal_failed');
  assert.equal(remoteFailure.error?.code, 'content_rejected');
  assert.equal(remoteFailure.occupancy.remote, 'release');

  const succeeded = classifySubmissionOutcome({
    entry,
    taskId: `${entry}-succeeded`,
    businessAttemptNo: 2,
    adapterId: `${entry}-adapter`,
    stage: 'poll',
    source: 'provider',
    outcome: 'terminal_succeeded',
    remoteId: 'remote-succeeded-123',
  });
  assert.equal(succeeded.state, 'terminal_succeeded');
  assert.equal(succeeded.issue, 'none');
  assert.deepEqual(succeeded.allowedActions, []);
}

console.log('submission-evidence.test.ts 通过');
