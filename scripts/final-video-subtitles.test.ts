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
    groupId: 'group-0',
    index: 0,
    text: '第一句',
    audioPath: '/tmp/group-0.wav',
    durationSec: 2.5,
    startSec: 0,
    ...overrides,
  };
}

const oneBeatAss = buildNarrationAss([beat()], 1, style, 1080, 1920);
assert.equal((oneBeatAss.match(/^Dialogue:/gm) || []).length, 1);
assert.match(oneBeatAss, /Dialogue: 0,0:00:01\.00,0:00:03\.50,.*,,第一句/);

const splitSentence = [
  beat({ text: '一句话，', durationSec: 1.25 }),
  beat({ beatId: 'beat-1', index: 1, text: '跨越两个画面。', startSec: 1.25, durationSec: 2.75 }),
];
const splitSentenceBefore = structuredClone(splitSentence);
const styleBefore = structuredClone(style);
const splitAss = buildNarrationAss(splitSentence, 0.5, style, 1080, 1920);
assert.equal((splitAss.match(/^Dialogue:/gm) || []).length, 1);
assert.match(splitAss, /Dialogue: 0,0:00:00\.50,0:00:04\.50,.*,,一句话，跨越两个画面。/);
assert.deepEqual(splitSentence, splitSentenceBefore);
assert.deepEqual(style, styleBefore);

const twoGroupsAss = buildNarrationAss([
  beat({ beatId: 'beat-1', groupId: 'group-1', index: 1, text: '第二句', audioPath: '/tmp/group-1.wav', startSec: 1, durationSec: 2 }),
  beat({ text: '第一句', durationSec: 1 }),
], 0, style, 1080, 1920);
const dialogues = twoGroupsAss.match(/^Dialogue:.*$/gm) || [];
assert.equal(dialogues.length, 2);
assert.match(dialogues[0], /0:00:00\.00,0:00:01\.00,.*第一句/);
assert.match(dialogues[1], /0:00:01\.00,0:00:03\.00,.*第二句/);

const emptyGroupAss = buildNarrationAss([
  beat({ text: ' \n ' }),
  beat({ beatId: 'beat-1', groupId: 'group-1', index: 1, text: '  保留两边  ', audioPath: '/tmp/group-1.wav', startSec: 2.5 }),
], 0, style, 1080, 1920);
assert.equal((emptyGroupAss.match(/^Dialogue:/gm) || []).length, 1);
assert.match(emptyGroupAss, /,,  保留两边  $/m);

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
rejects([
  beat(),
  beat({ beatId: 'beat-1', groupId: 'group-1', index: 1, audioPath: '/tmp/group-1.wav', startSec: 2.5 }),
  beat({ beatId: 'beat-2', index: 2, startSec: 5 }),
]);
rejects([beat(), beat({ beatId: 'beat-1', index: 1, startSec: 2.6 })]);
rejects([beat(), beat({ beatId: 'beat-1', index: 1, startSec: 2.4 })]);
rejects([beat(), beat({ beatId: 'beat-1', index: 1, startSec: 2.5, audioPath: '/tmp/other.wav' })]);
rejects([beat({ groupId: '   ' })]);
rejects([beat({ index: -1 })]);
rejects([beat({ index: 0.5 })]);
rejects([beat({ startSec: -1 })]);
rejects([beat({ startSec: Number.NaN })]);
rejects([beat({ durationSec: 0 })]);
rejects([beat({ durationSec: Number.POSITIVE_INFINITY })]);
rejects([beat()], -1);
rejects([beat()], Number.NaN);

console.log('final-video-subtitles tests passed');
