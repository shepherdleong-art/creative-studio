/**
 * 口播原声清洗：剪掉开头的倒数（「三二一开始」「321 走」）和结尾的口令（「OK」「来」）。
 * 台词本身以这些字开头或结尾时不误剪。
 *
 * 纯函数：输入识别文字和逐字时间，输出清洗后的文字、逐字时间、说话起止和被剪掉的部分。
 */
import type { SchedulingSpeech, SchedulingWord } from './scheduling/types.ts';
import { normalizeSpeechText } from './scheduling/text.ts';

export interface SourceSpeechInput {
  text: string;
  words: SchedulingWord[];
  /** 口播台词（素材文件名里 “ ” 中间的字）。 */
  plannedLine?: string | null;
}

export interface CleanedSourceSpeech extends SchedulingSpeech {
  removedHead: string[];
  removedTail: string[];
}

const COUNTDOWN = /^(三二一|一二三|321|123|二一|21)(开始|走|开|来)?/;
const CLAPPER = /^(OK|好|好的|可以|行|停|来|看)$/i;
const PUNCTUATION = /[\p{P}\p{S}\s]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char) && !PUNCTUATION.test(char);
}

interface Sentence { from: number; to: number }

/** 按标点把识别文字切成小句；位置用「去掉标点后的字符序号」表示。 */
export function splitSpeechSentences(text: string, plainLength: number): Sentence[] {
  const sentences: Sentence[] = [];
  let plain = 0;
  let start = 0;
  for (const char of text) {
    if (!isWordChar(char)) {
      if (plain > start) sentences.push({ from: start, to: plain });
      start = plain;
      continue;
    }
    plain += char.length;
  }
  if (plain > start) sentences.push({ from: start, to: plain });
  // 识别文字和逐字时间对不上时不做小句切分，避免切错位置。
  if (plain !== plainLength) return [];
  return sentences;
}

function wordIndexAt(words: readonly SchedulingWord[], plainIndex: number): number {
  let offset = 0;
  for (let index = 0; index < words.length; index += 1) {
    const length = words[index].text.length;
    if (plainIndex < offset + length) return index;
    offset += length;
  }
  return words.length;
}

function protectedHead(text: string, planned: string): boolean {
  return Boolean(planned) && planned.toLowerCase().startsWith(text.toLowerCase());
}

function protectedTail(text: string, planned: string): boolean {
  return Boolean(planned) && planned.toLowerCase().endsWith(text.toLowerCase());
}

export function cleanSourceSpeech(input: SourceSpeechInput): CleanedSourceSpeech {
  const words = input.words.filter(word => word.text.length > 0);
  const plain = words.map(word => word.text).join('');
  const planned = normalizeSpeechText(input.plannedLine ?? '');
  const sentences = splitSpeechSentences(input.text, plain.length);
  const unchanged = (): CleanedSourceSpeech => ({
    text: input.text, words: [...words], removedHead: [], removedTail: [],
    startUs: words[0]?.startUs ?? 0, endUs: words.at(-1)?.endUs ?? 0,
    headCutEndUs: null, tailCutStartUs: null,
  });
  if (!words.length || !sentences.length) return unchanged();

  const removedHead: string[] = [];
  const removedTail: string[] = [];
  let headWordEnd = 0;
  let tailWordStart = words.length;

  // 开头最多去掉 3 小句倒数或口令。
  for (let index = 0; index < Math.min(3, sentences.length); index += 1) {
    const sentence = sentences[index];
    const content = plain.slice(sentence.from, sentence.to);
    const countdown = COUNTDOWN.exec(content);
    if (countdown && !protectedHead(countdown[0], planned)) {
      if (countdown[0].length === content.length) {
        headWordEnd = wordIndexAt(words, sentence.to);
        removedHead.push(content);
        continue;
      }
      // 倒数和台词连成一句时，只去掉倒数那几个字。
      headWordEnd = wordIndexAt(words, sentence.from + countdown[0].length);
      removedHead.push(countdown[0]);
    } else if (CLAPPER.test(content) && !protectedHead(content, planned)) {
      headWordEnd = wordIndexAt(words, sentence.to);
      removedHead.push(content);
      continue;
    } else if (COUNTDOWN.test(content)) {
      break;
    }
    break;
  }

  // 结尾最多去掉 2 小句口令，以及只有一个字的小句。
  for (let index = sentences.length - 1; index >= Math.max(0, sentences.length - 2); index -= 1) {
    const sentence = sentences[index];
    if (sentence.to <= headWordEnd) break;
    const content = plain.slice(sentence.from, sentence.to);
    const clapper = CLAPPER.test(content) || content.length === 1;
    if (!clapper || protectedTail(content, planned)) break;
    tailWordStart = wordIndexAt(words, sentence.from);
    removedTail.unshift(content);
  }

  if (tailWordStart <= headWordEnd) return unchanged();
  const kept = words.slice(headWordEnd, tailWordStart);
  if (!kept.length) return unchanged();
  return {
    text: kept.map(word => word.text).join(''),
    words: kept,
    startUs: kept[0].startUs,
    endUs: kept.at(-1)!.endUs,
    headCutEndUs: headWordEnd > 0 ? words[headWordEnd - 1].endUs : null,
    tailCutStartUs: tailWordStart < words.length ? words[tailWordStart].startUs : null,
    removedHead,
    removedTail,
  };
}
