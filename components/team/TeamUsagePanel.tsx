'use client';

import { useEffect, useMemo, useState, useSyncExternalStore, type PointerEvent } from 'react';
import Link from 'next/link';
import { addUsageDays, usagePresetRange, type UsageDatePreset } from '@/lib/usage-date-range';
import { CONCURRENCY_SOURCE_LABELS, TASK_MODULE_LABELS, TASK_STATUS_LABELS, WAITING_REASON_LABELS } from '@/lib/team-task-labels';
import type { TeamMemberSummary, TeamModelUsage, TeamUsageAttempt, TeamUsageMember, TeamUsageTrendPoint } from '@/lib/team-service/usage';
import type {
  TeamUnifiedChannelView,
  TeamUnifiedTaskView,
} from '@/lib/team-service/unified-usage';
import PageToolbar from './PageToolbar';
import { useTeamRole } from './useTeamRole';
import { EmptyState, GroupList, GroupRow, Segmented, StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';

type Period = UsageDatePreset | 'custom';
type TeamUsageResponse = {
  items: TeamUsageAttempt[];
  tasks: TeamUnifiedTaskView[];
  legacyAttempts: TeamUsageAttempt[];
  unmappedAttempts: TeamUsageAttempt[];
  counts: { generationTasks: number; channelCalls: number; legacyAttempts: number; unmappedAttempts: number };
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
  taskCount: number;
  attemptCount: number;
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
const WAITING_LABELS = WAITING_REASON_LABELS;
const SOURCE_LABELS: Record<string, string> = {
  project_scene: '项目场景图',
  project_shot: '项目分镜',
  project_video: '项目视频',
  project_apply_scene: '分镜应用场景',
  project_regenerate: '项目重新生成',
  canvas: '创作画布',
  rework: '局部返工',
  team_film_rework: '团队实拍返工',
};

function money(minor: number | null): string {
  return minor === null ? '不限额' : `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function amount(item: TeamUsageAttempt): string {
  if (item.costStatus === 'released') return '已释放';
  if (item.costStatus === 'unpriced') return '未定价';
  if (item.costStatus === 'uncertain') return `${money(item.reservedMinor)}（待核账）`;
  if (item.costStatus === 'estimated') return `${money(item.reservedMinor)}（估算）`;
  return `${money(item.actualMinor)}（实际已记录）`;
}

function taskCostLabel(task: TeamUnifiedTaskView): string {
  if (task.costStatus === 'released') return '已释放';
  if (task.costStatus === 'unpriced') return '未定价';
  if (task.costStatus === 'uncertain') return `待核账${task.chargedMinor ? ` · ${money(task.chargedMinor)}` : ''}`;
  if (task.costStatus === 'estimated') return `${money(task.estimatedMinor)}（估算）`;
  if (task.costStatus === 'mixed') return `${money(task.chargedMinor)}（混合）`;
  return `${money(task.settledMinor)}（已记录）`;
}

function taskStatusLabel(task: TeamUnifiedTaskView): string {
  if (task.cancelRequestedAt) return task.status === 'succeeded' ? '已完成 · 停止后续' : '已停止后续生成';
  return TASK_STATUS_LABELS[task.status] ?? task.status;
}

/** 区块标题（原型 `.h4` + 说明）：右侧留一块给范围摘要。 */
function SectionTitle({ title, note, aside }: { title: string; note: string; aside?: string }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div><h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2><p className="mt-1 text-[12px] leading-5 text-ink-tertiary">{note}</p></div>
    {aside && <span className="tnum text-[12px] text-ink-tertiary">{aside}</span>}
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
    ['当前并发 / 上限', `${member.currentConcurrency} / ${member.concurrencyLimit ?? '自动'}`, `今日已计 ${money(member.todayChargedMinor)}`],
  ];
  return <section className="card p-5" aria-label={quota && !detail ? '团队额度' : '我的额度'}>
    <SectionTitle title={quota && !detail ? '团队额度' : `${member.displayName}的额度`}
      note={`${member.displayName}（${member.employeeId}） · 北京时间自然月，不随用量筛选变化`} aside={quota?.accountingPeriod} />
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, value, note]) => <div key={label} className="tile min-w-0 p-4">
        <p className="text-[12px] text-ink-tertiary">{label}</p><p className="tnum mt-1.5 break-words text-[20px] font-semibold tracking-tight text-ink">{value}</p><p className="mt-1 text-[12px] text-ink-tertiary">{note}</p>
      </div>)}
    </div>
    {member.paused && <p className="mt-3 flex items-center gap-2 text-[12px] text-warn"><StatusDot tone="warn" />已暂停新的付费生成；仍可登录、编辑、查看和下载，已受理任务继续回收。</p>}
    <p className="mt-2 text-[12px] leading-5 text-ink-tertiary">并发来源：{CONCURRENCY_SOURCE_LABELS[member.concurrencySource]}。个人上限不预留共享池名额；{member.waitingReason ? `等待原因：${WAITING_LABELS[member.waitingReason] ?? member.waitingReason}。` : '当前没有等待中的任务。'}</p>
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
    <div className="overflow-x-auto rounded-[11px] bg-group px-2 py-3">
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
    {inspected && trend[inspected.index] && <div role="tooltip" className="pointer-events-none absolute top-3 z-10 rounded-[11px] border border-hairline bg-surface px-4 py-3 text-[12px] shadow-lg" style={inspected.index < trend.length / 2 ? { right: 16 } : { left: 16 }}><p className="text-ink-tertiary">{trend[inspected.index].date}</p><p className="mt-1 max-w-64 break-all font-medium text-ink">{inspected.model}</p><p className="tnum mt-1 font-semibold text-ink">{money(trend[inspected.index].byModel[inspected.model] ?? 0)}</p></div>}
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-ink-secondary">{models.map(model => <button type="button" key={model.model} className="inline-flex max-w-full items-center gap-2 text-left" onFocus={() => setInspected({ index: Math.max(0, trend.length - 1), model: model.model })} onBlur={() => setInspected(null)} onKeyDown={event => {
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
    <SectionTitle title="模型消耗排行与趋势" note="按统一模型汇总制作任务；通道调用次数与制作任务数分开统计。已计含已记录、估算与待核账费用" aside={`${models.reduce((sum, model) => sum + model.taskCount, 0)} 个制作任务 · ${models.reduce((sum, model) => sum + model.callCount, 0)} 次通道调用 · ${money(total)}`} />
    <div className="mt-4 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,1fr)] xl:items-start">
      <div className="min-w-0"><h3 className="mb-3 text-[13px] font-medium text-ink">每日模型费用</h3><TrendChart trend={trend} models={models} /></div>
      <div className="min-w-0"><h3 className="mb-3 text-[13px] font-medium text-ink">模型费用统计</h3><div className="overflow-x-auto"><table className="data-table min-w-[560px]"><thead><tr><th>模型 / 模块</th><th>制作任务</th><th>通道调用</th><th className="num">已计费用</th><th className="num">占比</th></tr></thead><tbody>{models.map(model => <tr key={model.model} className="align-top"><td className="max-w-56"><p className="break-all font-medium text-ink">{model.model}</p><p className="mt-1 text-[12px] text-ink-tertiary">{model.modules.map(module => TASK_MODULE_LABELS[module] ?? module).join('、')}</p></td><td className="whitespace-nowrap text-ink-secondary">{model.taskCount} 个</td><td className="whitespace-nowrap text-ink-secondary">{model.callCount} 次</td><td className="num whitespace-nowrap font-medium text-ink">{money(model.chargedMinor)}</td><td className="num"><span className="text-[12px] text-ink-secondary">{model.percentage.toFixed(1)}%</span><span className="ml-auto mt-2 block h-1.5 w-20 overflow-hidden rounded-full" style={{ background: 'var(--color-track)' }}><span className="block h-full rounded-full" style={{ width: `${Math.min(100, model.percentage)}%`, background: 'var(--color-accent)' }} /></span></td></tr>)}</tbody></table>{models.length === 0 && <EmptyState icon="table" title="当前范围暂无模型调用" description="换个日期范围或清空模型筛选再试。" />}</div><p className="mt-3 text-[12px] leading-5 text-ink-tertiary">未定价 {totals.unpricedCount} 次 · 不确定 {totals.uncertainCount} 次，不显示为零元。制作任务数不是通道调用次数。</p></div>
    </div>
  </section>;
}

function ChannelAttemptDetails({ channels }: { channels: TeamUnifiedChannelView[] }) {
  return <div className="mt-3 space-y-2 border-t border-hairline pt-3">
    {channels.map((channel) => <details key={channel.channelKey} className="rounded-[9px] bg-group px-3 py-2">
      <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary">
        {channel.channelKey} · {channel.providerModel} · {channel.state}
        {channel.operationWaitReason ? ` · ${channel.operationWaitReason}` : ''}
      </summary>
      <div className="mt-2 space-y-2 text-[12px] text-ink-tertiary">
        {channel.attempts.length === 0 ? <p>尚未产生真实发起记录。</p> : channel.attempts.map((attempt) => <div key={attempt.attemptId} className="rounded-[7px] bg-surface px-2.5 py-2">
          <p className="break-all text-ink-secondary">{attempt.providerModel} · {attempt.submissionState} {attempt.terminalState ? `→ ${attempt.terminalState}` : ''}</p>
          <p>远端：{attempt.remoteId ?? '尚无回执'} · 费用：{attempt.costStatus === 'settled' ? `${money(attempt.actualMinor ?? 0)}（已记录）` : attempt.costStatus === 'estimated' ? `${money(attempt.reservedMinor)}（估算）` : attempt.costStatus === 'uncertain' ? `${money(attempt.reservedMinor)}（待核账）` : attempt.costStatus === 'unpriced' ? '未定价' : '已释放'}</p>
          <p>执行尝试：{attempt.attemptId}{attempt.pricing?.pricingVersion ? ` · 计价版本 ${attempt.pricing.pricingVersion}` : ''}{attempt.pricing?.coreModelKey ? ` · 计价模型 ${attempt.pricing.coreModelKey}` : ''}</p>
          {attempt.errorCode ? <p>安全错误码：{attempt.errorCode}</p> : null}
        </div>)}
      </div>
    </details>)}
  </div>;
}

function TaskUsageTable({ tasks, canViewTeam }: { tasks: TeamUnifiedTaskView[]; canViewTeam: boolean }) {
  return <section className="card p-5" aria-label="制作任务合计">
    <SectionTitle title="制作任务合计" note="自动兜底仍是一条制作任务；制作任务数与通道调用次数分开统计" aside={`${tasks.length} 个制作任务`} />
    <div className="mt-4 overflow-x-auto">{tasks.length === 0 ? <EmptyState icon="table" title="当前范围没有统一模型制作任务" description="旧调用会在下方“未映射历史记录”明确单列。" /> : <table className="data-table min-w-[880px]"><thead><tr><th>时间{canViewTeam ? ' / 成员' : ''}</th><th>统一模型 / 来源</th><th>状态</th><th>任务 / 通道</th><th className="num">任务合计</th><th>详情</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.mediaTaskId} className="align-top">
      <td className="text-ink-secondary"><div className="tnum">{new Date(task.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>{canViewTeam ? <div className="mt-1 text-[12px]">{task.actorDisplayName} · {task.employeeId}</div> : null}</td>
      <td className="break-all text-ink-secondary"><p className="font-medium text-ink">{task.model}</p><p className="mt-1 text-[12px] text-ink-tertiary">{TASK_MODULE_LABELS[task.module] ?? task.module} · {['project', 'canvas'].includes(task.scope.resourceType)
        ? <Link className="text-accent" href={task.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(task.scope.resourceId)}` : `/canvas/${encodeURIComponent(task.scope.resourceId)}`}>{task.scopeName}</Link>
        : task.scopeName}</p><p className="text-[11px] text-ink-tertiary">{SOURCE_LABELS[task.sourceType] ?? task.sourceType} · 规则 {task.ruleVersion}</p></td>
      <td className="text-ink-secondary">{taskStatusLabel(task)}{task.cancelRequestedAt ? <p className="mt-1 text-[11px] text-warn">已保留取消前已提交结果和费用</p> : null}</td>
      <td className="text-ink-secondary">{task.generationTaskCount} 个任务{canViewTeam
        ? <><p className="mt-1 text-[12px] text-ink-tertiary">通道调用 {task.channelCallCount} 次 · 已提交 {task.submissionCount} · 使用通道 {task.usedChannelCount}</p></>
        : null}</td>
      <td className="num whitespace-nowrap font-medium text-ink">{taskCostLabel(task)}{task.costStatus === 'mixed' ? <p className="mt-1 text-[11px] font-normal text-warn">含待核账或未定价</p> : null}</td>
      <td className="text-[12px] text-ink-tertiary">{canViewTeam
        ? task.channels && task.channels.length > 0
          ? <details><summary className="cursor-pointer text-accent">展开真实通道尝试</summary><ChannelAttemptDetails channels={task.channels} /></details>
          : <span>暂无通道记录</span>
        : <span>员工视图只显示统一模型与任务合计</span>}</td>
    </tr>)}</tbody></table>}</div>
  </section>;
}

function MemberTable({ members, onOpen }: { members: TeamUsageMember[]; onOpen: (id: string) => void }) {
  return <section className="card p-5" aria-label="成员用量"><SectionTitle title="成员用量" note="调用与筛选费用属于当前范围；额度与本月已计属于北京时间自然月" aside={`${members.length} 位成员`} /><div className="mt-4 overflow-x-auto"><table className="data-table min-w-[960px]"><thead><tr><th>成员</th><th>调用</th><th>筛选期已计</th><th>本月已计</th><th>月度额度</th><th>剩余可用</th><th /></tr></thead><tbody>{members.map(member => <tr key={member.userId}><td><p className="font-medium text-ink">{member.displayName}</p><p className="mt-1 text-[12px] text-ink-tertiary">{member.employeeId} · {member.role === 'admin' ? '管理员' : '员工'}</p></td><td className="text-ink-secondary">{member.callCount} 次</td><td className="font-medium text-ink">{money(member.rangeChargedMinor)}</td><td className="text-ink-secondary">{money(member.monthChargedMinor)}</td><td className="text-ink-secondary">{money(member.monthlyLimitMinor)}</td><td className="text-ink-secondary">{money(member.remainingMinor)}</td><td className="text-right"><button className="cap" onClick={() => onOpen(member.userId)} aria-label={`查看${member.displayName}的用量`}>查看用量</button></td></tr>)}</tbody></table></div></section>;
}

function UsageDetails({ items, canViewTeam, title = '通道调用明细', note = '按时间倒序 · 展开查看任务、请求与错误关联' }: { items: TeamUsageAttempt[]; canViewTeam: boolean; title?: string; note?: string }) {
  return <section className="card p-5" aria-label={title}><SectionTitle title={title} note={note} aside={`${items.length} 条记录`} /><div className="mt-4 overflow-x-auto">{items.length === 0 ? <EmptyState icon="logs" title="当前范围没有服务器调用记录" description="换个日期范围后重试，本地 Agent 调用不计入这里。" /> : <table className="data-table min-w-[800px] table-fixed"><thead><tr><th className="w-[19%]">时间{canViewTeam ? ' / 成员' : ''}</th><th className="w-[24%]">模型 / 模块</th><th className="w-[16%]">结果</th><th className="num w-[17%]">费用</th><th className="w-[24%]">调用详情</th></tr></thead><tbody>{items.map(item => <tr key={item.attemptId} className="align-top"><td className="text-ink-secondary"><div className="tnum">{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>{canViewTeam && <div className="mt-1 text-[12px]">{item.actorDisplayName} · {item.employeeId}</div>}</td><td className="break-all text-ink-secondary">{item.model}<div className="mt-1 text-[12px] text-ink-tertiary">{TASK_MODULE_LABELS[item.module] ?? item.module}</div></td><td className="text-ink-secondary">{TASK_STATUS_LABELS[item.outcome ?? item.submissionState] ?? item.outcome ?? item.submissionState}</td><td className="num font-medium text-ink">{amount(item)}</td><td className="text-[12px] text-ink-tertiary"><details><summary className="cursor-pointer text-accent">查看任务与请求</summary><div className="mt-2 space-y-2 break-all"><div>任务：{item.taskId}</div><div>上游请求：{item.remoteId ?? '尚无回执'}</div><div>业务 {item.businessAttemptNo} · 提交 {item.submitRound} · 传输 {item.transportSeq}</div>{item.errorId && <Link className="text-accent" href={`/team/errors?errorId=${item.errorId}`}>查看错误</Link>}</div></details></td></tr>)}</tbody></table>}</div></section>;
}

/**
 * 费用与用量（团队版）。员工按逻辑制作任务看统一模型和任务合计；
 * 管理员可在同一任务下展开真实通道尝试。原始执行账本仍是唯一金额来源。
 */
export default function TeamUsagePanel() {
  const server = useSyncExternalStore(subscribe, isServer, serverSnapshot);
  const teamRole = useTeamRole();
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
  const showingTeam = Boolean(selectedMember) || data?.scope === 'team';
  const legacyAttemptIds = new Set((data?.legacyAttempts ?? []).map((item) => item.attemptId));
  const unifiedChannelItems = (data?.items ?? []).filter((item) => !legacyAttemptIds.has(item.attemptId));

  return <div className="min-w-0 space-y-4" aria-label="费用与用量">
    {teamRole ? <PageToolbar
      role={teamRole}
      subtitle={selectedMember && member
        ? `${member.displayName}的模型消耗与调用记录。金额为工作台记录，不代表供应商最终账单。`
        : showingTeam
          ? '团队额度、模型消耗和成员调用，一处看清。金额为工作台记录，不代表供应商最终账单。'
          : '查看个人额度、模型消耗和实际调用记录。金额为工作台记录，不代表供应商最终账单。'}
      actions={data?.canViewTeam ? <a className="cap" href={`/api/team/usage/export?${exportParams}`}>导出 CSV</a> : undefined}
    /> : null}

    {data?.canViewTeam && (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="用量统计范围"
          value={showingTeam ? 'team' : 'self'}
          onChange={(next) => changeScope(next)}
          options={[{ value: 'self', label: '仅看自己' }, { value: 'team', label: '全团队' }]}
        />
        {selectedMember && <ToolbarButton onClick={() => { setSelectedMember(null); setData(null); }}>← 返回全团队</ToolbarButton>}
      </div>
    )}

    {waiting && (
      <p className="flex items-center gap-2 rounded-[var(--radius-control)] bg-warn-tint px-3 py-2 text-[12px] text-warn" role="status">
        <StatusDot tone="warn" />{waiting}
      </p>
    )}
    {member && <QuotaCards member={member} quota={data?.teamQuota ?? null} detail={Boolean(selectedMember) || data?.scope === 'self'} />}

    <GroupList>
      <GroupRow label="账期" stacked>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="团队用量账期" size="small" value={period} onChange={selectPeriod} options={PERIODS.map(item => ({ value: item.key, label: item.label }))} />
          {period === 'custom' && <>
            <label className="text-[12px] text-ink-secondary">开始<input type="date" className="input-field mt-1" value={from} max={to} onChange={event => setFrom(event.target.value)} /></label>
            <label className="text-[12px] text-ink-secondary">结束（含）<input type="date" className="input-field mt-1" value={to} min={from} onChange={event => setTo(event.target.value)} /></label>
          </>}
        </div>
      </GroupRow>
      <GroupRow label="筛选" stacked>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 text-[12px] text-ink-secondary">模型<select className="input-field mt-1" value={model} onChange={event => setModel(event.target.value)}><option value="">全部模型</option>{data?.modelOptions.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
          <label className="text-[12px] text-ink-secondary">结果<select className="input-field mt-1" value={outcome} onChange={event => setOutcome(event.target.value)}><option value="">全部结果</option><option value="succeeded">成功</option><option value="failed">失败</option></select></label>
          <ToolbarButton icon="retry" onClick={() => setNonce(value => value + 1)}>刷新</ToolbarButton>
        </div>
      </GroupRow>
    </GroupList>

    {error && <div role="alert" className="card border-fail/25 bg-fail-tint p-4 text-[13px] text-fail"><p>{error}</p><button className="cap mt-3" onClick={() => setNonce(value => value + 1)}>重新加载</button></div>}
    {loading && !data ? <div className="card py-16 text-center text-[13px] text-ink-tertiary" role="status">读取团队用量…</div> : data && <>
      <TaskUsageTable tasks={data.tasks} canViewTeam={data.canViewTeam} />
      <ModelAnalysis models={data.models} trend={data.trend} totals={data.totals} />
      {data.canViewTeam && data.scope === 'team' && !selectedMember && <MemberTable members={data.members} onOpen={id => { setSelectedMember(id); setData(null); }} />}
      <UsageDetails items={unifiedChannelItems} canViewTeam={data.canViewTeam} title="通道调用明细" note="每次真实通道提交一条 · 自动兜底会有多条；不等于制作任务数" />
      {data.legacyAttempts.length > 0 ? <UsageDetails items={data.legacyAttempts} canViewTeam={data.canViewTeam} title="非统一模型调用" note="仍在使用的其他模型调用保留真实模型身份，不与统一模型任务混算" /> : null}
      {data.canViewTeam && data.unmappedAttempts.length > 0 ? <UsageDetails items={data.unmappedAttempts} canViewTeam={data.canViewTeam} title="待映射执行记录" note="带有统一任务关联但父任务不可用；保留原始身份并单列，不猜测归属" /> : null}
      <p className="flex flex-wrap items-center gap-2 text-[12px] leading-5 text-ink-tertiary"><Tag tone="idle">口径</Tag>{data.costNotice} 制作任务 {data.counts.generationTasks} 个，通道调用 {data.counts.channelCalls} 次，非统一模型 {data.counts.legacyAttempts} 条，待映射 {data.counts.unmappedAttempts} 条。本地 Agent 不计入；未定价与不确定费用不显示为 0，也不代表供应商最终账单。</p>
    </>}
  </div>;
}
