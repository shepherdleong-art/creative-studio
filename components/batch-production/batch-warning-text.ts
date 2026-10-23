/** Shared Chinese copy for allocation warnings shown in cards and accepted review concerns. */
const BATCH_WARNING_TEXTS: Array<{ code: string; text: string; prefix: boolean }> = [
  { code: 'previous-version-reused:', text: '换一批画面后素材池不足，沿用了上一版的部分画面', prefix: true },
  { code: 'stitched-segment:', text: '单条素材装不下这段口播，已自动拼接多个镜头', prefix: true },
  { code: 'source-overlap:', text: '部分画面区间与其他片段重复', prefix: true },
  { code: 'analysis-fallback:', text: '该素材没有画面分析，使用了兜底匹配', prefix: true },
  { code: 'semantic-degraded:', text: '该片段语义匹配度较低', prefix: true },
  { code: 'opening-reused:', text: '开头画面与其他成片重复', prefix: true },
  { code: 'no-legal-media:', text: '没有可用素材', prefix: true },
  { code: 'cover-unavailable', text: '封面抽帧不可用', prefix: false },
];

export function humanizeBatchWarning(warning: string): string {
  const hit = BATCH_WARNING_TEXTS.find(({ code, prefix }) => (prefix ? warning.startsWith(code) : warning === code));
  return hit ? hit.text : warning;
}
