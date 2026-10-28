import type { FormulaMaterialNoteItem } from './material-notes.ts';

/** 两条分析路径与人工说明共用的内容入口；未知、过期及冲突说明不参与自动判断。 */
export function usableMaterialNote(note: FormulaMaterialNoteItem) {
  return !note.excluded && !note.stale && !!note.profile && !note.profile.content.conflicts?.length
    && !/信息不足|无法判断|无法确定|不能确定/.test(note.profile.content.description);
}

export function materialContentScore(notes: FormulaMaterialNoteItem[], assetId: string, logicalCode: string, context: string): number {
  const normalized = context.normalize('NFKC').toLocaleLowerCase();
  let best = 0;
  for (const note of notes.filter(note => note.source.assetId === assetId && note.logicalCode === logicalCode && usableMaterialNote(note))) {
    const content = note.profile!.content;
    // 优先完整动作/卖点短语；描述使用双字词重合，避免无分词中文整句只能完全相等。
    const phrases = [...content.actions, ...content.sellingPoints].map(value => value.normalize('NFKC').toLocaleLowerCase());
    const text = content.description.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const grams = new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
    const overlap = [...grams].filter(word => normalized.includes(word)).length;
    const score = phrases.filter(phrase => phrase.length >= 2 && normalized.includes(phrase)).length * 10
      + (grams.size ? overlap / grams.size : 0);
    best = Math.max(best, score);
  }
  return best;
}
