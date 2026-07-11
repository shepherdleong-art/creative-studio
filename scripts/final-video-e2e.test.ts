// scripts/final-video-e2e.test.ts
// 用 lavfi 生成 2 个测试片段 + 1 段正弦 BGM，跑一遍「时间线→ASS→渲染参数→ffmpeg」全链路。
// 运行约 10-20 秒。仅本地/CI 手动跑：node scripts/final-video-e2e.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg, probeDurationSec } from '../lib/ffmpeg.ts';
import { buildTimeline } from '../lib/final-video/timeline.ts';
import { solveTimeline } from '../lib/final-video/solve-timeline.ts';
import { buildAss, resolveFontFile } from '../lib/final-video/subtitles.ts';
import { buildRenderArgs, buildSolvedRenderArgs } from '../lib/final-video/ffmpeg-graph.ts';
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

  const timeline = buildTimeline({
    scriptShots: [
      { shotId: 'a', shotIndex: 1, voiceover: '', subtitle: '第一段字幕' },
      { shotId: 'b', shotIndex: 2, voiceover: '', subtitle: '第二段字幕' },
    ],
    clips: [
      { shotId: 'a', videoJobId: 'v1', clipPath: c1, clipDurationSec: await probeDurationSec(c1) },
      { shotId: 'b', videoJobId: 'v2', clipPath: c2, clipDurationSec: await probeDurationSec(c2) },
    ],
    introDurationSec: 1,
  });
  assert.equal(timeline.segments.length, 2);

  const coverJpg = path.join(tmp, 'cover.jpg');
  await runFfmpeg(
    buildCoverArgs({
      sourceVideoPath: c1, titleText: '测试标题', titleSize: 48, titleColor: '#ffffff',
      width: 540, height: 960, fontFile: resolveFontFile(), outJpgPath: coverJpg,
    })
  );
  assert.ok(fs.existsSync(coverJpg));

  const assPath = path.join(tmp, 'subs.ass');
  fs.writeFileSync(
    assPath,
    buildAss(timeline.segments, { enabled: true, fontSize: 32, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 10 }, 540, 960),
    'utf-8'
  );

  const out = path.join(tmp, 'final.mp4');
  const font = resolveFontFile();
  await runFfmpeg(
    buildRenderArgs({
      segments: timeline.segments,
      width: 540, height: 960, fps: 30,
      totalDurationSec: timeline.totalDurationSec,
      introDurationSec: 1, coverJpgPath: coverJpg,
      narrationTrackPath: null,
      bgm: { path: bgm, volume: 0.3, ducking: false },
      duckingSupported: false,
      assPath, fontsDir: font ? path.dirname(font) : '',
      outputPath: out,
    }),
    { timeoutMs: 120_000 }
  );

  const dur = await probeDurationSec(out);
  assert.ok(Math.abs(dur - timeline.totalDurationSec) < 0.35, `duration ${dur} ≈ ${timeline.totalDurationSec}`);

  const clip1Duration = await probeDurationSec(c1);
  const clip2Duration = await probeDurationSec(c2);
  const solved = solveTimeline({
    beats: [
      { beatId: 'beat-1', groupId: 'group-1', index: 0, text: '短画面', audioPath: '/unused/group-1.m4a', durationSec: 1, startSec: 0 },
      { beatId: 'beat-2', groupId: 'group-2', index: 1, text: '末段定格', audioPath: '/unused/group-2.m4a', durationSec: 4.5, startSec: 1 },
    ],
    clips: [
      {
        clipId: 'clip-1', shotId: 'a', shotIndex: 1, videoPath: c1, clipDurationSec: clip1Duration,
        sourceImageId: 'image-1', sourceImagePath: '/unused/image-1.png', visualDescription: 'first',
        descriptionProviderId: null, descriptionModel: null,
      },
      {
        clipId: 'clip-2', shotId: 'b', shotIndex: 2, videoPath: c2, clipDurationSec: clip2Duration,
        sourceImageId: 'image-2', sourceImagePath: '/unused/image-2.png', visualDescription: 'second',
        descriptionProviderId: null, descriptionModel: null,
      },
    ],
    plan: {
      assignments: [
        { assignmentId: 'assignment-1', clipId: 'clip-1', beatIds: ['beat-1'] },
        { assignmentId: 'assignment-2', clipId: 'clip-2', beatIds: ['beat-2'] },
      ],
      gaps: [],
    },
    introDurationSec: 0, targetDurationSec: 5.5, durationTolerancePct: 0.2, maxClipSeconds: 5, fps: 30,
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
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`final-video-e2e passed (legacy ${dur.toFixed(2)}s, solved ${solvedDuration.toFixed(2)}s output)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
