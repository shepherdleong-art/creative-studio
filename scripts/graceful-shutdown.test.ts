import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import {
  gracefulShutdown,
  resetGracefulShutdownForTests,
  type GracefulShutdownDependencies,
} from '../lib/shutdown.ts';

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

try {
  // 编排顺序是公开停机契约:先停止领取/中止媒体,再等待,最后关闭数据库与 sidecar。
  {
    const events: string[] = [];
    const dependencies: GracefulShutdownDependencies = {
      scheduler: {
        running: true,
        async stop() {
          events.push('scheduler.stop');
        },
      },
      abortFfmpeg: () => {
        events.push('ffmpeg.abort');
        return 1;
      },
      waitForFfmpeg: async () => {
        events.push('ffmpeg.wait');
        return 0;
      },
      closeDatabase: () => events.push('db.close'),
      stopSidecar: () => { events.push('sidecar.stop'); },
    };

    const result = await gracefulShutdown({ timeoutMs: 100 }, dependencies);
    assert.deepEqual(events, [
      'scheduler.stop',
      'ffmpeg.abort',
      'ffmpeg.wait',
      'db.close',
      'sidecar.stop',
    ]);
    assert.deepEqual(result, { stopped: true, pendingTasks: 0 });
  }

  await resetGracefulShutdownForTests();

  // 单步超时不得把服务永久卡住,并且必须暴露仍未收尾的工作数量。
  {
    const dependencies: GracefulShutdownDependencies = {
      scheduler: {
        running: true,
        stop: () => new Promise<void>(() => undefined),
      },
      abortFfmpeg: () => 1,
      waitForFfmpeg: async () => 2,
      closeDatabase: () => undefined,
      stopSidecar: () => undefined,
    };
    const startedAt = Date.now();
    const result = await gracefulShutdown({ timeoutMs: 20 }, dependencies);
    assert.ok(Date.now() - startedAt < 500, '停机步骤超时后必须及时返回');
    assert.deepEqual(result, { stopped: false, pendingTasks: 3 });
  }

  await resetGracefulShutdownForTests();

  // 默认 FFmpeg 广播必须终止没有显式接入调度器 signal 的直接媒体任务。
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-graceful-shutdown-'));
    try {
      const output = path.join(root, 'long.mp4');
      const runPromise = runFfmpeg([
        '-f', 'lavfi', '-re', '-i', 'testsrc=duration=30:size=320x240:rate=25',
        '-pix_fmt', 'yuv420p', '-y', output,
      ]);
      await nextTick();
      const shutdown = gracefulShutdown(
        { timeoutMs: 2_000 },
        { scheduler: null, closeDatabase: () => undefined, stopSidecar: () => undefined },
      );
      await assert.rejects(runPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError');
      assert.deepEqual(await shutdown, { stopped: true, pendingTasks: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log('graceful shutdown tests passed');
} finally {
  await resetGracefulShutdownForTests();
}
