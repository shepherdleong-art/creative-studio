export type TeamTaskModelCall = {
  attemptId: string | null;
  providerName: string;
  model: string | null;
  modelStatus: 'recorded' | 'pending';
  submissionState: string;
  createdAt: string | null;
};

export function modelStatusLabel(status: string, pending: boolean): string {
  if (status === 'not_applicable') return '不适用';
  if (status === 'missing') return '未记录';
  if (status === 'undetermined') return '待确定';
  if (status === 'multiple') return '按实际调用查看';
  return pending ? '待调用（尚未发送）' : '已提交模型';
}

function submissionLabel(state: string): string {
  const labels: Record<string, string> = {
    not_sent: '待调用，尚未发送', maybe_sent: '已发起提交，结果待确认', accepted: '供应商已受理',
    terminal: '执行记录已结束',
  };
  return labels[state] ?? '调用状态未记录';
}

/**
 * 任务的「实际模型 + 调用记录」块。
 *
 * - `compact`：首页卡片用，只留名字与状态一行。
 * - `showSummary={false}`：任务详情用——供应商与模型已经在上面的分组列表里写过了，
 *   这里只补调用记录，避免同一屏把同一件事说两遍。
 */
export default function TeamTaskModel({ providerName, model, modelStatus, calls, compact = false, showSummary = true }: {
  providerName: string;
  model: string | null;
  modelStatus: string;
  calls: TeamTaskModelCall[];
  compact?: boolean;
  showSummary?: boolean;
}) {
  return <div className={compact ? 'mt-2 space-y-1 text-xs text-ink-tertiary' : 'mt-2 space-y-2 text-xs text-ink-secondary'}>
    {showSummary ? (
      <>
        <div>供应商：{providerName}</div>
        <div className="break-all">实际模型：{model ?? modelStatusLabel(modelStatus, modelStatus === 'pending')}</div>
        {modelStatus !== 'not_applicable' && <div>{modelStatusLabel(modelStatus, modelStatus === 'pending')}</div>}
      </>
    ) : null}
    {!compact && calls.length > 0 && <details className="mt-2" open={!showSummary}>
      <summary className="cursor-pointer text-ink-tertiary">实际调用记录（{calls.length} 条，不等于制作份数或扣费次数）</summary>
      <ol className="mt-2 space-y-2">{calls.map((call, index) => <li key={call.attemptId ?? `planned-${index}`} className="break-all">
        {call.model ?? '未记录'} · {call.providerName}<br />
        <span className="text-ink-tertiary">{submissionLabel(call.submissionState)}{call.attemptId ? ` · 执行尝试 ${call.attemptId}` : ''}</span>
      </li>)}</ol>
    </details>}
    {!compact && calls.length === 0 ? <p className="text-ink-tertiary">还没有实际调用记录。</p> : null}
  </div>;
}
