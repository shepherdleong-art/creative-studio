import assert from 'node:assert/strict';
import {
  normalizeAutomaticSubtitleText,
  splitNarrationForDisplay,
} from '../lib/subtitle-display.ts';

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

const longParts = splitNarrationForDisplay('这是一段没有自然停顿但需要避免形成过长字幕的完整电商口播内容', {
  maxContentCharacters: 12,
});
assert.ok(longParts.length > 1);
assert.ok(longParts.every((part) => part.displayText.length <= 12));

console.log('subtitle display tests passed');
