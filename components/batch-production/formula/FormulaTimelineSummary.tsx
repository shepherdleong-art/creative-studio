import type { FormulaTimelineView } from '@/lib/batch-production/formula/timeline-store';

const seconds = (us: number) => (us / 1_000_000).toFixed(2);

export default function FormulaTimelineSummary({ view }: { view: FormulaTimelineView }) {
  const result = view.result;
  return <div className="space-y-2 rounded-lg border border-hairline p-3" aria-label="时长安排">
    <h4 className="font-medium">时长安排</h4>
    {result?.status === 'planned' ? <>
      <p>正文 {seconds(result.duration.bodyDurationUs)} 秒 + 封面 {seconds(result.duration.totalDurationUs - result.duration.bodyDurationUs)} 秒 = 总长 {seconds(result.duration.totalDurationUs)} 秒</p>
      <p className="text-ink-secondary">目标 {seconds(result.duration.target.durationUs)} 秒（{result.duration.target.scope === 'total' ? '含封面' : '仅正文'}）；
        {{ reference: '尽量接近', strict_max: '不能超过', fixed: '固定时长' }[result.duration.target.mode]}。</p>
      <p className="text-ink-secondary">画面与声音时间已保存。当前成片可在中间预览区连贯播放；历史记录仍可在此逐段试听。</p>
      {result.issues.map((issue, index) => <p key={index} className="text-warn">{issue.message}</p>)}
      <details><summary className="cursor-pointer text-ink-secondary">查看每个镜头取用的时间</summary>
        <ol className="mt-2 space-y-2">{result.duration.clips.map((clip, index) => <li key={clip.slotId} className="border-t border-hairline pt-2">
          <p>镜头 {index + 1} · {clip.logicalCode}{clip.hasSourceSpeech ? ' · 保留原声' : ''}</p>
          <p>取原片 {seconds(clip.sourceInUs)}–{seconds(clip.sourceOutUs)} 秒</p>
          <p>放在正文 {seconds(clip.timelineStartUs)}–{seconds(clip.timelineEndUs)} 秒</p>
          {!clip.rangeConfirmed && <p className="text-warn">建议区间，尚待审片确认。</p>}
        </li>)}</ol>
      </details>
    </> : result?.status === 'needs_attention' ? <>
      <p className="text-warn">目前的素材与声音无法满足时长要求。</p>
      {result.conflicts.map((conflict, index) => <div key={index} className="space-y-1">
        <p className="text-warn">{conflict.message}</p>
        {conflict.missingFrames !== undefined && <p>还差 {(conflict.missingFrames / 24).toFixed(2)} 秒可用时间。</p>}
      </div>)}
    </> : view.taskStatus === 'failed' ? <p className="text-fail">{view.errorMessage || '时长安排失败，请按任务提示重试。'}</p>
      : view.taskStatus === 'cancelled' ? <p className="text-ink-secondary">这次排片已停止，历史记录保留。</p>
      : <p className="text-ink-secondary">{view.stageId ? '正在按实际声音安排画面…' : '原声与所需配音完成后，自动安排画面时长。'}</p>}
  </div>;
}
