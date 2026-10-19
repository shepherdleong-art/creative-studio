export interface OverlapInput {
  files: Record<string, number>;
  sequence: string[];
  bgmKey: string | null;
  coverKey: string | null;
}
function lcsLength(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const left of a) {
    let diagonal = 0;
    for (let index = 1; index <= b.length; index += 1) {
      const previous = row[index];
      row[index] = left === b[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
      diagonal = previous;
    }
  }
  return row[b.length];
}

export function calculateOverlapScore(a: OverlapInput, b: OverlapInput) {
  const keys = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    intersection += Math.min(a.files[key] || 0, b.files[key] || 0);
    union += Math.max(a.files[key] || 0, b.files[key] || 0);
  }
  const videoOverlap = union > 0 ? intersection / union : 0;
  const orderSimilarity = Math.max(a.sequence.length, b.sequence.length) > 0
    ? lcsLength(a.sequence, b.sequence) / Math.max(a.sequence.length, b.sequence.length)
    : 0;
  const sameBgm = Boolean(a.bgmKey && a.bgmKey === b.bgmKey) ? 1 : 0;
  const sameCover = Boolean(a.coverKey && a.coverKey === b.coverKey) ? 1 : 0;
  const score = videoOverlap * 0.7 + orderSimilarity * 0.2 + sameBgm * 0.05 + sameCover * 0.05;
  return {
    videoOverlap: Number(videoOverlap.toFixed(6)),
    orderSimilarity: Number(orderSimilarity.toFixed(6)),
    sameBgm,
    sameCover,
    score: Number(score.toFixed(6)),
  };
}
