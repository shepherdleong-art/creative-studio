import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createEvidenceRun,
  percentile,
  redactEvidence,
  summarizeRequests,
} from './team-server/acceptance-lib.mjs';

const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-acceptance-evidence-'));
const dataRoot = path.join(outputRoot, 'private', 'user-data');
try {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
  assert.deepEqual(summarizeRequests([
    { kind: 'list', status: 200, durationMs: 10 },
    { kind: 'list', status: 200, durationMs: 30 },
    { kind: 'edit', status: 500, durationMs: 20 },
  ]), {
    count: 3, p50Ms: 20, p95Ms: 30, serverErrors: 1, serverErrorRate: 1 / 3,
    byKind: {
      list: { count: 2, p50Ms: 10, p95Ms: 30, serverErrors: 0 },
      edit: { count: 1, p50Ms: 20, p95Ms: 20, serverErrors: 1 },
    },
  });

  const redacted = redactEvidence({
    dataRoot,
    command: `node runner --root ${dataRoot}`,
    password: 'do-not-record',
    nested: { authorization: 'Bearer do-not-record', message: `root=${dataRoot}` },
  }, [dataRoot]);
  assert.equal(JSON.stringify(redacted).includes('do-not-record'), false);
  assert.equal(JSON.stringify(redacted).includes(outputRoot), false);
  assert.match(redacted.command, /\[data-root:[a-f0-9]{12}\]/);

  const run = createEvidenceRun({
    outputRoot,
    level: 'L1',
    release: { sourceCommit: 'c5c38c4', version: '0.7.1' },
    config: { durationSeconds: 2, concurrency: 20 },
    dataRoots: [dataRoot],
  });
  assert.throws(() => run.record({
    matrixIds: ['A01'], name: 'empty pass', command: 'node fake', assertions: [], evidence: [], result: 'passed',
  }), /assertions|evidence/);
  run.record({
    matrixIds: ['A01'], name: 'real assertion', command: 'node fixture.test.ts',
    assertions: ['fixture exited 0'], evidence: ['fixture.log'], result: 'passed', durationMs: 12,
  });
  run.record({
    level: 'L3', matrixIds: ['R02'], name: '现场 SCM', steps: ['在目标服务账号执行部署手册 D07'],
    assertions: ['无人登录且任务不重复提交'], evidence: [], result: 'blocked', reason: '缺少目标 Windows Server',
  });
  const summaryPath = run.finish();
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.records.length, 2);
  assert.equal(summary.counts.passed, 1);
  assert.equal(summary.counts.blocked, 1);
  assert.equal(summary.byLevel.L3.blocked, 1);
  assert.equal(summary.release.sourceCommit, 'c5c38c4');
  assert.equal(summary.config.concurrency, 20);
  assert.equal(JSON.stringify(summary).includes(dataRoot), false);
  assert.ok(fs.existsSync(path.join(run.runDirectory, 'results.jsonl')));
  const guard = path.resolve('scripts/team-server/no-external-network.cjs');
  const blocked = spawnSync(process.execPath, ['--require', guard, '--eval',
    "require('node:net').connect({ host: '192.0.2.1', port: 80 })"], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /禁止外网连接/);
  console.log('team acceptance evidence and metric tests passed');
} finally {
  fs.rmSync(outputRoot, { recursive: true, force: true });
}
