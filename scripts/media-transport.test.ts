import assert from 'node:assert/strict';
import {
  validateMediaTransportInput,
  withPreparedMediaLease,
  type MediaTransport,
  type MediaTransportInput,
  type PreparedMediaLease,
} from '../lib/media-transport.ts';

const input: MediaTransportInput = {
  projectId: 'project-1',
  batchId: 'batch-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
  assetId: 'asset-1',
  mediaKind: 'video',
  absolutePath: '/fixtures/video.mp4',
  contentFingerprint: `sha256:${'a'.repeat(64)}`,
  mimeType: 'video/mp4',
  sizeBytes: 1234,
};

assert.deepEqual(validateMediaTransportInput(input), input);
assert.throws(
  () => validateMediaTransportInput({ ...input, absolutePath: 'relative/video.mp4' }),
  /绝对路径/,
);
assert.throws(
  () => validateMediaTransportInput({ ...input, contentFingerprint: 'sha256:short' }),
  /SHA-256/,
);

const events: string[] = [];
let releaseCount = 0;
const lease: PreparedMediaLease = {
  id: 'lease-1',
  transportId: 'fixture',
  opaqueUrl: 'https://media.invalid/lease-1',
  contentFingerprint: input.contentFingerprint,
  issuedAt: '2026-08-04T00:00:00.000Z',
  expiresAt: '2026-08-04T00:05:00.000Z',
};
const transport: MediaTransport = {
  id: 'fixture',
  async prepare(received) {
    assert.deepEqual(received, input);
    events.push('prepare');
    return lease;
  },
  async release(received) {
    assert.equal(received.id, lease.id);
    events.push('release');
    releaseCount += 1;
  },
};
const leaseClock = { now: () => new Date('2026-08-04T00:01:00.000Z') };

const value = await withPreparedMediaLease(transport, input, async (prepared) => {
  events.push('use');
  assert.equal(prepared.opaqueUrl, lease.opaqueUrl);
  return 'ok';
}, leaseClock);
assert.equal(value, 'ok');
assert.deepEqual(events, ['prepare', 'use', 'release']);

events.length = 0;
await assert.rejects(
  withPreparedMediaLease(transport, input, async () => {
    events.push('use');
    throw new Error('analysis failed');
  }, leaseClock),
  /analysis failed/,
);
assert.deepEqual(events, ['prepare', 'use', 'release'], '失败也必须释放租约');

events.length = 0;
const controller = new AbortController();
await assert.rejects(
  withPreparedMediaLease(transport, input, async () => {
    events.push('use');
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  }, { signal: controller.signal, ...leaseClock }),
  (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
);
assert.deepEqual(events, ['prepare', 'use', 'release'], '取消也必须释放租约');
assert.equal(releaseCount, 3);

const wrongFingerprintTransport: MediaTransport = {
  ...transport,
  async prepare() {
    return { ...lease, contentFingerprint: `sha256:${'b'.repeat(64)}` };
  },
};
await assert.rejects(
  withPreparedMediaLease(wrongFingerprintTransport, input, async () => undefined, leaseClock),
  /指纹不一致/,
);

let expiredLeaseUsed = false;
let expiredLeaseReleased = false;
const expiredTransport: MediaTransport = {
  ...transport,
  async prepare() {
    return {
      ...lease,
      id: 'expired-lease',
      issuedAt: '2026-08-03T23:00:00.000Z',
      expiresAt: '2026-08-04T00:00:00.000Z',
    };
  },
  async release() {
    expiredLeaseReleased = true;
  },
};
await assert.rejects(
  withPreparedMediaLease(expiredTransport, input, async () => {
    expiredLeaseUsed = true;
  }, leaseClock),
  /已过期/,
);
assert.equal(expiredLeaseUsed, false, '已过期租约不得交给供应商 Adapter');
assert.equal(expiredLeaseReleased, true, '拒绝已过期租约后仍必须清理');

console.log('media transport contract tests passed');
