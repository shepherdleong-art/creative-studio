interface TimedWord { id: string; text: string; sourceInUs: number; sourceOutUs: number }

/** Group automatic word timings for display; retain the actual first/last word boundaries. */
export function groupFormulaSubtitleWords(words: readonly TimedWord[]): TimedWord[] {
  const cues: TimedWord[] = [];
  let group: TimedWord[] = [];
  const join = (left: string, right: string) => /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right)
    ? `${left} ${right}` : left + right;
  const contentLength = (text: string) => Array.from(text.replace(/[\s\p{P}]/gu, '')).length;
  const flush = () => {
    if (!group.length) return;
    const first = group[0], last = group.at(-1)!;
    cues.push({ ...first, id: group.length === 1 ? first.id : `${first.id}:phrase:${last.id}`,
      text: group.map(word => word.text).reduce(join), sourceOutUs: last.sourceOutUs });
    group = [];
  };
  for (const word of words) {
    const previous = group.at(-1);
    if (previous) {
      const sentenceEnd = /[，。！？!?；;：:,][”’"'）)】\]]*$/u.test(previous.text)
        || (/\.$/u.test(previous.text) && !(/\d\.$/u.test(previous.text) && /^\d/u.test(word.text)));
      if (sentenceEnd || word.sourceInUs < previous.sourceOutUs || word.sourceInUs - previous.sourceOutUs > 350_000
        || word.sourceOutUs - group[0].sourceInUs > 4_000_000
        || contentLength(group.map(item => item.text).join('') + word.text) > 16) flush();
    }
    group.push(word);
  }
  flush();
  return cues;
}
