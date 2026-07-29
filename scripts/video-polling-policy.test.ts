import assert from 'node:assert/strict';
import { resolveVideoPollingTimeoutMs } from '../lib/video-polling-policy.ts';

const fiveMinutes = 5 * 60_000;
const fifteenMinutes = 15 * 60_000;

assert.equal(
  resolveVideoPollingTimeoutMs({
    requestedTimeoutMs: fiveMinutes,
    providerType: 'jimeng',
    model: 'doubao-seedance-2-0-260128',
    durationSec: 15,
  }),
  fifteenMinutes,
  '即梦 2.0 的 15 秒视频应至少轮询 15 分钟',
);

assert.equal(
  resolveVideoPollingTimeoutMs({
    requestedTimeoutMs: 20 * 60_000,
    providerType: 'jimeng',
    model: 'doubao-seedance-2-0-260128',
    durationSec: 15,
  }),
  20 * 60_000,
  '用户设置的更长超时不应被缩短',
);

assert.equal(
  resolveVideoPollingTimeoutMs({
    requestedTimeoutMs: fiveMinutes,
    providerType: 'jimeng',
    model: 'doubao-seedance-1-5-pro-251215',
    durationSec: 15,
  }),
  fiveMinutes,
  '即梦 1.5 继续使用原轮询时长',
);

assert.equal(
  resolveVideoPollingTimeoutMs({
    requestedTimeoutMs: fiveMinutes,
    providerType: 'kling',
    model: 'kling-v3',
    durationSec: 15,
  }),
  fiveMinutes,
  '其他视频供应商继续使用原轮询时长',
);

console.log('video polling policy tests passed');
