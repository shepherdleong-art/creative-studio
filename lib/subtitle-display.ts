import { countScriptContentCharacters } from './script-duration-policy.ts';

export interface SubtitleDisplayPart {
  sourceText: string;
  displayText: string;
}

const ENDING_LANGUAGE_PUNCTUATION = new Set(Array.from('。！？!?；;…'));
const WEAK_LANGUAGE_PUNCTUATION = new Set(Array.from('，,、：:'));
const PAIRED_OR_QUOTE_PUNCTUATION = new Set(Array.from('“”‘’「」『』《》〈〉（）()【】[]｛｝{}'));
const LATIN_LETTER_OR_DIGIT = /[\p{Script=Latin}\p{N}]/u;

function isDigit(value: string | undefined): boolean {
  return value != null && /\p{N}/u.test(value);
}

function isSemanticPunctuation(characters: string[], index: number): boolean {
  const character = characters[index];
  return (character === '.' || character === ':')
    && isDigit(characters[index - 1])
    && isDigit(characters[index + 1]);
}

function isNarrationBoundary(characters: string[], index: number): boolean {
  const character = characters[index];
  if (isSemanticPunctuation(characters, index)) return false;
  return ENDING_LANGUAGE_PUNCTUATION.has(character) || WEAK_LANGUAGE_PUNCTUATION.has(character) || character === '.';
}

export function splitSubtitleTextOnHardWhitespace(text: string): string[] {
  const characters = Array.from(text);
  const parts: string[] = [];
  let current = '';
  let index = 0;
  while (index < characters.length) {
    if (!/\s/u.test(characters[index])) {
      current += characters[index];
      index += 1;
      continue;
    }
    const whitespaceStart = index;
    while (index < characters.length && /\s/u.test(characters[index])) index += 1;
    const whitespace = characters.slice(whitespaceStart, index).join('');
    const left = characters[whitespaceStart - 1];
    const right = characters[index];
    const isWordSpacing = Array.from(whitespace).every((character) => character === ' ' || character === '\u3000');
    if (isWordSpacing && LATIN_LETTER_OR_DIGIT.test(left || '') && LATIN_LETTER_OR_DIGIT.test(right || '')) {
      current += whitespace;
    } else if (current.trim()) {
      parts.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitLongPart(sourceText: string, maxContentCharacters: number): string[] {
  if (countScriptContentCharacters(sourceText) <= maxContentCharacters) return [sourceText];
  const parts: string[] = [];
  let current = '';
  let contentCount = 0;
  for (const character of Array.from(sourceText)) {
    const isContent = /[\p{L}\p{N}]/u.test(character);
    if (isContent && contentCount >= maxContentCharacters && current.trim()) {
      parts.push(current.trim());
      current = '';
      contentCount = 0;
    }
    current += character;
    if (isContent) contentCount += 1;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function normalizeAutomaticSubtitleText(text: string): string {
  const characters = Array.from(text);
  let normalized = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (isSemanticPunctuation(characters, index)) {
      normalized += character;
    } else if (ENDING_LANGUAGE_PUNCTUATION.has(character) || character === '.') {
      normalized += ' ';
    } else if (WEAK_LANGUAGE_PUNCTUATION.has(character) || PAIRED_OR_QUOTE_PUNCTUATION.has(character)) {
      normalized += ' ';
    } else {
      normalized += character;
    }
  }
  return normalized.replace(/\s+/gu, ' ').trim();
}

export function splitNarrationForDisplay(
  narration: string,
  options: { maxContentCharacters?: number } = {},
): SubtitleDisplayPart[] {
  const maxContentCharacters = Math.max(1, Math.trunc(options.maxContentCharacters || 22));
  const normalizedNarration = narration.replace(/\r\n?/gu, '\n').trim();
  if (!normalizedNarration) return [];
  const candidates: string[] = [];
  for (const whitespacePart of splitSubtitleTextOnHardWhitespace(normalizedNarration)) {
    const characters = Array.from(whitespacePart);
    let current = '';
    for (let index = 0; index < characters.length; index += 1) {
      current += characters[index];
      if (isNarrationBoundary(characters, index)) {
        if (current.trim()) candidates.push(current.trim());
        current = '';
      }
    }
    if (current.trim()) candidates.push(current.trim());
  }

  return candidates
    .flatMap((candidate) => splitLongPart(candidate, maxContentCharacters))
    .map((sourceText) => ({ sourceText, displayText: normalizeAutomaticSubtitleText(sourceText) }))
    .filter((part) => part.displayText.length > 0);
}
