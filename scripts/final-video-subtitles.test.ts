// scripts/final-video-subtitles.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildNarrationAss, resolveFontFile, platformFontName } from '../lib/final-video/subtitles.ts';
import type { NarrationBeat } from '../lib/final-video/types.ts';

const style = { enabled: true, fontSize: 56, color: '#ff0000', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 10 };

// 字体解析：返回空串或真实存在的文件
const font = resolveFontFile();
assert.ok(font === '' || fs.existsSync(font));
assert.ok(platformFontName().length > 0);

function beat(overrides: Partial<NarrationBeat> = {}): NarrationBeat {
  return {
    beatId: 'beat-0',
    index: 0,
    text: '第一句',
    subtitleText: '第一句',
    shotId: 'shot-0',
    imageAssetId: 'image-0',
    audioPath: '/tmp/beat-0.m4a',
    durationSec: 2.5,
    startSec: 0,
    ...overrides,
  };
}

const oneBeatAss = buildNarrationAss([beat()], 1, style, 1080, 1920);
assert.equal((oneBeatAss.match(/^Dialogue:/gm) || []).length, 1);
assert.match(oneBeatAss, /Dialogue: 0,0:00:01\.00,0:00:03\.50,.*,,第一句/);

// 两句相邻（原先若共享 groupId 会被合并成一条）——现在一句一条，绝不合并
const twoAdjacentBeats = [
  beat({ text: '一句话，', subtitleText: '一句话，', durationSec: 1.25 }),
  beat({ beatId: 'beat-1', index: 1, text: '跨越两个画面。', subtitleText: '跨越两个画面。', audioPath: '/tmp/beat-1.m4a', startSec: 1.25, durationSec: 2.75 }),
];
const twoAdjacentBeatsBefore = structuredClone(twoAdjacentBeats);
const styleBefore = structuredClone(style);
const twoAdjacentAss = buildNarrationAss(twoAdjacentBeats, 0.5, style, 1080, 1920);
const twoAdjacentDialogues = twoAdjacentAss.match(/^Dialogue:.*$/gm) || [];
assert.equal(twoAdjacentDialogues.length, 2);
assert.match(twoAdjacentDialogues[0], /0:00:00\.50,0:00:01\.75,.*,,一句话，/);
assert.match(twoAdjacentDialogues[1], /0:00:01\.75,0:00:04\.50,.*,,跨越两个画面。/);
assert.deepEqual(twoAdjacentBeats, twoAdjacentBeatsBefore);
assert.deepEqual(style, styleBefore);

// 乱序输入按 index 排序渲染
const orderedBeatsAss = buildNarrationAss([
  beat({ beatId: 'beat-1', index: 1, text: '第二句', subtitleText: '第二句', audioPath: '/tmp/beat-1.m4a', startSec: 1, durationSec: 2 }),
  beat({ text: '第一句', subtitleText: '第一句', durationSec: 1 }),
], 0, style, 1080, 1920);
const orderedDialogues = orderedBeatsAss.match(/^Dialogue:.*$/gm) || [];
assert.equal(orderedDialogues.length, 2);
assert.match(orderedDialogues[0], /0:00:00\.00,0:00:01\.00,.*第一句/);
assert.match(orderedDialogues[1], /0:00:01\.00,0:00:03\.00,.*第二句/);

// 空白文本的 beat 被跳过；有内容的文本会被 trim 后渲染（不再保留两边空格）
const blankBeatAss = buildNarrationAss([
  beat({ text: ' \n ', subtitleText: ' \n ' }),
  beat({ beatId: 'beat-1', index: 1, text: '  保留两边  ', subtitleText: '  保留两边  ', audioPath: '/tmp/beat-1.m4a', startSec: 2.5 }),
], 0, style, 1080, 1920);
assert.equal((blankBeatAss.match(/^Dialogue:/gm) || []).length, 1);
assert.match(blankBeatAss, /,,保留两边$/m);

const boundaryAss = buildNarrationAss([beat({ startSec: 59.995, durationSec: 0.01 })], 0.005, style, 1080, 1920);
assert.match(boundaryAss, /Dialogue: 0,0:01:00\.00,0:01:00\.01,/);

const disabledAss = buildNarrationAss([beat()], 1, { ...style, enabled: false }, 1080, 1920);
assert.match(disabledAss, /\[Events\]/);
assert.equal((disabledAss.match(/^Dialogue:/gm) || []).length, 0);

function rejects(beats: NarrationBeat[], introDurationSec = 0): void {
  assert.throws(() => buildNarrationAss(beats, introDurationSec, style, 1080, 1920));
}

rejects([beat({ beatId: 'same' }), beat({ beatId: 'same', index: 1, startSec: 2.5 })]);
rejects([beat(), beat({ beatId: 'beat-1', index: 0, startSec: 2.5 })]);
rejects([beat(), beat({ beatId: 'beat-2', index: 2, startSec: 2.5 })]);
rejects([beat({ index: -1 })]);
rejects([beat({ index: 0.5 })]);
rejects([beat({ startSec: -1 })]);
rejects([beat({ startSec: Number.NaN })]);
rejects([beat({ durationSec: 0 })]);
rejects([beat({ durationSec: Number.POSITIVE_INFINITY })]);
rejects([beat()], -1);
rejects([beat()], Number.NaN);

// 一句 = 一条 Dialogue（不再按 groupId 合并）
{
  const style = { enabled: true, fontSize: 56, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 18 };
  const beats = [
    { beatId: 'b0', index: 0, text: '第一句', subtitleText: '第一句', shotId: 's1', imageAssetId: 'i1', audioPath: '/tmp/a0.m4a', durationSec: 3, startSec: 0 },
    { beatId: 'b1', index: 1, text: '第二句', subtitleText: '第二句字幕', shotId: 's2', imageAssetId: 'i2', audioPath: '/tmp/a1.m4a', durationSec: 4, startSec: 3 },
  ];
  const ass = buildNarrationAss(beats, 2, style, 1080, 1920);
  const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 2);
  // 渲染的是 subtitleText，不是 text
  assert.ok(dialogues[1].includes('第二句字幕'));
  // 起止时间含片头偏移
  assert.ok(dialogues[0].includes('0:00:02.00'));
}
console.log('subtitles one-per-beat: OK');

console.log('final-video-subtitles tests passed');
