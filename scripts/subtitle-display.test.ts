import assert from 'node:assert/strict';
import {
  normalizeAutomaticSubtitleText,
  splitNarrationForDisplay,
  splitSubtitleTextOnHardWhitespace,
} from '../lib/subtitle-display.ts';

assert.deepEqual(
  splitSubtitleTextOnHardWhitespace('中文 普通\u3000全角\n换行'),
  ['中文', '普通', '全角', '换行'],
  '普通空格、全角空格和换行都必须形成硬字幕边界',
);
assert.deepEqual(
  splitSubtitleTextOnHardWhitespace('中文 OpenAI GPT 5\u3000Pro 2026 中文'),
  ['中文', 'OpenAI GPT 5\u3000Pro 2026', '中文'],
  '仅当空白两侧最近的非空白字符都是拉丁字母或数字时保留词间空格',
);
assert.deepEqual(
  splitSubtitleTextOnHardWhitespace('中文 Café\ncrème 中文'),
  ['中文', 'Café', 'crème', '中文'],
  '换行必须始终形成硬字幕边界，不能按英文词间空格保留',
);

assert.deepEqual(
  splitNarrationForDisplay('忙碌一天回到家，只想好好休息。'),
  [
    { sourceText: '忙碌一天回到家，', displayText: '忙碌一天回到家' },
    { sourceText: '只想好好休息。', displayText: '只想好好休息' },
  ],
);

assert.equal(normalizeAutomaticSubtitleText('柔软、承托、安心。'), '柔软 承托 安心');
assert.equal(
  normalizeAutomaticSubtitleText('厚度3.5cm，提升20%，靠背112°，适配9:16画幅。'),
  '厚度3.5cm 提升20% 靠背112° 适配9:16画幅',
);
assert.equal(
  normalizeAutomaticSubtitleText('支持5～8小时、5-8小时，型号A-01。'),
  '支持5～8小时 5-8小时 型号A-01',
);
assert.equal(normalizeAutomaticSubtitleText('《新品》（真的）“很舒服”！'), '新品 真的 很舒服');
assert.deepEqual(splitNarrationForDisplay('……！！！'), []);

assert.deepEqual(
  splitNarrationForDisplay('柔软 承托\u3000安心\n放松'),
  [
    { sourceText: '柔软', displayText: '柔软' },
    { sourceText: '承托', displayText: '承托' },
    { sourceText: '安心', displayText: '安心' },
    { sourceText: '放松', displayText: '放松' },
  ],
);
assert.deepEqual(
  splitNarrationForDisplay('OpenAI GPT 5 Pro'),
  [{ sourceText: 'OpenAI GPT 5 Pro', displayText: 'OpenAI GPT 5 Pro' }],
  '英文与数字词间空格不得拆分字幕',
);

const longParts = splitNarrationForDisplay('这是一段没有自然停顿但需要避免形成过长字幕的完整电商口播内容', {
  maxContentCharacters: 12,
});
assert.ok(longParts.length > 1);
assert.ok(longParts.every((part) => part.displayText.length <= 12));

console.log('subtitle display tests passed');
