export interface VideoFrameSample { imageIndex: number; sceneIndex: number; timeUs: number }

/** 场景切分不会发现同机位的入镜/落座；必须同时覆盖镜头内部的时间变化。 */
export function buildVideoFrameSamples(scenes: Array<{ startUs: number; endUs: number }>): VideoFrameSample[] {
  const counts = scenes.map(() => 1);
  const wanted = scenes.map(scene => scene.endUs - scene.startUs < 250_000 ? 1
    : Math.min(12, Math.max(3, Math.ceil((scene.endUs - scene.startUs) / 2_000_000) + 1)));
  // 超过 48 个切镜时保留原先每场景至少一帧的覆盖，不把无证据场景交给模型猜。
  const budget = Math.max(48, scenes.length);
  for (let total = scenes.length; total < budget; total++) {
    let chosen = -1, largestGap = -1;
    for (const [index, scene] of scenes.entries()) {
      const gap = (scene.endUs - scene.startUs) / counts[index];
      if (counts[index] < wanted[index] && gap > largestGap) { chosen = index; largestGap = gap; }
    }
    if (chosen < 0) break;
    counts[chosen]++;
  }
  const frames: VideoFrameSample[] = [];
  for (const [sceneIndex, scene] of scenes.entries()) {
    const duration = scene.endUs - scene.startUs;
    const margin = Math.min(50_000, duration / 10);
    for (let index = 0; index < counts[sceneIndex]; index++) {
      const timeUs = counts[sceneIndex] === 1 ? scene.startUs + duration / 2
        : scene.startUs + margin + (duration - margin * 2) * index / (counts[sceneIndex] - 1);
      frames.push({ imageIndex: frames.length + 1, sceneIndex, timeUs: Math.round(timeUs) });
    }
  }
  return frames;
}

export function buildVideoAnalysisPrompt(
  detectedScenes: Array<{ startUs: number; endUs: number }>,
  durationSec: number,
  frames: VideoFrameSample[] = buildVideoFrameSamples(detectedScenes),
): string {
  return `这些图片按时间顺序来自同一视频的场景区间 ${JSON.stringify(detectedScenes)}（总时长 ${durationSec.toFixed(3)} 秒）。图片与取帧时间对应表为 ${JSON.stringify(frames)}，imageIndex 从 1 开始，sceneIndex 从 0 开始；同一个场景可能有多张图片。请结合同场景前中后画面描述人物入镜、姿态和可观察的动作变化，不要只描述第一张空镜，也不要把抽样帧当成完整连续视频。看不到的动作过程、准确动作边界、声音和台词不可推断。逐场景给描述、标签、质量分，并给整段摘要、可见卖点、质量问题和封面帧。封面时间必须选取对应表中实际存在的 timeUs。请严格返回 JSON（json）对象 {summary,sellingPoints,semanticTags,scenes:[{startUs,endUs,description,labels,qualityScore}],qualityIssues,coverFrameTimesUs}。scenes 数量和顺序必须与场景区间一致，不与图片数量混淆，所有时间使用整数微秒。`;
}
