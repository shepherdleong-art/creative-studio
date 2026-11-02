'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { addUsageDays, usagePresetRange } from '@/lib/usage-date-range';
import type { TeamMemberSummary, TeamUsageAttempt } from '@/lib/team-service/usage';

type TeamUsageResponse = {
  items: TeamUsageAttempt[];
  totals: { settledMinor: number; estimatedMinor: number; unpricedCount: number; uncertainCount: number };
  localAgentIncluded: false;
  costNotice: string;
  member: TeamMemberSummary;
};

const subscribe = () => () => {};
const isServer = () => document.documentElement.dataset.deploymentMode === 'server';
const serverSnapshot = () => false;
const WAITING_LABELS: Record<string, string> = {
  monthly_budget: '余额不足',
  personal_concurrency: '并发等待',
  actor_paused: '已暂停新的付费生成',
  actor_disabled: '账号停用',
  pricing_required: '定价缺失，请联系管理员',
  cost_unknown: '费用不确定，等待核查',
  pool_capacity: '共享并发等待',
};

function money(minor: number | null): string {
  return minor === null ? '不限额' : `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function amount(item: TeamUsageAttempt): string {
  if (item.costStatus === 'unpriced') return '未定价';
  if (item.costStatus === 'uncertain') return '不确定';
  if (item.costStatus === 'estimated') return `${money(item.reservedMinor)}（预估）`;
  return money(item.actualMinor);
}

export default function TeamUsagePanel() {
  const server = useSyncExternalStore(subscribe, isServer, serverSnapshot);
  const [period, setPeriod] = useState<'today' | 'month' | 'custom'>('month');
  const initial = useMemo(() => usagePresetRange('month'), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [model, setModel] = useState('');
  const [outcome, setOutcome] = useState('');
  const [data, setData] = useState<TeamUsageResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!server) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      setLoading(true);
      setError('');
    });
    const params = new URLSearchParams({ period });
    if (period === 'custom') {
      if (from) params.set('from', from);
      if (to) params.set('to', addUsageDays(to, 1));
    }
    if (model.trim()) params.set('model', model.trim());
    if (outcome) params.set('outcome', outcome);
    fetch(`/api/team/usage?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as TeamUsageResponse & { message?: string };
        if (!response.ok) throw new Error(body.message ?? '团队用量读取失败');
        setData(body);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : '团队用量读取失败');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [server, period, from, to, model, outcome, nonce]);

  if (!server) return null;
  const member = data?.member;
  const waiting = member?.waitingReason ? WAITING_LABELS[member.waitingReason] ?? member.waitingReason : null;

  return (
    <section className="card space-y-5 p-5" aria-label="团队费用与并发">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold text-ink">团队费用与并发</h2><p className="mt-1 text-xs text-ink-tertiary">只读展示本人额度、预留、并发与每个实际上游尝试。</p></div>
        {waiting && <p className="rounded-lg bg-surface-subtle px-3 py-2 text-xs text-warn" role="status">{waiting}</p>}
      </div>
      {member && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl bg-surface-subtle p-3"><p className="text-xs text-ink-tertiary">今日已计</p><p className="mt-1 font-semibold text-ink">{money(member.todayChargedMinor)}</p></div>
        <div className="rounded-xl bg-surface-subtle p-3"><p className="text-xs text-ink-tertiary">本月已计 / 额度</p><p className="mt-1 font-semibold text-ink">{money(member.monthChargedMinor)} / {money(member.monthlyLimitMinor)}</p></div>
        <div className="rounded-xl bg-surface-subtle p-3"><p className="text-xs text-ink-tertiary">held 预留</p><p className="mt-1 font-semibold text-ink">{money(member.heldMinor)}</p></div>
        <div className="rounded-xl bg-surface-subtle p-3"><p className="text-xs text-ink-tertiary">剩余可用</p><p className="mt-1 font-semibold text-ink">{money(member.remainingMinor)}</p></div>
        <div className="rounded-xl bg-surface-subtle p-3"><p className="text-xs text-ink-tertiary">当前并发 / 上限</p><p className="mt-1 font-semibold text-ink">{member.currentConcurrency} / {member.concurrencyLimit}</p></div>
      </div>}
      {member?.paused && <p className="text-xs text-warn">已暂停新的付费生成；仍可登录、编辑、查看和下载，已受理任务继续回收。</p>}
      <div className="flex flex-wrap items-end gap-3 border-y border-hairline py-4">
        <div className="flex gap-2" role="group" aria-label="团队用量账期">
          <button className={`btn-sm ${period === 'today' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPeriod('today')}>今日</button>
          <button className={`btn-sm ${period === 'month' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPeriod('month')}>本月</button>
          <button className={`btn-sm ${period === 'custom' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPeriod('custom')}>自选日期</button>
        </div>
        {period === 'custom' && <><label className="text-xs text-ink-secondary">开始<input type="date" className="input-field mt-1" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label className="text-xs text-ink-secondary">结束（含）<input type="date" className="input-field mt-1" value={to} onChange={(event) => setTo(event.target.value)} /></label></>}
        <label className="text-xs text-ink-secondary">模型<input className="input-field mt-1 w-52" value={model} onChange={(event) => setModel(event.target.value)} placeholder="核心模型标识" /></label>
        <label className="text-xs text-ink-secondary">结果<select className="input-field mt-1" value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="">全部</option><option value="succeeded">成功</option><option value="failed">失败</option></select></label>
        <button className="btn-secondary btn-sm" onClick={() => setNonce((value) => value + 1)}>刷新</button>
      </div>
      {error && <div role="alert" className="text-sm text-fail">{error}</div>}
      {loading && !data ? <p className="py-6 text-center text-sm text-ink-tertiary">读取团队用量…</p> : data && <>
        <div className="flex flex-wrap gap-4 text-xs text-ink-secondary"><span>已结算 {money(data.totals.settledMinor)}</span><span>已知预估 {money(data.totals.estimatedMinor)}</span><span>未定价 {data.totals.unpricedCount} 次</span><span>不确定 {data.totals.uncertainCount} 次</span></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm"><thead className="border-b border-hairline text-xs text-ink-tertiary"><tr><th className="px-3 py-2">时间 / 模块</th><th className="px-3 py-2">任务 / 重试</th><th className="px-3 py-2">模型</th><th className="px-3 py-2">上游请求</th><th className="px-3 py-2">结果</th><th className="px-3 py-2 text-right">费用</th></tr></thead><tbody className="divide-y divide-hairline">{data.items.map((item) => <tr key={item.attemptId}><td className="px-3 py-3 text-ink-secondary"><div>{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div><div className="text-xs">{item.module} / {item.step}</div></td><td className="px-3 py-3"><div className="font-mono text-xs text-ink">{item.taskId}</div><div className="text-xs text-ink-tertiary">业务 {item.businessAttemptNo} · 提交 {item.submitRound} · 传输 {item.transportSeq}</div>{item.errorId && <Link className="text-xs text-accent" href={`/team/errors?errorId=${item.errorId}`}>错误 {item.errorId.slice(0, 8)}</Link>}</td><td className="px-3 py-3 text-ink-secondary">{item.model}</td><td className="px-3 py-3 font-mono text-xs text-ink-tertiary">{item.remoteId ?? '尚无回执'}</td><td className="px-3 py-3 text-ink-secondary">{item.outcome ?? item.submissionState}</td><td className="px-3 py-3 text-right font-medium text-ink">{amount(item)}</td></tr>)}</tbody></table>{data.items.length === 0 && <p className="py-8 text-center text-sm text-ink-tertiary">当前范围没有服务器执行尝试。</p>}</div>
        <p className="text-xs leading-5 text-ink-tertiary">{data.costNotice} 本地 Agent 明确不计入；未定价与不确定费用不显示为 0，也不代表供应商最终账单。</p>
      </>}
    </section>
  );
}
