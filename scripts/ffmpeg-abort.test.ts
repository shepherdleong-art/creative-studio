// scripts/ffmpeg-abort.test.ts
//
// Phase D runFfmpeg AbortSignal 回归(交接文档 §5.1):
//   - runFfmpeg(..., { signal }) 能终止直接 FFmpeg 子进程。
//   - 中止后必须等待子进程真正退出再 reject,错误可区分为 abort。
//   - 已经 aborted 的 signal 传入时不应该先 spawn 一次 ffmpeg。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../lib/ffmpeg.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-ffmpeg-abort-'));

try {
  // --- 场景 1:abort 必须让子进程真正提前终止,而不是等 30 秒自然完成 ---
  {
    const outPath = path.join(tmpDir, 'scene1.mp4');
    const controller = new AbortController();
    const startedAt = Date.now();
    const runPromise = runFfmpeg(
      ['-f', 'lavfi', '-re', '-i', 'testsrc=duration=30:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-y', outPath],
      { signal: controller.signal },
    );
    // 给 ffmpeg 一点时间真正开始写文件,再触发 abort
    await new Promise((resolve) => setTimeout(resolve, 700));
    controller.abort();

    let rejected = false;
    let abortError: unknown;
    try {
      await runPromise;
    } catch (error) {
      rejected = true;
      abortError = error;
    }
    const elapsedMs = Date.now() - startedAt;
    assert.ok(rejected, 'abort 必须让 runFfmpeg 的 promise reject,而不是等待 30 秒自然完成');
    assert.ok(elapsedMs < 5_000, `abort 后必须迅速 reject(实际 ${elapsedMs}ms),不能等到 30 秒任务跑完`);
    assert.ok(
      abortError instanceof Error && (abortError.name === 'AbortError' || /abort/i.test(abortError.message)),
      'abort 触发的错误必须能被识别为 abort,不能和普通失败/超时混淆',
    );

    // 确认底层 ffmpeg 进程真的被终止了,而不是 runFfmpeg 只是放弃等待:
    // 如果进程仍在写入,输出文件会持续增长;真正终止后文件大小必须趋于稳定。
    const sizeAfterAbort = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const sizeLater = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    assert.equal(sizeLater, sizeAfterAbort, '子进程必须真的终止:abort 完成后输出文件不能继续增长');
  }

  // --- 场景 2:调用时 signal 已经是 aborted 状态,必须直接拒绝,不能先 spawn 一次 ffmpeg ---
  {
    const outPath = path.join(tmpDir, 'scene2.mp4');
    const controller = new AbortController();
    controller.abort();
    let rejected = false;
    try {
      await runFfmpeg(
        ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-y', outPath],
        { signal: controller.signal },
      );
    } catch {
      rejected = true;
    }
    assert.ok(rejected, '已经 aborted 的 signal 必须让 runFfmpeg 直接拒绝');
    assert.ok(!fs.existsSync(outPath), '已经 aborted 时不应该产生输出文件(不能先 spawn 再取消)');
  }

  // --- 场景 3:abort 监听器必须被清理,不能在正常完成后继续持有 listener 或重复 settle ---
  {
    const outPath = path.join(tmpDir, 'scene3.mp4');
    const controller = new AbortController();
    await runFfmpeg(
      ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=25', '-pix_fmt', 'yuv420p', '-y', outPath],
      { signal: controller.signal },
    );
    assert.ok(fs.existsSync(outPath), '未被 abort 时任务必须正常完成并产生输出');
    // 事后再 abort 一个已完成任务用过的 controller,不应该抛出或产生副作用
    assert.doesNotThrow(() => controller.abort(), '任务完成后 abort 同一个 controller 不应该有副作用');
  }

  console.log('ffmpeg-abort tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
