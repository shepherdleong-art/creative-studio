'use client';

import { useEffect, useMemo, useState, useSyncExternalStore, type PointerEvent } from 'react';
import Link from 'next/link';
import { addUsageDays, usagePresetRange, type UsageDatePreset } from '@/lib/usage-date-range';
import { TASK_MODULE_LABELS, TASK_STATUS_LABELS } from '@/lib/team-task-labels';
import type { TeamMemberSummary, TeamModelUsage, TeamUsageAttempt, TeamUsageMember, TeamUsageTrendPoint } from '@/lib/team-service/usage';

type Period = UsageDatePreset | 'custom';
type TeamUsageResponse = {
  items: TeamUsageAttempt[];
  totals: { settledMinor: number; estimatedMinor: number; unpricedCount: number; uncertainCount: number };
  localAgentIncluded: false;
  costNotice: string;
  member: TeamMemberSummary;
  members: TeamUsageMember[];
  models: TeamModelUsage[];
  trend: TeamUsageTrendPoint[];
  modelOptions: string[];
  teamQuota: null | {
    accountingPeriod: string; chargedMinor: number; settledMinor: number; heldMinor: number;
    limitedCount: number; limitedTotalMinor: number; limitedRemainingMinor: number; unlimitedCount: number;
  };
  scope: 'self' | 'team'; canViewTeam: boolean;
};

const subscribe = () => () => {};
const isServer = () => document.documentElement.dataset.deploymentMode === 'server';
const serverSnapshot = () => false;
const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'today', label: '今日' }, { key: 'last7', label: '近 7 天' },
  { key: 'week', label: '本周' }, { key: 'month', label: '本月' }, { key: 'custom', label: '自选日期' },
];
const MODEL_COLORS = ['var(--color-accent)', 'var(--color-check)', 'var(--color-ok)', 'var(--color-warn)', 'var(--color-fail)', 'var(--color-ink-secondary)'];
const WAITING_LABELS: Record<string, string> = {
  monthly_budget: '余额不足', personal_concurrency: '并发等待', actor_paused: '已暂停新的付费生成',
  actor_disabled: '账号停用', pricing_required: '定价缺失，请联系管理员', cost_unknown: '费用不确定，等待核查',
  pool_capacity: '共享并发等待', model_forbidden: '模型未授权，请联系管理员',
  maintenance: '团队维护等待', pool_missing: '资源池未配置', pool_disabled: '资源池已停用',
  scope_forbidden: '项目访问权限不足',
};

function money(minor: number | null): string {
  return minor === null ? '不限额' : `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CONCURRENCY_SOURCE_LABELS = {
  legacy_fixed: '旧个人固定值（未迁移）',
  team_default: '继承团队手动默认',
  personal_fixed: '个人固定覆盖',
} as const;

function amount(item: TeamUsageAttempt): string {
  if (item.costStatus === 'released') return '已释放';
  if (item.costStatus === 'unpriced') return '未定价';
  if (item.costStatus === 'uncertain') return '不确定';
  if (item.costStatus === 'estimated') return `${money(item.reservedMinor)}（预估）`;
  return money(item.actualMinor);
}

function SectionTitle({ title, note, aside }: { title: string; note: string; aside?: string }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div><h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2><p className="mt-1 text-xs leading-5 text-ink-tertiary">{note}</p></div>
    {aside && <span className="text-xs text-ink-tertiary">{aside}</span>}
  </div>;
}

function QuotaCards({ member, quota, detail }: { member: TeamMemberSummary; quota: TeamUsageResponse['teamQuota']; detail: boolean }) {
  const cards = quota && !detail ? [
    ['本月团队已计', money(quota.chargedMinor), `已结算 ${money(quota.settledMinor)}`],
    ['有限额度合计', money(quota.limitedTotalMinor), `${quota.limitedCount} 位有限额度成员`],
    ['有限额度剩余', money(quota.limitedRemainingMinor), `另有 ${quota.unlimitedCount} 位不限额`],
    ['待结算预留', money(quota.heldMinor), '已包含在本月已计'],
  ] : [
    ['本月已计 / 额度', `${money(member.monthChargedMinor)} / ${money(member.monthlyLimitMinor)}`, `已结算 ${money(member.monthSettledMinor)}`],
    ['待结算预留', money(member.heldMinor), '已包含在本月已计'],
    ['剩余可用', money(member.remainingMinor), '含预留后的可用金额'],
    ['当前并发 / 上限', `${member.currentConcurrency} / ${member.concurrencyLimit}`, `今日已计 ${money(member.todayChargedMinor)}`],
  ];
  return <section className="card p-5" aria-label={quota && !detail ? '团队额度' : '我的额度'}>
    <SectionTitle title={quota && !detail ? '团队额度' : `${member.displayName}的额度`}
      note={`${member.displayName}（${member.employeeId}） · 北京时间自然月，不随用量筛选变化`} aside={quota?.accountingPeriod} />
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, value, note]) => <div key={label} className="min-w-0 rounded-xl bg-surface-subtle p-4">
        <p className="text-xs text-ink-tertiary">{label}</p><p className="mt-2 break-words text-xl font-semibold tracking-tight text-ink">{value}</p><p className="mt-1 text-xs text-ink-tertiary">{note}</p>
      </div>)}
    </div>
    {member.paused && <p className="mt-4 text-xs text-warn">已暂停新的付费生成；仍可登录、编辑、查看和下载，已受理任务继续回收。</p>}
    <p className="mt-3 text-xs leading-5 text-ink-tertiary">并发来源：{CONCURRENCY_SOURCE_LABELS[member.concurrencySource]}。个人上限不预留共享池名额；{member.waitingReason ? `等待原因：${WAITING_LABELS[member.waitingReason] ?? member.waitingReason}。` : '当前没有等待中的任务。'}</p>
  </section>;
}

function TrendChart({ trend, models }: { trend: TeamUsageTrendPoint[]; models: TeamModelUsage[] }) {
  const [inspected, setInspected] = useState<{ index: number; model: string } | null>(null);
  const width = 920; const height = 280;
  const padding = { top: 20, right: 24, bottom: 40, left: 76 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(1, ...trend.flatMap(point => Object.values(point.byModel)));
  const activeModels = models.filter(model => model.chargedMinor > 0);
  const color = (model: string) => MODEL_COLORS[Math.max(0, models.findIndex(item => item.model === model)) % MODEL_COLORS.length];
  const xFor = (index: number) => padding.left + (trend.length <= 1 ? plotWidth / 2 : index / (trend.length - 1) * plotWidth);
  const yFor = (value: number) => padding.top + plotHeight - Math.max(0, value) / maximum * plotHeight;
  const inspect = (event: PointerEvent<SVGSVGElement>) => {
    if (!activeModels.length || !trend.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * width;
    const y = (event.clientY - bounds.top) / bounds.height * height;
    const position = Math.max(0, Math.min(trend.length - 1, (x - padding.left) / plotWidth * (trend.length - 1)));
    const index = Math.round(position);
    const closest = activeModels.reduce((best, item) => Math.abs(y - yFor(trend[index].byModel[item.model] ?? 0)) < best.distance
      ? { model: item.model, distance: Math.abs(y - yFor(trend[index].byModel[item.model] ?? 0)) } : best, { model: activeModels[0].model, distance: Infinity });
    setInspected({ index, model: closest.model });
  };
  return <div className="relative min-w-0">
    <div className="overflow-x-auto rounded-xl bg-surface-subtle/60 px-2 py-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full min-w-[620px]" role="img" aria-label="当前范围每日模型费用趋势" onPointerMove={inspect} onPointerLeave={() => setInspected(null)} onPointerCancel={() => setInspected(null)}>
        {[0, 0.5, 1].map(ratio => <g key={ratio}><line x1={padding.left} x2={width - padding.right} y1={padding.top + plotHeight * ratio} y2={padding.top + plotHeight * ratio} stroke="var(--color-hairline)" /><text x={padding.left - 12} y={padding.top + plotHeight * ratio + 4} textAnchor="end" className="fill-ink-tertiary text-[12px]">{money(Math.round(maximum * (1 - ratio)))}</text></g>)}
        {trend.map((point, index) => {
          const show = trend.length <= 8 || index === 0 || index === trend.length - 1 || index % Math.ceil(trend.length / 6) === 0;
          return show ? <text key={point.date} x={xFor(index)} y={height - 12} textAnchor={index === 0 ? 'start' : index === trend.length - 1 ? 'end' : 'middle'} className="fill-ink-tertiary text-[12px]">{point.date.slice(5)}</text> : null;
        })}
        {activeModels.map(model => <polyline key={model.model} fill="none" stroke={color(model.model)} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity={inspected && inspected.model !== model.model ? 0.3 : 1} points={trend.map((point, index) => `${xFor(index)},${yFor(point.byModel[model.model] ?? 0)}`).join(' ')} />)}
        {inspected && trend[inspected.index] && <g pointerEvents="none"><line x1={xFor(inspected.index)} x2={xFor(inspected.index)} y1={padding.top} y2={padding.top + plotHeight} stroke="var(--color-ink-tertiary)" strokeDasharray="4 4" /><circle cx={xFor(inspected.index)} cy={yFor(trend[inspected.index].byModel[inspected.model] ?? 0)} r="5" fill={color(inspected.model)} stroke="var(--color-surface)" strokeWidth="2" /></g>}
        {!activeModels.length && <text x={width / 2} y={height / 2} textAnchor="middle" className="fill-ink-tertiary text-sm">当前范围暂无已知费用记录</text>}
      </svg>
    </div>
    {inspected && trend[inspected.index] && <div role="tooltip" className="pointer-events-none absolute top-3 z-10 rounded-xl border border-hairline bg-surface px-4 py-3 text-xs shadow-lg" style={inspected.index < trend.length / 2 ? { right: 16 } : { left: 16 }}><p className="text-ink-tertiary">{trend[inspected.index].date}</p><p className="mt-1 max-w-64 break-all font-medium text-ink">{inspected.model}</p><p className="mt-1 font-semibold text-ink">{money(trend[inspected.index].byModel[inspected.model] ?? 0)}</p></div>}
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-secondary">{models.map(model => <button type="button" key={model.model} className="inline-flex max-w-full items-center gap-2 text-left" onFocus={() => setInspected({ index: Math.max(0, trend.length - 1), model: model.model })} onBlur={() => setInspected(null)} onKeyDown={event => {
      if (event.key === 'Escape') setInspected(null);
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setInspected(current => ({ model: model.model, index: Math.max(0, Math.min(trend.length - 1, (current?.index ?? trend.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1))) }));
    }}><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color(model.model) }} /><span className="break-all">{model.model}</span></button>)}</div>
  </div>;
}

function ModelAnalysis({ models, trend, totals }: { models: TeamModelUsage[]; trend: TeamUsageTrendPoint[]; totals: TeamUsageResponse['totals'] }) {
  const total = models.reduce((sum, model) => sum + model.chargedMinor, 0);
  return <section className="card p-5" aria-label="模型消耗排行与趋势">
    <SectionTitle title="模型消耗排行与趋势" note="按当前日期和筛选范围汇总 · 已计含已结算、预留与不确定费用" aside={`${models.reduce((sum, model) => sum + model.callCount, 0)} 次调用 · ${money(total)}`} />
    <div className="mt-5 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,1fr)] xl:items-start">
      <div className="min-w-0"><h3 className="mb-3 text-sm font-medium text-ink">每日模型费用</h3><TrendChart trend={trend} models={models} /></div>
      <div className="min-w-0"><h3 className="mb-3 text-sm font-medium text-ink">模型费用统计</h3><div className="overflow-x-auto"><table className="w-full min-w-[480px] text-left text-sm"><thead className="border-b border-hairline text-xs text-ink-tertiary"><tr><th className="px-2 py-2 font-medium">模型 / 模块</th><th className="px-2 py-2 font-medium">调用</th><th className="px-2 py-2 text-right font-medium">已计费用</th><th className="px-2 py-2 text-right font-medium">占比</th></tr></thead><tbody className="divide-y divide-hairline">{models.map(model => <tr key={model.model} className="align-top"><td className="max-w-56 px-2 py-3"><p className="break-all font-medium text-ink">{model.model}</p><p className="mt-1 text-xs text-ink-tertiary">{model.modules.map(module => TASK_MODULE_LABELS[module] ?? module).join('、')}</p></td><td className="whitespace-nowrap px-2 py-3 text-ink-secondary">{model.callCount} 次</td><td className="whitespace-nowrap px-2 py-3 text-right font-medium text-ink">{money(model.chargedMinor)}</td><td className="px-2 py-3 text-right text-xs text-ink-secondary">{model.percentage.toFixed(1)}%<div className="ml-auto mt-2 h-1.5 w-20 overflow-hidden rounded-full bg-surface-subtle"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, model.percentage)}%` }} /></div></td></tr>)}</tbody></table>{models.length === 0 && <p className="py-10 text-center text-sm text-ink-tertiary">当前范围暂无模型调用</p>}</div><p className="mt-4 text-xs leading-5 text-ink-tertiary">未定价 {totals.unpricedCount} 次 · 不确定 {totals.uncertainCount} 次，不显示为零元。</p></div>
    </div>
  </section>;
}

function MemberTable({ members, onOpen }: { members: TeamUsageMember[]; onOpen: (id: string) => void }) {
  return <section className="card p-5" aria-label="成员用量"><SectionTitle title="成员用量" note="调用与筛选费用属于当前范围；额度与本月已计属于北京时间自然月" aside={`${members.length} 位成员`} /><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[960px] text-left text-sm"><thead className="border-b border-hairline text-xs text-ink-tertiary"><tr><th className="px-3 py-2 font-medium">成员</th><th className="px-3 py-2 font-medium">调用</th><th className="px-3 py-2 font-medium">筛选期已计</th><th className="px-3 py-2 font-medium">本月已计</th><th className="px-3 py-2 font-medium">月度额度</th><th className="px-3 py-2 font-medium">剩余可用</th><th className="px-3 py-2" /></tr></thead><tbody className="divide-y divide-hairline">{members.map(member => <tr key={member.userId}><td className="px-3 py-3"><p className="font-medium text-ink">{member.displayName}</p><p className="mt-1 text-xs text-ink-tertiary">{member.employeeId} · {member.role === 'admin' ? '管理员' : '员工'}</p></td><td className="px-3 py-3 text-ink-secondary">{member.callCount} 次</td><td className="px-3 py-3 font-medium text-ink">{money(member.rangeChargedMinor)}</td><td className="px-3 py-3 text-ink-secondary">{money(member.monthChargedMinor)}</td><td className="px-3 py-3 text-ink-secondary">{money(member.monthlyLimitMinor)}</td><td className="px-3 py-3 text-ink-secondary">{money(member.remainingMinor)}</td><td className="px-3 py-3 text-right"><button className="btn-secondary btn-sm whitespace-nowrap" onClick={() => onOpen(member.userId)} aria-label={`查看${member.displayName}的用量`}>查看用量</button></td></tr>)}</tbody></table></div></section>;
}

function UsageDetails({ items, canViewTeam }: { items: TeamUsageAttempt[]; canViewTeam: boolean }) {
  return <section className="card p-5" aria-label="调用明细"><SectionTitle title="调用明细" note="按时间倒序 · 展开查看任务、请求与错误关联" aside={`${items.length} 条记录`} /><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[800px] table-fixed text-left text-sm"><thead className="border-b border-hairline text-xs text-ink-tertiary"><tr><th className="w-[19%] px-3 py-2 font-medium">时间{canViewTeam ? ' / 成员' : ''}</th><th className="w-[24%] px-3 py-2 font-medium">模型 / 模块</th><th className="w-[16%] px-3 py-2 font-medium">结果</th><th className="w-[17%] px-3 py-2 text-right font-medium">费用</th><th className="w-[24%] px-3 py-2 font-medium">调用详情</th></tr></thead><tbody className="divide-y divide-hairline">{items.map(item => <tr key={item.attemptId} className="align-top"><td className="px-3 py-3 text-ink-secondary"><div>{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>{canViewTeam && <div className="mt-1 text-xs">{item.actorDisplayName} · {item.employeeId}</div>}</td><td className="break-all px-3 py-3 text-ink-secondary">{item.model}<div className="mt-1 text-xs text-ink-tertiary">{TASK_MODULE_LABELS[item.module] ?? item.module}</div></td><td className="px-3 py-3 text-ink-secondary">{TASK_STATUS_LABELS[item.outcome ?? item.submissionState] ?? item.outcome ?? item.submissionState}</td><td className="px-3 py-3 text-right font-medium text-ink">{amount(item)}</td><td className="px-3 py-3 text-xs text-ink-tertiary"><details><summary className="cursor-pointer text-accent">查看任务与请求</summary><div className="mt-2 space-y-2 break-all"><div>任务：{item.taskId}</div><div>上游请求：{item.remoteId ?? '尚无回执'}</div><div>业务 {item.businessAttemptNo} · 提交 {item.submitRound} · 传输 {item.transportSeq}</div>{item.errorId && <Link className="text-accent" href={`/team/errors?errorId=${item.errorId}`}>查看错误</Link>}</div></details></td></tr>)}</tbody></table>{items.length === 0 && <p className="py-10 text-center text-sm text-ink-tertiary">当前范围没有服务器调用记录。</p>}</div></section>;
}

export default function TeamUsagePanel() {
  const server = useSyncExternalStore(subscribe, isServer, serverSnapshot);
  const [period, setPeriod] = useState<Period>('month');
  const initial = useMemo(() => usagePresetRange('month'), []);
  const [from, setFrom] = useState(initial.from); const [to, setTo] = useState(initial.to);
  const [model, setModel] = useState(''); const [scope, setScope] = useState<'self' | 'team'>('self');
  const [selectedMember, setSelectedMember] = useState<string | null>(null); const [outcome, setOutcome] = useState('');
  const [data, setData] = useState<TeamUsageResponse | null>(null); const [error, setError] = useState('');
  const [loading, setLoading] = useState(true); const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!server) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => { setLoading(true); setError(''); });
    const params = new URLSearchParams({ period, scope });
    if (period === 'custom') { if (from) params.set('from', from); if (to) params.set('to', addUsageDays(to, 1)); }
    if (model) params.set('model', model);
    if (outcome) params.set('outcome', outcome);
    if (selectedMember) { params.set('scope', 'team'); params.set('actorUserId', selectedMember); }
    fetch(`/api/team/usage?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json() as TeamUsageResponse & { message?: string };
        if (!response.ok) throw new Error(body.message ?? '团队用量读取失败');
        if (!controller.signal.aborted) setData(body);
      }).catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : '团队用量读取失败');
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [server, period, from, to, model, outcome, nonce, scope, selectedMember]);

  if (!server) return null;
  const member = data?.member;
  const waiting = member?.waitingReason ? WAITING_LABELS[member.waitingReason] ?? member.waitingReason : null;
  const selectPeriod = (next: Period) => {
    setPeriod(next);
    if (next !== 'custom') { const range = usagePresetRange(next); setFrom(range.from); setTo(range.to); }
  };
  const changeScope = (next: 'self' | 'team') => { setScope(next); setSelectedMember(null); setData(null); };
  const exportParams = new URLSearchParams({ period, scope: selectedMember ? 'team' : scope });
  if (period === 'custom') { exportParams.set('from', from); exportParams.set('to', addUsageDays(to, 1)); }
  if (model) exportParams.set('model', model);
  if (outcome) exportParams.set('outcome', outcome);
  if (selectedMember) exportParams.set('actorUserId', selectedMember);

  return <div className="min-w-0 space-y-5 overflow-hidden" aria-label="费用与用量">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-3xl font-semibold tracking-tight text-ink">费用与用量</h1><p className="mt-2 text-sm leading-6 text-ink-secondary">{selectedMember && member ? `${member.displayName}的模型消耗与调用记录。` : data?.scope === 'team' ? '团队额度、模型消耗和成员调用，一处看清。' : '查看个人额度、模型消耗和实际调用记录。'}金额为工作台记录，不代表供应商最终账单。</p></div><div className="flex flex-wrap items-center gap-2">{data?.canViewTeam && <div className="flex gap-2" role="group" aria-label="用量统计范围"><button className={`btn-sm ${!selectedMember && scope === 'self' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => changeScope('self')}>仅看自己</button><button className={`btn-sm ${selectedMember || scope === 'team' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => changeScope('team')}>全团队</button></div>}{data?.canViewTeam && <a className="btn-secondary btn-sm" href={`/api/team/usage/export?${exportParams}`}>导出 CSV</a>}</div></div>
    {waiting && <p className="rounded-lg bg-warn-tint px-3 py-2 text-xs text-warn" role="status">{waiting}</p>}
    {selectedMember && <button className="btn-secondary btn-sm" onClick={() => { setSelectedMember(null); setData(null); }}>← 返回全团队</button>}
    {member && <QuotaCards member={member} quota={data?.teamQuota ?? null} detail={Boolean(selectedMember) || data?.scope === 'self'} />}
    <section className="card p-5" aria-label="用量筛选"><div className="flex flex-wrap items-end gap-3"><div className="flex flex-wrap gap-2" role="group" aria-label="团队用量账期">{PERIODS.map(item => <button key={item.key} className={`btn-sm ${period === item.key ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={period === item.key} onClick={() => selectPeriod(item.key)}>{item.label}</button>)}</div>{period === 'custom' && <><label className="text-xs text-ink-secondary">开始<input type="date" className="input-field mt-1" value={from} max={to} onChange={event => setFrom(event.target.value)} /></label><label className="text-xs text-ink-secondary">结束（含）<input type="date" className="input-field mt-1" value={to} min={from} onChange={event => setTo(event.target.value)} /></label></>}<label className="min-w-48 flex-1 text-xs text-ink-secondary">模型<select className="input-field mt-1" value={model} onChange={event => setModel(event.target.value)}><option value="">全部模型</option>{data?.modelOptions.map(option => <option key={option} value={option}>{option}</option>)}</select></label><label className="text-xs text-ink-secondary">结果<select className="input-field mt-1" value={outcome} onChange={event => setOutcome(event.target.value)}><option value="">全部结果</option><option value="succeeded">成功</option><option value="failed">失败</option></select></label><button className="btn-secondary btn-sm" onClick={() => setNonce(value => value + 1)}>刷新</button></div></section>
    {error && <div role="alert" className="card border-fail/25 bg-fail-tint p-5 text-sm text-fail"><p>{error}</p><button className="btn-secondary btn-sm mt-3" onClick={() => setNonce(value => value + 1)}>重新加载</button></div>}
    {loading && !data ? <div className="card py-20 text-center text-sm text-ink-tertiary" role="status">读取团队用量…</div> : data && <><ModelAnalysis models={data.models} trend={data.trend} totals={data.totals} />{data.canViewTeam && data.scope === 'team' && !selectedMember && <MemberTable members={data.members} onOpen={id => { setSelectedMember(id); setData(null); }} />}<UsageDetails items={data.items} canViewTeam={data.canViewTeam} /><p className="text-xs leading-5 text-ink-tertiary">{data.costNotice} 本地 Agent 不计入；未定价与不确定费用不显示为 0，也不代表供应商最终账单。</p></>}
  </div>;
}
