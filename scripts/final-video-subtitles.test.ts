// scripts/final-video-subtitles.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAss, resolveFontFile, platformFontName } from '../lib/final-video/subtitles.ts';

const style = { enabled: true, fontSize: 56, color: '#ff0000', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 10 };
const segments = [
  { subtitle: '第一句', startSec: 1, segmentDurationSec: 2.5 },
  { subtitle: '', startSec: 3.5, segmentDurationSec: 1 },
  { subtitle: '换行\n测试', startSec: 4.5, segmentDurationSec: 3 },
];

const ass = buildAss(segments, style, 1080, 1920);

assert.match(ass, /\[Script Info\]/);
assert.match(ass, /PlayResX: 1080/);
assert.match(ass, /PlayResY: 1920/);
// 红色 #ff0000 → ASS 是 BGR：&H000000FF
assert.match(ass, /&H000000FF/);
// 空字幕不产 Dialogue
assert.equal((ass.match(/^Dialogue:/gm) || []).length, 2);
// 时间格式：起于 0:00:01.00，第三句起于 0:00:04.50 止于 0:00:07.50
assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.50,/);
assert.match(ass, /Dialogue: 0,0:00:04\.50,0:00:07\.50,/);
// 换行转 \N
assert.match(ass, /换行\\N测试/);
// MarginV = 1920 * 10% = 192
assert.match(ass, /,20,20,192,1/);

// 字体解析：返回空串或真实存在的文件
const font = resolveFontFile();
assert.ok(font === '' || fs.existsSync(font));
assert.ok(platformFontName().length > 0);

console.log('final-video-subtitles tests passed');
