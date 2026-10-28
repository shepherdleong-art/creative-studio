import assert from 'node:assert/strict';
import { cleanSourceSpeech, splitSpeechSentences } from '../lib/live-mixcut/source-speech-clean.ts';

// 原声清洗是纯函数：编造的识别文字和逐字时间，每个字 300 毫秒。
let clock = 0;
/** 把识别文字按字切成逐字时间，保证和文字去掉标点后一致。 */
const charWords = (text: string) => {
  clock = 0;
  return [...text].filter(char => /[\p{L}\p{N}]/u.test(char)).map(char => {
    const startUs = clock;
    clock += 300_000;
    return { text: char, startUs, endUs: clock };
  });
};

// 1. 倒数单独成句、结尾口令：文字、逐字时间、说话起止和被剪掉的部分都对上。
{
  const text = '三二一开始。买沙发踩过坑的，先别划走。OK.';
  const all = charWords(text);
  const cleaned = cleanSourceSpeech({ text, words: all });
  assert.equal(cleaned.text, '买沙发踩过坑的先别划走');
  assert.deepEqual(cleaned.removedHead, ['三二一开始']);
  assert.deepEqual(cleaned.removedTail, ['OK']);
  assert.equal(cleaned.words[0].text, '买');
  assert.equal(cleaned.startUs, all[5].startUs, '说话起止从清洗后的第一个字算');
  assert.equal(cleaned.endUs, all[all.length - 3].endUs);
  assert.equal(cleaned.headCutEndUs, all[4].endUs, '开头被剪掉的部分结束在哪里');
  assert.equal(cleaned.tailCutStartUs, all[all.length - 2].startUs, '结尾被剪掉的部分从哪里开始');
}

// 2. 倒数和台词连成一句：只去掉倒数那几个字，后面的台词留下。
{
  const text = '三二一开始买沙发踩过坑的，先别划走。';
  const cleaned = cleanSourceSpeech({ text, words: charWords(text) });
  assert.equal(cleaned.text, '买沙发踩过坑的先别划走');
  assert.deepEqual(cleaned.removedHead, ['三二一开始']);
  assert.equal(cleaned.headCutEndUs, 1_500_000, '只剪掉五个字（1.5 秒）');
}

// 3. 「321走」这类也认；结尾只去掉最后两句口令和单字小句。
{
  const walked = '321走。买沙发。';
  assert.equal(cleanSourceSpeech({ text: walked, words: charWords(walked) }).text, '买沙发');
  const tail = '买沙发。OK。来。好。';
  const cleaned = cleanSourceSpeech({ text: tail, words: charWords(tail) });
  assert.equal(cleaned.text, '买沙发OK', '结尾最多去掉两句');
  assert.deepEqual(cleaned.removedTail, ['来', '好']);
  const single = '买沙发。嗯。';
  assert.equal(cleanSourceSpeech({ text: single, words: charWords(single) }).text, '买沙发', '只有一个字的小句也去掉');
}

// 4. 台词本身以「来」开头或以「看」结尾时，不误剪。
{
  const head = '来。看看这张沙发。来。';
  const headClean = cleanSourceSpeech({ text: head, words: charWords(head), plannedLine: '来看看这张沙发' });
  assert.equal(headClean.text, '来看看这张沙发', '开头的「来」是台词的一部分，留着');
  assert.deepEqual(headClean.removedTail, ['来'], '结尾那句口令照常去掉');
  const tail = '买沙发。看。';
  const tailClean = cleanSourceSpeech({ text: tail, words: charWords(tail), plannedLine: '这张沙发的质感看' });
  assert.equal(tailClean.text, '买沙发看', '结尾的「看」是台词的一部分，留着');
  assert.deepEqual(tailClean.removedTail, []);
}

// 5. 开头最多去掉三句；全都剪光时不改，宁可留着口令也不出空台词。
{
  const four = '来。来。来。来。买沙发。';
  assert.equal(cleanSourceSpeech({ text: four, words: charWords(four) }).text, '来买沙发', '第四句「来」留着');
  const allClapper = '三二一开始。OK.';
  const cleaned = cleanSourceSpeech({ text: allClapper, words: charWords(allClapper) });
  assert.equal(cleaned.text, allClapper, '没有台词时原样返回，不剪成空');
  assert.deepEqual([cleaned.headCutEndUs, cleaned.tailCutStartUs], [null, null]);
}

// 6. 识别文字和逐字时间对不上、或没有逐字时间时，不切小句也不剪。
{
  const text = '三二一开始。买沙发。';
  const mismatched = cleanSourceSpeech({ text, words: [{ text: '三二一', startUs: 0, endUs: 300_000 }] });
  assert.equal(mismatched.text, text);
  assert.deepEqual(mismatched.removedHead, []);
  const bare = cleanSourceSpeech({ text, words: [] });
  assert.equal(bare.text, text);
  assert.deepEqual([bare.startUs, bare.endUs], [0, 0], '没有逐字时间时说话起止为空');
}

// 7. 小句切分按标点走；标点不占逐字时间的位置。
{
  assert.deepEqual(splitSpeechSentences('三二一开始。买沙发，OK.', 10),
    [{ from: 0, to: 5 }, { from: 5, to: 8 }, { from: 8, to: 10 }]);
  assert.deepEqual(splitSpeechSentences('三二一开始。', 3), [], '长度对不上就不给小句');
}

console.log('source-speech-clean: 倒数、结尾口令、连成一句、台词保护、上限和兜底通过');
