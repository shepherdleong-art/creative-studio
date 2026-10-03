/**
 * 文字差异（迁移自源项目 diffMark 的 LCS 词级 diff）：纯模块，无 Node 依赖，
 * 服务端（lib/script-studio/template-rewrite.ts）与前端组件共用。
 * 只表达「文字差异」，不宣称原创率、语义相似度或合规证明。
 */

export interface DiffMarkWord {
  w: string;
  diff: boolean;
  del?: boolean;
}

export function diffMarkWords(ref: string, gen: string): DiffMarkWord[] {
  const a = String(ref || '').split(/([\s，。！？、；：,.!?;:]+)/).filter(Boolean);
  const b = String(gen || '').split(/([\s，。！？、；：,.!?;:]+)/).filter(Boolean);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffMarkWord[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ w: b[j]!, diff: false }); i += 1; j += 1; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ w: a[i]!, diff: true, del: true }); i += 1; } else { out.push({ w: b[j]!, diff: true }); j += 1; }
  }
  while (i < n) { out.push({ w: a[i]!, diff: true, del: true }); i += 1; }
  while (j < m) { out.push({ w: b[j]!, diff: true }); j += 1; }
  return out;
}
