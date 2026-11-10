'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PageToolbar from './PageToolbar';
import { teamError, teamWrite } from './client';
import { GroupHeading, StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';
import type {
  UnifiedReconcileAction,
  UnifiedReconcileList,
  UnifiedReconcileTaskView,
} from '@/lib/team-service/unified-reconcile';

const ACTION_LABELS: Record<UnifiedReconcileAction, string> = {
  attach_remote_id: '补远端 ID',
  confirm_not_created: '确认未创建',
  confirm_succeeded: '确认成功',
  confirm_failed: '确认失败',
  still_unknown: '仍无法确认',
};

const STATUS_LABELS: Record<string, string> = {
  unknown: '结果确认中',
  accepted: '已受理',
  waiting: '等待资源',
  routing: '选择通道',
  pending: '排队中',
  failed: '失败',
  succeeded: '成功',
  canceled: '已取消',
  needs_check: '待核对',
  maybe_sent: '可能已提交',
  terminal: '已终态',
  not_created: '未创建',
  download_failed: '待补下载',
  estimated: '估算',
  settled: '已核账',
  released: '已释放',
  uncertain: '待核账',
  unpriced: '未定价',
  selected: '已选择',
  candidate: '候选',
  skipped: '已跳过',
  overflowed: '拥堵溢出',
  waiting_capacity: '等待容量',
  in_progress: '处理中',
  completed: '已完成',
};

function label(value: string | null | undefined): string {
  if (!value) return '—';
  return STATUS_LABELS[value] ?? value;
}

function money(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '待核账';
  return `¥${(minor / 100).toFixed(2)}`;
}

function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function toneFor(value: string | null | undefined): 'ok' | 'warn' | 'fail' | 'idle' {
  if (value === 'succeeded' || value === 'accepted') return 'ok';
  if (value === 'failed' || value === 'unknown') return 'fail';
  if (value === 'waiting' || value === 'needs_check' || value === 'maybe_sent') return 'warn';
  return 'idle';
}

interface Draft {
  channelKey: string;
  attemptId: string;
  action: UnifiedReconcileAction;
  evidence: string;
  remoteId: string;
  resultRef: string;
  actualCost: string;
}

function draftFor(task: UnifiedReconcileTaskView): Draft {
  const channel = task.channels.find((item) => item.channelKey === task.currentChannelKey)
    ?? task.channels[0];
  const attempt = channel?.attempts.at(-1);
  return {
    channelKey: channel?.channelKey ?? '',
    attemptId: attempt?.attemptId ?? '',
    action: 'attach_remote_id',
    evidence: '',
    remoteId: attempt?.remoteId ?? attempt?.receiptRemoteId ?? '',
    resultRef: '',
    actualCost: '',
  };
}

function needsRemoteId(action: UnifiedReconcileAction): boolean {
  return action === 'attach_remote_id' || action === 'confirm_succeeded' || action === 'confirm_failed';
}

function needsCost(action: UnifiedReconcileAction): boolean {
  return action === 'confirm_succeeded' || action === 'confirm_failed';
}

function sourceLabel(value: string): string {
  if (value === 'canvas') return '画布';
  if (value === 'rework' || value.includes('rework')) return '局部返工';
  return '项目';
}

function acceptsResultRef(action: UnifiedReconcileAction): boolean {
  return action === 'attach_remote_id' || action === 'confirm_succeeded';
}

export default function TeamReconcilePanel() {
  const [data, setData] = useState<UnifiedReconcileList | null>(null);
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const apply = useCallback((body: UnifiedReconcileList) => {
    setData(body);
    setDrafts((current) => Object.fromEntries(body.items.map((task) => [
      task.mediaTaskId,
      current[task.mediaTaskId] && current[task.mediaTaskId]!.channelKey === task.currentChannelKey
        ? current[task.mediaTaskId]!
        : draftFor(task),
    ])));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/team/reconcile?status=${filter}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(await teamError(response, '无法读取待核对任务'));
      apply(await response.json() as UnifiedReconcileList);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '待核对任务读取失败');
    } finally {
      setLoading(false);
    }
  }, [apply, filter]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  const summary = data?.summary;
  const subtitle = summary
    ? `${summary.attention} 条需要核对，${summary.unknown} 条结果确认中，${summary.canceled} 条带取消意图。`
    : '检查提交结果未知、远端身份缺失或费用待核账的任务。';

  function patchDraft(taskId: string, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [taskId]: { ...(current[taskId] ?? draftFor(data!.items.find((item) => item.mediaTaskId === taskId)!)), ...patch },
    }));
  }

  function selectAttempt(task: UnifiedReconcileTaskView, channelKey: string, attemptId: string) {
    const channel = task.channels.find((item) => item.channelKey === channelKey);
    const attempt = channel?.attempts.find((item) => item.attemptId === attemptId);
    patchDraft(task.mediaTaskId, {
      channelKey,
      attemptId,
      remoteId: attempt?.remoteId ?? attempt?.receiptRemoteId ?? '',
    });
  }

  async function submit(task: UnifiedReconcileTaskView) {
    const draft = drafts[task.mediaTaskId] ?? draftFor(task);
    setBusy(task.mediaTaskId);
    setError('');
    setNotice('');
    try {
      const response = await teamWrite('/api/team/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaTaskId: task.mediaTaskId,
          channelKey: draft.channelKey,
          attemptId: draft.attemptId,
          action: draft.action,
          evidence: draft.evidence.trim(),
          remoteId: needsRemoteId(draft.action) ? draft.remoteId.trim() : null,
          resultRef: acceptsResultRef(draft.action) && draft.resultRef.trim()
            ? draft.resultRef.trim()
            : null,
          actualCostMinor: needsCost(draft.action) && draft.actualCost.trim()
            ? Math.round(Number(draft.actualCost) * 100)
            : null,
          expectedVersion: task.reconcileVersion,
          idempotencyKey: globalThis.crypto.randomUUID(),
        }),
      });
      if (!response.ok) throw new Error(await teamError(response, '核对操作失败'));
      const result = await response.json() as {
        replayed: boolean;
        parentStatus: string;
        nextChannelKey: string | null;
        message: string;
      };
      setNotice(
        `${result.replayed ? '已返回上次核对结果。' : result.message}`
        + ` 当前状态：${label(result.parentStatus)}`
        + (result.nextChannelKey ? `，已转${result.nextChannelKey === 'qiniu' ? '七牛' : '腾讯'}通道。` : ''),
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '核对操作失败');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  const items = useMemo(() => data?.items ?? [], [data]);

  return (
    <div className="space-y-4">
      <PageToolbar
        role="admin"
        subtitle={subtitle}
        actions={
          <ToolbarButton icon="retry" onClick={() => { void refresh(); }}>
            刷新
          </ToolbarButton>
        }
      />

      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">待核对任务</h2>
            <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
              只依据已保存的远端身份、账单或任务证据修正。不能用超时推定未创建，也不会在这里发起新的付费生成。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`cap ${filter === 'attention' ? 'cap-primary' : ''}`}
              onClick={() => setFilter('attention')}
            >
              只看待核对
            </button>
            <button
              type="button"
              className={`cap ${filter === 'all' ? 'cap-primary' : ''}`}
              onClick={() => setFilter('all')}
            >
              全部统一任务
            </button>
          </div>
        </div>
        {error ? <p role="alert" className="mt-3 text-[13px] text-fail">{error}</p> : null}
        {notice ? <p role="status" className="mt-3 text-[13px] text-ok">{notice}</p> : null}
      </section>

      {loading && !data ? (
        <p role="status" className="card p-5 text-[13px] text-ink-secondary">正在读取核对记录…</p>
      ) : null}

      {!loading && items.length === 0 ? (
        <section className="card p-8 text-center">
          <p className="text-[14px] font-medium text-ink">目前没有需要核对的统一任务</p>
          <p className="mt-1 text-[12px] text-ink-secondary">未知结果会继续保存在任务记录和名额占用中，不会被超时自动释放。</p>
        </section>
      ) : null}

      {items.map((task) => {
        const draft = drafts[task.mediaTaskId] ?? draftFor(task);
        const selectedChannel = task.channels.find((channel) => channel.channelKey === draft.channelKey);
        const targetBusy = busy === task.mediaTaskId;
        const settledCost = task.cost.costStatus === 'settled'
          ? money(task.cost.actualMinor)
          : task.cost.costStatus === 'released' ? '¥0.00' : '待核账';
        return (
          <section key={task.mediaTaskId} className="card p-5" data-testid="reconcile-task">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[15px] font-semibold text-ink">{task.unifiedModelLabel}</h2>
                  <Tag tone={toneFor(task.status)}><StatusDot tone={toneFor(task.status)} />{label(task.status)}</Tag>
                  {task.cancelRequestedAt ? <Tag tone="warn">取消意图 · {time(task.cancelRequestedAt)}</Tag> : null}
                </div>
                <p className="mt-1 text-[13px] text-ink-secondary">
                  {task.actorDisplayName}（{task.employeeId}） · {sourceLabel(task.sourceType)}：{task.scopeName}
                </p>
                <p className="mt-1 break-all font-mono text-[11px] text-ink-tertiary">
                  任务 {task.taskId} · 统一任务 {task.mediaTaskId} · 规则 {task.ruleVersion} · 版本 {task.reconcileVersion}
                </p>
              </div>
              <div className="grid min-w-52 grid-cols-2 gap-x-5 gap-y-2 text-[12px]">
                <span className="text-ink-tertiary">最近检查</span><span className="text-ink-secondary">{time(task.lastCheckedAt)}</span>
                <span className="text-ink-tertiary">费用状态</span><span className="text-ink-secondary">{label(task.cost.costStatus)}</span>
                <span className="text-ink-tertiary">已占名额</span><span className="text-ink-secondary tnum">{task.occupancy.heldConcurrency}</span>
                <span className="text-ink-tertiary">待核占用</span><span className="text-ink-secondary tnum">{money(task.occupancy.heldCostMinor)}</span>
                <span className="text-ink-tertiary">已估 / 已结</span><span className="text-ink-secondary tnum">{money(task.cost.reservedMinor)} / {settledCost}</span>
                {task.lastAction ? (
                  <>
                    <span className="text-ink-tertiary">上次核对</span>
                    <span className="text-ink-secondary">
                      {ACTION_LABELS[task.lastAction.action]} · {task.lastAction.actorUserId} · {time(task.lastAction.createdAt)}
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            {task.attentionReasons.length > 0 ? (
              <p className="mt-3 rounded-[9px] bg-warn-tint px-3 py-2 text-[12px] text-warn">
                待核对原因：{task.attentionReasons.join('、')}
              </p>
            ) : null}
            {task.businessError ? (
              <p className="mt-2 text-[12px] leading-5 text-ink-secondary">业务状态：{task.businessError}</p>
            ) : null}

            <div className="mt-4 space-y-3">
              {task.channels.map((channel) => (
                <div key={channel.channelKey} className="rounded-[10px] border border-hairline p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-ink">{channel.channelKey === 'qiniu' ? '七牛通道' : channel.channelKey === 'tencent' ? '腾讯通道' : channel.channelKey}</span>
                      <Tag tone={toneFor(channel.state)}><StatusDot tone={toneFor(channel.state)} />{label(channel.state)}</Tag>
                      {channel.operationStatus ? <span className="text-[11px] text-ink-tertiary">操作 {label(channel.operationStatus)}</span> : null}
                      {channel.waitReason ? <span className="text-[11px] text-warn">等待：{label(channel.waitReason)}</span> : null}
                    </div>
                    <span className="break-all font-mono text-[10px] text-ink-tertiary">{channel.providerModel}</span>
                  </div>
                  <div className="mt-2 grid gap-2 text-[11px] text-ink-secondary md:grid-cols-4">
                    <span>远端：{channel.remoteId ?? '未记录'}</span>
                    <span>尝试：{channel.attempts.length}</span>
                    <span>占用：{channel.heldConcurrency} 名额 / {money(channel.heldCostMinor)}</span>
                    <span>检查：{time(channel.lastCheckedAt)}</span>
                  </div>
                  {channel.attempts.length > 0 ? (
                    <div className="mt-2 overflow-x-auto">
                      <table className="data-table min-w-[820px]">
                        <thead><tr><th>尝试</th><th>提交 / 终态</th><th>远端 ID</th><th>费用</th><th>错误</th><th>核对</th></tr></thead>
                        <tbody>
                          {channel.attempts.map((attempt) => (
                            <tr key={attempt.attemptId}>
                              <td className="font-mono text-[11px]">{attempt.attemptId.slice(0, 8)} · #{attempt.transportSeq}</td>
                              <td>{label(attempt.submissionState)} / {label(attempt.terminalState)}</td>
                              <td className="max-w-44 break-all font-mono text-[11px]">{attempt.remoteId ?? attempt.receiptRemoteId ?? '—'}</td>
                              <td className="tnum">{money(attempt.actualMinor ?? attempt.reservedMinor)}<span className="ml-1 text-ink-tertiary">{label(attempt.costStatus)}</span></td>
                              <td className="max-w-44 break-all text-[11px]">{attempt.errorCode ?? '—'}</td>
                              <td>
                                <button
                                  type="button"
                                  className="cap"
                                  onClick={() => selectAttempt(task, channel.channelKey, attempt.attemptId)}
                                  aria-pressed={draft.channelKey === channel.channelKey && draft.attemptId === attempt.attemptId}
                                >
                                  选择
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p className="mt-2 text-[12px] text-ink-tertiary">这条通道还没有真实提交尝试。</p>}
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-[10px] bg-group p-4">
              <GroupHeading>核对动作</GroupHeading>
              <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="text-[12px] text-ink-secondary">
                  目标尝试
                  <select
                    className="input-field mt-1 w-full"
                    value={`${draft.channelKey}\u0000${draft.attemptId}`}
                    onChange={(event) => {
                      const [channelKey, attemptId] = event.target.value.split('\u0000');
                      selectAttempt(task, channelKey, attemptId);
                    }}
                  >
                    {task.channels.flatMap((channel) => channel.attempts.map((attempt) => (
                      <option key={attempt.attemptId} value={`${channel.channelKey}\u0000${attempt.attemptId}`}>
                        {channel.channelKey} · {attempt.attemptId.slice(0, 8)} · {label(attempt.terminalState ?? attempt.submissionState)}
                      </option>
                    )))}
                  </select>
                </label>
                <label className="text-[12px] text-ink-secondary">
                  动作
                  <select
                    className="input-field mt-1 w-full"
                    value={draft.action}
                    onChange={(event) => patchDraft(task.mediaTaskId, {
                      action: event.target.value as UnifiedReconcileAction,
                    })}
                  >
                    {Object.entries(ACTION_LABELS).map(([value, text]) => (
                      <option key={value} value={value}>{text}</option>
                    ))}
                  </select>
                </label>
                {needsRemoteId(draft.action) ? (
                  <label className="text-[12px] text-ink-secondary">
                    远端任务 ID
                    <input
                      className="input-field mt-1 w-full"
                      value={draft.remoteId}
                      onChange={(event) => patchDraft(task.mediaTaskId, { remoteId: event.target.value })}
                      placeholder="只填有账单或后台证据的 ID"
                    />
                  </label>
                ) : null}
                {needsCost(draft.action) ? (
                  <label className="text-[12px] text-ink-secondary">
                    已核账费用（元，可留空）
                    <input
                      className="input-field mt-1 w-full"
                      inputMode="decimal"
                      value={draft.actualCost}
                      onChange={(event) => patchDraft(task.mediaTaskId, { actualCost: event.target.value })}
                      placeholder="留空表示仍未核清"
                    />
                  </label>
                ) : null}
                {acceptsResultRef(draft.action) ? (
                  <label className="text-[12px] text-ink-secondary">
                    原结果地址（可选）
                    <input
                      className="input-field mt-1 w-full"
                      value={draft.resultRef}
                      onChange={(event) => patchDraft(task.mediaTaskId, { resultRef: event.target.value })}
                      placeholder="已有成品地址时填；只在原通道补下载"
                    />
                  </label>
                ) : null}
              </div>
              <label className="mt-3 block text-[12px] text-ink-secondary">
                核对依据（必填，会写审计）
                <textarea
                  className="input-field mt-1 min-h-20 w-full resize-y"
                  value={draft.evidence}
                  onChange={(event) => patchDraft(task.mediaTaskId, { evidence: event.target.value })}
                  placeholder="例如：供应商后台任务号、账单记录编号、人工核对时间；不要把密钥或完整签名 URL 写进来。"
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-2xl text-[11px] leading-5 text-ink-tertiary">
                  补 ID 只续查原通道；确认未创建/失败才可能使用剩余备用通道；取消任务只收尾，不重启备用或下游。
                </p>
                <button
                  type="button"
                  className="cap cap-primary"
                  disabled={
                    targetBusy
                    || !selectedChannel
                    || !draft.attemptId
                    || draft.evidence.trim().length < 4
                    || (needsRemoteId(draft.action) && !draft.remoteId.trim())
                  }
                  onClick={() => void submit(task)}
                >
                  {targetBusy ? '处理中…' : '保存核对结果'}
                </button>
              </div>
            </div>
          </section>
        );
      })}

      {data?.legacyItems.length ? (
        <section className="card p-5">
          <h2 className="text-[15px] font-semibold text-ink">旧执行证据（无法关联统一任务）</h2>
          <p className="mt-1 text-[12px] text-ink-secondary">这些记录保留原执行身份，不按名称或文件名猜测归属，也不在这里重置通道次数。</p>
          <div className="mt-3 overflow-x-auto">
            <table className="data-table min-w-[760px]">
              <thead><tr><th>来源</th><th>成员</th><th>执行身份</th><th>状态</th><th>远端 ID</th><th>时间</th></tr></thead>
              <tbody>
                {data.legacyItems.map((item, index) => (
                  <tr key={`${item.kind}:${item.operationId ?? item.attemptId ?? index}`}>
                    <td>{item.kind === 'orphan' ? 'journal 孤儿' : '旧操作'}</td>
                    <td className="font-mono text-[11px]">{item.actorUserId}</td>
                    <td className="break-all font-mono text-[11px]">{item.operationId ?? item.attemptId ?? '—'}</td>
                    <td>{label(item.status)}</td>
                    <td className="break-all font-mono text-[11px]">{item.remoteId ?? '—'}</td>
                    <td>{time(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
