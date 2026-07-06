// scripts/final-video-graph.test.ts
import assert from 'node:assert/strict';
import { buildRenderArgs, escapeSubtitlePath, escapeDrawtext } from '../lib/final-video/ffmpeg-graph.ts';
import { buildCoverArgs } from '../lib/final-video/cover.ts';

assert.equal(escapeSubtitlePath('C:\\work\\a b.ass'), "C\\:/work/a b.ass");
assert.equal(escapeDrawtext("50%:off 'x'"), "50\\%\\:off \\'x\\'");

const seg = (i: number, clipDur: number, segDur: number) => ({
  shotId: `s${i}`, shotIndex: i, videoJobId: `vj${i}`, clipPath: `/clips/${i}.mp4`,
  clipDurationSec: clipDur, voiceover: '', subtitle: `字${i}`,
  narrationDurationSec: 0, segmentDurationSec: segDur, startSec: 0,
});

// 基础：两段拼接 + 字幕 + BGM（无口播）→ afade 收尾，无 sidechain
const a1 = buildRenderArgs({
  segments: [seg(1, 5, 5), seg(2, 4, 4)],
  width: 1080, height: 1920, fps: 30,
  totalDurationSec: 9,
  introDurationSec: 0, coverJpgPath: null,
  narrationTrackPath: null,
  bgm: { path: '/bgm/x.mp3', volume: 0.25, ducking: true },
  duckingSupported: true,
  assPath: '/tmp/subs.ass', fontsDir: '/System/Library/Fonts',
  outputPath: '/out/final.mp4',
});
const g1 = a1[a1.indexOf('-filter_complex') + 1];
assert.match(g1, /concat=n=2:v=1:a=0\[vcat\]/);
assert.match(g1, /subtitles=filename='\/tmp\/subs\.ass':fontsdir='\/System\/Library\/Fonts'\[vsub\]/);
assert.match(g1, /afade=t=out/);
assert.doesNotMatch(g1, /sidechaincompress/);
assert.ok(a1.includes('-stream_loop'));
assert.equal(a1[a1.indexOf('-t') + 1], '9.000');
assert.ok(a1.includes('-map'));
assert.equal(a1[a1.length - 1], '/out/final.mp4');

// 口播 + BGM + ducking 支持 → sidechaincompress；tpad 只出现在需要拉长的段
const a2 = buildRenderArgs({
  segments: [seg(1, 5, 6.15), seg(2, 4, 4)],
  width: 1080, height: 1920, fps: 30,
  totalDurationSec: 10.15,
  introDurationSec: 0, coverJpgPath: null,
  narrationTrackPath: '/work/narration.m4a',
  bgm: { path: '/bgm/x.mp3', volume: 0.2, ducking: true },
  duckingSupported: true,
  assPath: null, fontsDir: '',
  outputPath: '/out/final.mp4',
});
const g2 = a2[a2.indexOf('-filter_complex') + 1];
assert.match(g2, /sidechaincompress/);
assert.match(g2, /tpad=stop_mode=clone:stop_duration=1\.150/);
assert.equal((g2.match(/tpad/g) || []).length, 1);
assert.doesNotMatch(g2, /subtitles=/);

// ducking 不支持 → 退化为 amix
const a3 = buildRenderArgs({
  segments: [seg(1, 5, 5)],
  width: 1080, height: 1920, fps: 30,
  totalDurationSec: 5,
  introDurationSec: 0, coverJpgPath: null,
  narrationTrackPath: '/work/narration.m4a',
  bgm: { path: '/bgm/x.mp3', volume: 0.2, ducking: true },
  duckingSupported: false,
  assPath: null, fontsDir: '',
  outputPath: '/out/final.mp4',
});
assert.doesNotMatch(a3[a3.indexOf('-filter_complex') + 1], /sidechaincompress/);
assert.match(a3[a3.indexOf('-filter_complex') + 1], /amix=inputs=2/);

// 片头贴片：第一输入是 -loop 1 -t <intro> -i cover.jpg，concat n=3
const a4 = buildRenderArgs({
  segments: [seg(1, 5, 5), seg(2, 4, 4)],
  width: 1080, height: 1920, fps: 30,
  totalDurationSec: 10,
  introDurationSec: 1, coverJpgPath: '/out/cover.jpg',
  narrationTrackPath: null, bgm: null, duckingSupported: false,
  assPath: null, fontsDir: '',
  outputPath: '/out/final.mp4',
});
assert.equal(a4[a4.indexOf('-loop') + 1], '1');
assert.match(a4[a4.indexOf('-filter_complex') + 1], /concat=n=3:v=1:a=0\[vcat\]/);
// 无任何音频 → -an
assert.ok(a4.includes('-an'));

// ── Task 6: 封面生成 ──
const c1 = buildCoverArgs({
  sourceVideoPath: '/clips/1.mp4',
  titleText: '三大亮点', titleSize: 72, titleColor: '#ffffff',
  width: 1080, height: 1920,
  fontFile: '/System/Library/Fonts/PingFang.ttc',
  outJpgPath: '/out/cover.jpg',
});
assert.equal(c1[c1.indexOf('-ss') + 1], '0.5');
const vf1 = c1[c1.indexOf('-vf') + 1];
assert.match(vf1, /drawtext=text='三大亮点'/);
assert.match(vf1, /fontfile='\/System\/Library\/Fonts\/PingFang\.ttc'/);
assert.equal(c1[c1.length - 1], '/out/cover.jpg');

// 无标题 → 无 drawtext
const c2 = buildCoverArgs({
  sourceVideoPath: '/clips/1.mp4', titleText: '', titleSize: 72, titleColor: '#ffffff',
  width: 1080, height: 1920, fontFile: '', outJpgPath: '/out/cover.jpg',
});
assert.doesNotMatch(c2[c2.indexOf('-vf') + 1], /drawtext/);

// 模板卖点在渲染层兜底截断，且只取模板允许的条数
const c3 = buildCoverArgs({
  sourceVideoPath: '/clips/1.mp4',
  titleText: '标题', titleSize: 72, titleColor: '#ffffff',
  width: 360, height: 640,
  fontFile: '',
  outJpgPath: '/out/cover.jpg',
  templateId: 'luxury-01',
  sellingPoints: ['这是一个很长很长很长卖点', '第二条', '第三条', '第四条'],
});
const vf3 = c3[c3.indexOf('-vf') + 1];
assert.match(vf3, /drawtext=text='这是一个很长很…'/);
assert.doesNotMatch(vf3, /第四条/);

console.log('final-video-graph tests passed');
