import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-execution-journal-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');

const identity = {
  operationId: 'operation-1', attemptId: 'attempt-1', permitId: 'permit-1', actorId: 'user-a',
  module: 'images', step: 'submit', inputHash: 'hash-a', transportSeq: 1,
  requiredPools: ['provider-a:remote'], policyVersion: 3, accountingPeriod: '2026-11', currency: 'CNY' as const, reservedMinor: 125,
};

try {
  const journal = createExecutionJournal({ deploymentId: 'deployment-journal', maxSegmentBytes: 420 });
  assert.equal(journal.directory, path.join(fixtureRoot, 'storage', 'execution-journal', 'deployment-journal'));
  const first = journal.appendIntent({
    ...identity,
    requestBody: 'must not be persisted',
    authorization: 'secret',
    signedUrl: 'https://example.test/signed',
  });
  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, null);
  const second = journal.appendReceipt({
    ...identity,
    remoteId: 'remote-1', resultRef: 'asset-1', terminalState: 'succeeded',
    actualCost: { currency: 'CNY', minor: 130 }, costState: 'settled',
  });
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);
  const third = journal.appendIntent({ ...identity, attemptId: 'attempt-2', transportSeq: 1 });
  assert.equal(third.seq, 3);
  assert.equal(third.prevHash, second.hash);
  assert.ok(fs.readdirSync(journal.directory).filter((name) => name.endsWith('.jsonl')).length >= 2, '按大小轮转 segment');
  assert.deepEqual(journal.scan().map((record) => record.seq), [1, 2, 3]);
  assert.equal(journal.verify().valid, true);
  const raw = fs.readdirSync(journal.directory).filter((name) => name.endsWith('.jsonl'))
    .map((name) => fs.readFileSync(path.join(journal.directory, name), 'utf8')).join('');
  assert.equal(raw.includes('must not be persisted'), false);
  assert.equal(raw.includes('authorization'), false);
  assert.equal(raw.includes('signedUrl'), false);

  const segments = fs.readdirSync(journal.directory).filter((name) => name.endsWith('.jsonl')).sort();
  const active = path.join(journal.directory, segments.at(-1)!);
  fs.appendFileSync(active, '{"schemaVersion":1', 'utf8');
  const repaired = journal.verify({ repairTail: true });
  assert.equal(repaired.valid, true);
  assert.deepEqual(repaired.records.map((record) => record.seq), [1, 2, 3]);
  const quarantine = fs.readdirSync(journal.directory).filter((name) => name.includes('.tail-'));
  assert.equal(quarantine.length, 1, '中断尾部必须隔离并保留诊断副本');
  assert.ok(fs.readFileSync(path.join(journal.directory, quarantine[0]), 'utf8').includes('{"schemaVersion":1'));
  const fourth = journal.appendReceipt({ ...identity, attemptId: 'attempt-2', terminalState: 'unknown' });
  assert.equal(fourth.seq, 4);
  assert.equal(fourth.prevHash, third.hash);
  assert.equal(journal.verify().valid, true);

  const beforeCorrupt = fs.readFileSync(active, 'utf8');
  fs.writeFileSync(active, beforeCorrupt.replace('"attemptId":"attempt-2"', '"attemptId":"tampered"'), 'utf8');
  assert.equal(journal.verify().valid, false, 'hash 链篡改必须阻断新付费');
  assert.throws(() => journal.appendIntent({ ...identity, attemptId: 'attempt-3' }), /journal/);

  const failing = createExecutionJournal({
    deploymentId: 'deployment-fsync', fsync: () => { throw new Error('injected fsync failure'); },
  });
  assert.throws(() => failing.appendIntent(identity), /fsync/);

  console.log('execution journal tests passed');
} finally {
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
