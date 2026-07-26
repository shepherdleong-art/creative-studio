import assert from 'node:assert/strict';
import { extractMatchKeywords } from '../lib/final-edit/match-keywords.ts';

const narration = '忙碌一天回到家，只想陷进这26斤满铺鹅毛的怀抱，感受5芯软弹带来的极致解压。112度的人体工学靠背，精准承托疲惫的腰背，久坐不累，让阅读时光也变得格外轻盈。触手可及的是婴幼级半青皮，A类认证的细腻质感，给全家一份可以贴脸呼吸的安心。';
const keywords = extractMatchKeywords(narration);

assert.ok(keywords.length >= 6 && keywords.length <= 24, '真实文案应提取覆盖各个语义子句的有限关键词');
assert.ok(keywords.some((keyword) => keyword.includes('满铺鹅毛')));
assert.ok(keywords.some((keyword) => keyword.includes('人体工学靠背')));
assert.ok(keywords.some((keyword) => keyword.includes('阅读时光')));
assert.ok(keywords.some((keyword) => keyword.includes('婴幼级半青皮')));
assert.ok(keywords.some((keyword) => keyword.includes('a类认证')));
assert.equal(keywords.includes('碌一'), false, '关键词不得再由无语义的滑窗 bigram 填满');
assert.deepEqual(extractMatchKeywords(narration), keywords, '关键词提取必须确定');

console.log('final-edit match keyword tests passed');
