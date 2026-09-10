import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';
import { probeVideoMedia } from '../lib/ffmpeg.ts';

const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
try {
  for (const failure of ['throw', 'error', 'close'] as const) {
    let calls = 0;
    const spawn = mock.method(childProcess, 'spawn', () => {
      calls++;
      if (calls > 1 || failure === 'throw') throw new Error('spawn EFTYPE');
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      queueMicrotask(() => failure === 'error' ? child.emit('error', new Error('ffprobe unavailable')) : child.emit('close', 1));
      return child;
    });
    syncBuiltinESMExports();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        probeVideoMedia('fixture.mp4'),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`metadata request stuck after ${failure}`)), 300); }),
      ]);
      assert.equal(result.durationUs, 0);
      assert.match(result.errorMessage || '', /EFTYPE/);
      assert.equal(calls, 2);
      assert.deepEqual(unhandled, [], '回退失败不得产生游离 rejection');
    } finally {
      clearTimeout(timer);
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  }
} finally {
  process.removeListener('unhandledRejection', onUnhandled);
}
console.log('probe-video-media failure settlement tests passed');
