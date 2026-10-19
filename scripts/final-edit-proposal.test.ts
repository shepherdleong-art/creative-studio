import assert from 'node:assert/strict';
import { findAvailableSourceWindow } from '../lib/final-edit/proposal.ts';

assert.deepEqual(
  findAvailableSourceWindow({ startFrame: 0, endFrame: 100 }, [{ startFrame: 0, endFrame: 40 }], 30),
  { startFrame: 40, endFrame: 70 },
);
assert.deepEqual(
  findAvailableSourceWindow({ startFrame: 0, endFrame: 100 }, [{ startFrame: 20, endFrame: 80 }], 30),
  { startFrame: 0, endFrame: 20 },
);
assert.equal(
  findAvailableSourceWindow({ startFrame: 10, endFrame: 20 }, [{ startFrame: 0, endFrame: 30 }], 5),
  null,
);
assert.equal(
  findAvailableSourceWindow({ startFrame: 0, endFrame: 20 }, [], 30, 24),
  null,
  'AI 补缺口不得生成不足 1 秒的黑闪片段',
);

console.log('final-edit proposal tests passed');
