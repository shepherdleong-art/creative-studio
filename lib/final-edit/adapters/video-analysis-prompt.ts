export function buildVideoAnalysisPrompt(
  detectedScenes: Array<{ startUs: number; endUs: number }>,
  durationSec: number,
): string {
  return `这些图片按顺序分别来自同一视频的场景区间 ${JSON.stringify(detectedScenes)}（总时长 ${durationSec.toFixed(3)} 秒），每个场景在 30% 位置抽一帧。请逐场景描述画面并给标签、质量分，同时给出整段摘要、卖点、质量问题和封面帧。请严格返回 JSON（json）对象 {summary,sellingPoints,semanticTags,scenes:[{startUs,endUs,description,labels,qualityScore}],qualityIssues,coverFrameTimesUs}。scenes 数量和顺序必须与场景区间一致，所有时间使用整数微秒。`;
}
