'use client';

import { useCallback, useEffect, useState } from 'react';
import { GroupHeading, StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';
import { teamError, teamWrite } from './client';
import type { TeamChannelHealthView } from '@/lib/team-service/channel-health';

interface ResponseBody {
  items: TeamChannelHealthView[];
  failureThreshold: number;
}

function timeLabel(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function stateTone(item: TeamChannelHealthView): 'ok' | 'warn' | 'fail' | 'idle' {
  if (!item.manualEnabled) return 'idle';
  if (item.state === 'avoided') return 'fail';
  if (item.state === 'recovering') return 'warn';
  return 'ok';
}

function stateText(item: TeamChannelHealthView): string {
  if (!item.manualEnabled) return '管理员已停用';
  if (item.state === 'avoided') return item.recoveryDue ? '避让到期，待恢复验证' : '系统临时避让';
  if (item.state === 'recovering') return '正在恢复验证';
  return item.consecutiveFailures > 0
    ? `可用（连续失败 ${item.consecutiveFailures}/${item.failureThreshold}）`
    : '可用';
}

export default function ChannelHealthPanel() {
  const [data, setData] = useState<ResponseBody | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/channel-health', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(await teamError(response, '无法读取通道健康状态'));
    setData(await response.json() as ResponseBody);
  }, []);

  useEffect(() => {
    void Promise.resolve()
      .then(refresh)
      .catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取通道健康状态'));
  }, [refresh]);

  async function clearAvoidance(item: TeamChannelHealthView) {
    setBusyKey(item.healthKey);
    setError('');
    setNotice('');
    try {
      const response = await teamWrite('/api/team/channel-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'clear',
          healthKey: item.healthKey,
          expectedVersion: item.version,
        }),
      });
      if (!response.ok) throw new Error(await teamError(response, '恢复通道失败'));
      setNotice(`${item.unifiedModelLabel} · ${item.channelLabel} 已恢复为可用；供应商手动停用状态没有改变。`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复通道失败');
      await refresh().catch(() => undefined);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="space-y-2" aria-label="通道健康状态">
      <div className="flex items-center justify-between gap-3">
        <GroupHeading>通道健康</GroupHeading>
        <ToolbarButton icon="retry" onClick={() => { void refresh().catch(() => setError('刷新失败')); }}>
          刷新状态
        </ToolbarButton>
      </div>
      <p className="text-[12px] leading-5 text-ink-secondary">
        系统只对连续的服务错误临时避让，不改变供应商的手动启停。避让到期后，下一条正常任务会作为恢复验证；
        审核拒绝、素材错误、预算和权限问题不会停用整条通道。恢复验证不会额外发起付费探测。
      </p>
      {error ? <p role="alert" className="text-[13px] text-fail">{error}</p> : null}
      {notice ? <p role="status" className="text-[13px] text-ok">{notice}</p> : null}
      <div className="overflow-hidden rounded-[11px] border border-hairline bg-surface">
        {data?.items.map((item) => (
          <div
            key={item.healthKey}
            className="flex flex-wrap items-start gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
          >
            <div className="min-w-44 flex-1">
              <div className="text-[13px] font-medium text-ink">
                {item.unifiedModelLabel} · {item.channelLabel}
              </div>
              <div className="mt-0.5 text-[12px] text-ink-tertiary">
                实际供应商：{item.providerName}
              </div>
            </div>
            <div className="min-w-48 flex-1 text-[12px] leading-5 text-ink-secondary">
              <Tag tone={stateTone(item)}>
                <StatusDot tone={stateTone(item)} />
                {stateText(item)}
              </Tag>
              {item.reasonLabel ? <div className="mt-1">{item.reasonLabel}</div> : null}
              {item.lastFailureAt ? <div>最近失败：{timeLabel(item.lastFailureAt)}</div> : null}
              {item.avoidUntil && item.state !== 'healthy'
                ? <div>{item.recoveryDue ? '恢复验证已可开始' : `预计恢复：${timeLabel(item.avoidUntil)}`}</div>
                : null}
              {!item.manualEnabled
                ? <div>供应商设置中处于停用状态；自动恢复不会重新启用。</div>
                : null}
            </div>
            <div className="flex min-w-32 justify-end">
              {item.canClear ? (
                <ToolbarButton
                  disabled={busyKey === item.healthKey}
                  onClick={() => { void clearAvoidance(item); }}
                >
                  {busyKey === item.healthKey ? '恢复中…' : '清除系统避让'}
                </ToolbarButton>
              ) : null}
            </div>
          </div>
        ))}
        {data && data.items.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-ink-secondary">当前没有统一模型通道。</div>
        ) : null}
        {!data ? (
          <div className="px-4 py-8 text-center text-[13px] text-ink-secondary">正在读取通道健康状态…</div>
        ) : null}
      </div>
    </section>
  );
}
