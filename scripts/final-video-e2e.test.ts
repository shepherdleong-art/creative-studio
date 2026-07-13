// scripts/final-video-e2e.test.ts
// 用 lavfi 生成 2 个测试片段 + 1 段正弦 BGM，跑「solver→渲染」全链路。
// 运行约 10-20 秒。仅本地/CI 手动跑：node scripts/final-video-e2e.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../lib/ffmpeg.ts';
import { solveBgmTimeline } from '../lib/final-video/solve-bgm-timeline.ts';
import { solveTimeline } from '../lib/final-video/solve-timeline.ts';
import { buildSolvedRenderArgs } from '../lib/final-video/ffmpeg-graph.ts';
import { buildCoverArgs } from '../lib/final-video/cover.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-e2e-'));
const clip = (name: string) => path.join(tmp, name);

async function main() {
  const c1 = clip('c1.mp4');
  const c2 = clip('c2.mp4');
  const bgm = path.join(tmp, 'bgm.m4a');
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=30', '-pix_fmt', 'yuv420p', '-y', c1]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=360x640:rate=30', '-pix_fmt', 'yuv420p', '-y', c2]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'aac', '-y', bgm]);

  const clip1Duration = await probeDurationSec(c1);
  const clip2Duration = await probeDurationSec(c2);

  const coverJpg = path.join(tmp, 'cover.jpg');
  await runFfmpeg(
    buildCoverArgs({
      sourceVideoPath: c1, titleText: '测试标题', titleSize: 48, titleColor: '#ffffff',
      width: 540, height: 960, fontFile: '', outJpgPath: coverJpg,
    })
  );
  assert.ok(fs.existsSync(coverJpg));

  const solved = solveTimeline({
    beats: [
      { beatId: 'beat-1', index: 0, text: '短画面', subtitleText: '短画面', shotId: 'a', imageAssetId: 'image-1', audioPath: '/unused/beat-1.m4a', durationSec: 1, startSec: 0 },
      { beatId: 'beat-2', index: 1, text: '末段定格', subtitleText: '末段定格', shotId: 'b', imageAssetId: 'image-2', audioPath: '/unused/beat-2.m4a', durationSec: 4.5, startSec: 1 },
    ],
    clips: [
      {
        clipId: 'clip-1', shotId: 'a', shotIndex: 1, videoPath: c1, clipDurationSec: clip1Duration,
        sourceImageId: 'image-1', sourceImagePath: '/unused/image-1.png',
      },
      {
        clipId: 'clip-2', shotId: 'b', shotIndex: 2, videoPath: c2, clipDurationSec: clip2Duration,
        sourceImageId: 'image-2', sourceImagePath: '/unused/image-2.png',
      },
    ],
    plan: {
      assignments: [
        { assignmentId: 'assignment-1', clipId: 'clip-1', beatIds: ['beat-1'] },
        { assignmentId: 'assignment-2', clipId: 'clip-2', beatIds: ['beat-2'] },
      ],
      gaps: [],
    },
    introDurationSec: 0, targetDurationSec: 5.5, durationTolerancePct: 0.2, fps: 30,
  });
  assert.ok(solved.segments.some((segment) => segment.trimEndToSec !== null), 'solver must produce a trimmed segment');
  assert.ok(solved.segments.at(-1)!.padStopSec > 0, 'solver must freeze the final segment');

  const solvedOut = path.join(tmp, 'solved-final.mp4');
  await runFfmpeg(buildSolvedRenderArgs({
    segments: solved.segments, width: 540, height: 960, fps: 30,
    totalDurationSec: solved.totalDurationSec, introDurationSec: 0, coverJpgPath: null,
    narrationTrackPath: null, bgm: null, duckingSupported: false,
    assPath: null, fontsDir: '', outputPath: solvedOut,
  }), { timeoutMs: 120_000 });
  const solvedDuration = await probeDurationSec(solvedOut);
  const solvedTolerance = Math.max(0.1, 2 / 30);
  assert.ok(
    Math.abs(solvedDuration - solved.totalDurationSec) <= solvedTolerance,
    `solved duration ${solvedDuration} ≈ ${solved.totalDurationSec} within ${solvedTolerance}`,
  );

  const bgmSolved = solveBgmTimeline({
    selectedClipIds: ['clip-2', 'clip-1'],
    clips: [
      {
        clipId: 'clip-1', shotId: 'a', shotIndex: 1, videoPath: c1, clipDurationSec: clip1Duration,
        sourceImageId: 'image-1', sourceImagePath: '/unused/image-1.png',
      },
      {
        clipId: 'clip-2', shotId: 'b', shotIndex: 2, videoPath: c2, clipDurationSec: clip2Duration,
        sourceImageId: 'image-2', sourceImagePath: '/unused/image-2.png',
      },
    ],
    introDurationSec: 1, targetDurationSec: 5.5, fps: 30,
  });
  assert.deepEqual(bgmSolved.segments.map((segment) => segment.clipId), ['clip-2', 'clip-1']);
  assert.equal(bgmSolved.segments.at(-1)?.trimEndToSec, 1.5, 'BGM solver trims the final selected clip to target');
  const bgmSolvedOut = path.join(tmp, 'bgm-solved-final.mp4');
  const bgmSolvedArgs = buildSolvedRenderArgs({
    segments: bgmSolved.segments, width: 540, height: 960, fps: 30,
    totalDurationSec: bgmSolved.totalDurationSec, introDurationSec: 1, coverJpgPath: coverJpg,
    narrationTrackPath: null, bgm: { path: bgm, volume: 0.3, ducking: false }, duckingSupported: false,
    assPath: null, fontsDir: '', outputPath: bgmSolvedOut,
  });
  assert.match(bgmSolvedArgs[bgmSolvedArgs.indexOf('-filter_complex') + 1], /afade=t=out:st=4\.00:d=1\.5/);
  await runFfmpeg(bgmSolvedArgs, { timeoutMs: 120_000 });
  const bgmSolvedDuration = await probeDurationSec(bgmSolvedOut);
  assert.ok(Math.abs(bgmSolvedDuration - bgmSolved.totalDurationSec) <= solvedTolerance, `BGM duration ${bgmSolvedDuration} ≈ ${bgmSolved.totalDurationSec}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`final-video-e2e passed (solved ${solvedDuration.toFixed(2)}s output)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
