'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import { addUsageDays, usagePresetRange, type UsageDatePreset } from '@/lib/usage-date-range';
import { CONCURRENCY_SOURCE_LABELS, TASK_MODULE_LABELS, WAITING_REASON_LABELS } from '@/lib/team-task-labels';
import type {
  TeamMemberSummary,
  TeamModelUsage,
  TeamUsageAttempt,
  TeamUsageMember,
  TeamUsageSummary,
  TeamUsageTrendPoint,
} from '@/lib/team-service/usage';
import type { TeamUnifiedTaskView } from '@/lib/team-service/unified-usage';
import { DEFAULT_TEAM_PAGE_SIZE, type TeamPageSize, type TeamPagination } from '@/lib/team-service/pagination';
import { isAdminOnlyUsageSection, type TeamUsageSection } from '@/lib/team-service/usage-sections';
import PageToolbar from './PageToolbar';
import { useTeamRole } from './useTeamRole';
import { EmptyState, GroupList, GroupRow, Segmented, StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';
import { Pagination, type PaginationChange } from '@/components/ui/Pagination';
import { AttemptUsageDetailDialog, TaskUsageDetailDialog } from './usage-detail-dialog';
import { attemptCostLabel, attemptResultLabel, taskCostLabel, usageMoney, usageTaskStatusLabel } from './usage-display';

type Period = UsageDatePreset | 'custom';
type DetailTab = 'tasks' | 'channels' | 'other';
type OtherKind = 'legacy' | 'unmapped';
type AttemptSection = 'channels' | 'legacy' | 'unmapped';

/** `section=summary` 的完整摘要（04 合同第 2.1 节）+ 路线补充的公共字段。 */
type UsageSummaryResponse = TeamUsageSummary & {
  section: 'summary';
  range: { from: string; to: string };
  scope: 'self' | 'team';
  canViewTeam: boolean;
  policy: { accountStatus: string; waitingReason: string | null };
  member: TeamMemberSummary;
};

/** 四个明细 section 的统一响应形状（`items` 按 section 区分，见合同 2.2–2.5）。 */
type UsageListResponse = {
  section: TeamUsageSection;
  items: TeamUnifiedTaskView[] | TeamUsageAttempt[];
  pagination: TeamPagination;
  range: { from: string; to: string };
  scope: 'self' | 'team';
  canViewTeam: boolean;
};

type DetailState =
  | { kind: 'task'; task: TeamUnifiedTaskView }
  | { kind: 'attempt'; item: TeamUsageAttempt; section: AttemptSection }
  | null;

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
const DETAIL_NOTES: Record<TeamUsageSection, { title: string; note: string; emptyTitle: string; emptyDescription: string }> = {
  summary: { title: '用量明细', note: '', emptyTitle: '暂无记录', emptyDescription: '' },
  tasks: {
    title: '制作任务',
    note: '一条统一模型制作任务一行；自动兜底仍是一条制作任务，真实通道调用计入「通道调用」。',
    emptyTitle: '当前范围没有统一模型制作任务',
    emptyDescription: '换个日期范围或清空模型筛选；旧的非统一模型调用在「其他记录」里单列。',
  },
  channels: {
    title: '通道调用',
    note: '每次真实通道提交一条 · 自动兜底会产生多条；不等于制作任务数。',
    emptyTitle: '当前范围没有已关联制作任务的通道调用',
    emptyDescription: '换个日期范围或清空筛选后重试。',
  },
  legacy: {
    title: '其他记录',
    note: '非统一模型记录：保留真实模型身份，不与统一模型任务混算。',
    emptyTitle: '当前范围没有非统一模型记录',
    emptyDescription: '换个日期范围或清空筛选后重试。',
  },
  unmapped: {
    title: '其他记录',
    note: '待映射记录：带有统一任务关联但父任务不可用；保留原始身份并单列，不猜测归属。',
    emptyTitle: '当前范围没有待映射记录',
    emptyDescription: '换个日期范围或清空筛选后重试。',
  },
};

/**
 * 明细分区：员工永远不会落到管理员专用 section（服务端对 channels/unmapped 直接 403）。
 * 页签（tab）→ section 的映射只在这里，切换时回第 1 页。
 */
function resolveSection(tab: DetailTab, otherKind: OtherKind, admin: boolean): TeamUsageSection {
  if (tab === 'tasks') return 'tasks';
  if (tab === 'channels') return admin ? 'channels' : 'tasks';
  const wanted: TeamUsageSection = otherKind === 'unmapped' ? 'unmapped' : 'legacy';
  if (!admin && isAdminOnlyUsageSection(wanted)) return 'legacy';
  return wanted;
}

/** 摘要与明细共用的业务筛选（不含 section/page/pageSize）。 */
function businessUsageParams(input: {
  period: Period; from: string; to: string; model: string; outcome: string;
  scope: 'self' | 'team'; selectedMember: string | null;
}): URLSearchParams {
  const params = new URLSearchParams({ period: input.period, scope: input.scope });
  if (input.period === 'custom') {
    if (input.from) params.set('from', input.from);
    if (input.to) params.set('to', addUsageDays(input.to, 1));
  }
  if (input.model) params.set('model', input.model);
  if (input.outcome) params.set('outcome', input.outcome);
  if (input.selectedMember) {
    params.set('scope', 'team');
    params.set('actorUserId', input.selectedMember);
  }
  return params;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** 区块标题（原型 `.h4` + 说明）：右侧留一块给范围摘要。 */
function SectionTitle({ title, note, aside }: { title: string; note: string; aside?: string }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div><h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2><p className="mt-1 text-[12px] leading-5 text-ink-tertiary">{note}</p></div>
    {aside && <span className="tnum text-[12px] text-ink-tertiary">{aside}</span>}
  </div>;
}

function QuotaCards({ member, quota, detail }: { member: TeamMemberSummary; quota: TeamUsageSummary['teamQuota']; detail: boolean }) {
  const cards = quota && !detail ? [
    ['本月团队已计', usageMoney(quota.chargedMinor), `已结算 ${usageMoney(quota.settledMinor)}`],
    ['有限额度合计', usageMoney(quota.limitedTotalMinor), `${quota.limitedCount} 位有限额度成员`],
    ['有限额度剩余', usageMoney(quota.limitedRemainingMinor), `另有 ${quota.unlimitedCount} 位不限额`],
    ['待结算预留', usageMoney(quota.heldMinor), '已包含在本月已计'],
  ] : [
    ['本月已计 / 额度', `${usageMoney(member.monthChargedMinor)} / ${usageMoney(member.monthlyLimitMinor)}`, `已结算 ${usageMoney(member.monthSettledMinor)}`],
    ['待结算预留', usageMoney(member.heldMinor), '已包含在本月已计'],
    ['剩余可用', usageMoney(member.remainingMinor), '含预留后的可用金额'],
    ['当前并发 / 上限', `${member.currentConcurrency} / ${member.concurrencyLimit ?? '自动'}`, `今日已计 ${usageMoney(member.todayChargedMinor)}`],
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
        {[0, 0.5, 1].map(ratio => <g key={ratio}>
          <line x1={padding.left} x2={width - padding.right} y1={padding.top + plotHeight * ratio} y2={padding.top + plotHeight * ratio} stroke="var(--color-hairline)" />
          <text x={padding.left - 12} y={padding.top + plotHeight * ratio + 4} textAnchor="end" className="fill-ink-tertiary text-[12px]">{usageMoney(Math.round(maximum * (1 - ratio)))}</text>
        </g>)}
        {trend.map((point, index) => {
          const show = trend.length <= 8 || index === 0 || index === trend.length - 1 || index % Math.ceil(trend.length / 6) === 0;
          return show ? <text key={point.date} x={xFor(index)} y={height - 12} textAnchor={index === 0 ? 'start' : index === trend.length - 1 ? 'end' : 'middle'} className="fill-ink-tertiary text-[12px]">{point.date.slice(5)}</text> : null;
        })}
        {activeModels.map(model => <polyline key={model.model} fill="none" stroke={color(model.model)} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity={inspected && inspected.model !== model.model ? 0.3 : 1} points={trend.map((point, index) => `${xFor(index)},${yFor(point.byModel[model.model] ?? 0)}`).join(' ')} />)}
        {inspected && trend[inspected.index] && <g pointerEvents="none">
          <line x1={xFor(inspected.index)} x2={xFor(inspected.index)} y1={padding.top} y2={padding.top + plotHeight} stroke="var(--color-ink-tertiary)" strokeDasharray="4 4" />
          <circle cx={xFor(inspected.index)} cy={yFor(trend[inspected.index].byModel[inspected.model] ?? 0)} r="5" fill={color(inspected.model)} stroke="var(--color-surface)" strokeWidth="2" />
        </g>}
        {!activeModels.length && <text x={width / 2} y={height / 2} textAnchor="middle" className="fill-ink-tertiary text-sm">当前范围暂无已知费用记录</text>}
      </svg>
    </div>
    {inspected && trend[inspected.index] && <div role="tooltip" className="pointer-events-none absolute top-3 z-10 rounded-[11px] border border-hairline bg-surface px-4 py-3 text-[12px] shadow-lg" style={inspected.index < trend.length / 2 ? { right: 16 } : { left: 16 }}>
      <p className="text-ink-tertiary">{trend[inspected.index].date}</p>
      <p className="mt-1 max-w-64 break-all font-medium text-ink">{inspected.model}</p>
      <p className="tnum mt-1 font-semibold text-ink">{usageMoney(trend[inspected.index].byModel[inspected.model] ?? 0)}</p>
    </div>}
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-ink-secondary">{models.map(model => <button
      type="button"
      key={model.model}
      className="inline-flex max-w-full items-center gap-2 text-left"
      onFocus={() => setInspected({ index: Math.max(0, trend.length - 1), model: model.model })}
      onBlur={() => setInspected(null)}
      onKeyDown={event => {
        if (event.key === 'Escape') setInspected(null);
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        setInspected(current => ({ model: model.model, index: Math.max(0, Math.min(trend.length - 1, (current?.index ?? trend.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1))) }));
      }}
    ><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color(model.model) }} /><span className="break-all">{model.model}</span></button>)}</div>
  </div>;
}

function ModelAnalysis({ models, trend, totals, counts }: {
  models: TeamModelUsage[];
  trend: TeamUsageTrendPoint[];
  totals: TeamUsageSummary['totals'];
  counts: TeamUsageSummary['counts'];
}) {
  const total = models.reduce((sum, model) => sum + model.chargedMinor, 0);
  return <section className="card p-5" aria-label="模型消耗排行与趋势">
    <SectionTitle
      title="模型消耗排行与趋势"
      note="按统一模型汇总制作任务；通道调用次数与制作任务数分开统计。已计含已记录、估算与待核账费用"
      aside={`${counts.generationTasks} 个制作任务 · ${counts.channelCalls} 次通道调用 · ${usageMoney(total)}`}
    />
    <div className="mt-4 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,1fr)] xl:items-start">
      <div className="min-w-0"><h3 className="mb-3 text-[13px] font-medium text-ink">每日模型费用</h3><TrendChart trend={trend} models={models} /></div>
      <div className="min-w-0">
        <h3 className="mb-3 text-[13px] font-medium text-ink">模型费用统计</h3>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[560px]">
            <thead><tr><th>模型 / 模块</th><th>制作任务</th><th>通道调用</th><th className="num">已计费用</th><th className="num">占比</th></tr></thead>
            <tbody>{models.map(model => <tr key={model.model} className="align-top">
              <td className="max-w-56"><p className="break-all font-medium text-ink">{model.model}</p><p className="mt-1 text-[12px] text-ink-tertiary">{model.modules.map(module => TASK_MODULE_LABELS[module] ?? module).join('、')}</p></td>
              <td className="whitespace-nowrap text-ink-secondary">{model.taskCount} 个</td>
              <td className="whitespace-nowrap text-ink-secondary">{model.callCount} 次</td>
              <td className="num whitespace-nowrap font-medium text-ink">{usageMoney(model.chargedMinor)}</td>
              <td className="num"><span className="text-[12px] text-ink-secondary">{model.percentage.toFixed(1)}%</span><span className="ml-auto mt-2 block h-1.5 w-20 overflow-hidden rounded-full" style={{ background: 'var(--color-track)' }}><span className="block h-full rounded-full" style={{ width: `${Math.min(100, model.percentage)}%`, background: 'var(--color-accent)' }} /></span></td>
            </tr>)}</tbody>
          </table>
          {models.length === 0 && <EmptyState icon="table" title="当前范围暂无模型调用" description="换个日期范围或清空模型筛选再试。" />}
        </div>
        <p className="mt-3 text-[12px] leading-5 text-ink-tertiary">未定价 {totals.unpricedCount} 次 · 不确定 {totals.uncertainCount} 次，不显示为零元。制作任务数不是通道调用次数。</p>
      </div>
    </div>
  </section>;
}

function MemberTable({ members, onOpen }: { members: TeamUsageMember[]; onOpen: (id: string) => void }) {
  return <section className="card p-5" aria-label="成员用量">
    <SectionTitle title="成员用量" note="调用与筛选费用属于当前范围；额度与本月已计属于北京时间自然月" aside={`${members.length} 位成员`} />
    <div className="mt-4 overflow-x-auto">
      <table className="data-table min-w-[960px]">
        <thead><tr><th>成员</th><th>调用</th><th>筛选期已计</th><th>本月已计</th><th>月度额度</th><th>剩余可用</th><th /></tr></thead>
        <tbody>{members.map(member => <tr key={member.userId}>
          <td><p className="font-medium text-ink">{member.displayName}</p><p className="mt-1 text-[12px] text-ink-tertiary">{member.employeeId} · {member.role === 'admin' ? '管理员' : '员工'}</p></td>
          <td className="text-ink-secondary">{member.callCount} 次</td>
          <td className="font-medium text-ink">{usageMoney(member.rangeChargedMinor)}</td>
          <td className="text-ink-secondary">{usageMoney(member.monthChargedMinor)}</td>
          <td className="text-ink-secondary">{usageMoney(member.monthlyLimitMinor)}</td>
          <td className="text-ink-secondary">{usageMoney(member.remainingMinor)}</td>
          <td className="text-right"><button type="button" className="cap" onClick={() => onOpen(member.userId)} aria-label={`查看${member.displayName}的用量`}>查看用量</button></td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

/** 制作任务表：只放短字段，长内容（远端 ID、长项目名、长错误）一律进详情对话框。 */
function TaskUsageTable({ tasks, canViewTeam, onOpenDetail }: {
  tasks: TeamUnifiedTaskView[];
  canViewTeam: boolean;
  onOpenDetail: (task: TeamUnifiedTaskView, trigger: HTMLButtonElement) => void;
}) {
  return <div className="overflow-x-auto">
    <table className="data-table w-full min-w-[720px] table-fixed">
      <thead><tr>
        <th className="w-[17%]">时间{canViewTeam ? ' / 成员' : ''}</th>
        <th className="w-[25%]">模型 / 来源</th>
        <th className="w-[13%]">状态</th>
        <th className="w-[15%]">调用摘要</th>
        <th className="num w-[15%]">费用</th>
        <th className="w-[15%]">详情</th>
      </tr></thead>
      <tbody>{tasks.map(task => <tr key={task.mediaTaskId} className="align-top" data-testid="usage-task-row" data-media-task-id={task.mediaTaskId}>
        <td className="text-ink-secondary">
          <div className="tnum whitespace-nowrap">{formatTime(task.createdAt)}</div>
          {canViewTeam ? <div className="mt-1 truncate text-[12px]" title={`${task.actorDisplayName} · ${task.employeeId}`}>{task.actorDisplayName} · {task.employeeId}</div> : null}
        </td>
        <td className="min-w-0 text-ink-secondary">
          <p className="truncate font-medium text-ink" title={task.model}>{task.model}</p>
          <p className="mt-1 truncate text-[12px] text-ink-tertiary" title={`${TASK_MODULE_LABELS[task.module] ?? task.module} · ${task.scopeName}`}>
            {TASK_MODULE_LABELS[task.module] ?? task.module} · {task.scopeName}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-ink-tertiary">{SOURCE_LABELS[task.sourceType] ?? task.sourceType} · 规则 {task.ruleVersion}</p>
        </td>
        <td className="text-ink-secondary">{usageTaskStatusLabel(task)}
          {task.cancelRequestedAt ? <p className="mt-1 text-[11px] text-warn">已保留取消前已提交结果与费用</p> : null}
        </td>
        <td className="text-ink-secondary">
          <span className="tnum">{task.channelCallCount}</span> 次通道调用
          {canViewTeam ? <p className="mt-1 text-[12px] text-ink-tertiary">已提交 {task.submissionCount} · 通道 {task.usedChannelCount}</p> : null}
        </td>
        <td className="num whitespace-nowrap font-medium text-ink">{taskCostLabel(task)}
          {task.costStatus === 'mixed' ? <p className="mt-1 text-[11px] font-normal text-warn">含待核账或未定价</p> : null}
        </td>
        <td><button
          type="button"
          className="cap"
          data-testid="usage-detail-open"
          onClick={(event) => onOpenDetail(task, event.currentTarget)}
        >查看详情</button></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

/** 通道调用 / 非统一模型 / 待映射：每 attempt 一条。 */
function AttemptUsageTable({ items, canViewTeam, onOpenDetail }: {
  items: TeamUsageAttempt[];
  canViewTeam: boolean;
  onOpenDetail: (item: TeamUsageAttempt, trigger: HTMLButtonElement) => void;
}) {
  return <div className="overflow-x-auto">
    <table className="data-table w-full min-w-[680px] table-fixed">
      <thead><tr>
        <th className="w-[20%]">时间{canViewTeam ? ' / 成员' : ''}</th>
        <th className="w-[26%]">模型 / 模块</th>
        <th className="w-[16%]">结果</th>
        <th className="num w-[18%]">费用</th>
        <th className="w-[20%]">详情</th>
      </tr></thead>
      <tbody>{items.map(item => <tr key={item.attemptId} className="align-top" data-testid="usage-attempt-row" data-attempt-id={item.attemptId}>
        <td className="text-ink-secondary">
          <div className="tnum whitespace-nowrap">{formatTime(item.createdAt)}</div>
          {canViewTeam ? <div className="mt-1 truncate text-[12px]" title={`${item.actorDisplayName} · ${item.employeeId}`}>{item.actorDisplayName} · {item.employeeId}</div> : null}
        </td>
        <td className="min-w-0 text-ink-secondary">
          <p className="truncate font-medium text-ink" title={item.reportingModel || item.model}>{item.reportingModel || item.model}</p>
          <p className="mt-1 truncate text-[12px] text-ink-tertiary">{TASK_MODULE_LABELS[item.module] ?? item.module}</p>
        </td>
        <td className="text-ink-secondary">{attemptResultLabel(item)}</td>
        <td className="num whitespace-nowrap font-medium text-ink">{attemptCostLabel(item)}</td>
        <td><button
          type="button"
          className="cap"
          data-testid="usage-detail-open"
          onClick={(event) => onOpenDetail(item, event.currentTarget)}
        >查看详情</button></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

/**
 * 费用与用量（团队版）。布局顺序固定：额度卡 → 账期与筛选 → 模型消耗排行与趋势
 * （图表固定在所有明细之前）→ 成员统计 → 明细页签。
 *
 * 摘要（`section=summary`）与当前页签明细各自请求、各自 loading/error；翻页只请求
 * 指定 section 的指定页，不会下载全部列表，也不会清空图表或金额。
 */
export default function TeamUsagePanel() {
  const server = useSyncExternalStore(subscribe, isServer, serverSnapshot);
  const teamRole = useTeamRole();

  const [period, setPeriod] = useState<Period>('month');
  const initial = useMemo(() => usagePresetRange('month'), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [model, setModel] = useState('');
  const [outcome, setOutcome] = useState('');
  const [scope, setScope] = useState<'self' | 'team'>('self');
  const [selectedMember, setSelectedMember] = useState<string | null>(null);

  const [tab, setTab] = useState<DetailTab>('tasks');
  const [otherKind, setOtherKind] = useState<OtherKind>('legacy');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<TeamPageSize>(DEFAULT_TEAM_PAGE_SIZE);

  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState('');
  const [summaryNonce, setSummaryNonce] = useState(0);

  const [list, setList] = useState<UsageListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listNonce, setListNonce] = useState(0);

  const [detail, setDetail] = useState<DetailState>(null);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);

  const canViewTeam = summary?.canViewTeam ?? false;
  const section = resolveSection(tab, otherKind, canViewTeam);

  // ── 摘要：业务筛选变化时重新请求；翻页/切 section 不会碰它 ─────────────────
  useEffect(() => {
    if (!server) return;
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setSummaryLoading(true);
      setSummaryError('');
    });
    const params = businessUsageParams({ period, from, to, model, outcome, scope, selectedMember });
    fetch(`/api/team/usage?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as UsageSummaryResponse & { message?: string };
        if (!response.ok) throw new Error(body.message ?? '用量汇总读取失败');
        if (!active) return;
        setSummary(body);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setSummaryError(cause instanceof Error ? cause.message : '用量汇总读取失败');
      })
      .finally(() => { if (active) setSummaryLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [server, period, from, to, model, outcome, scope, selectedMember, summaryNonce]);

  // ── 明细：只请求当前页签对应的 section 的当前页 ────────────────────────────
  useEffect(() => {
    if (!server) return;
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setListLoading(true);
      setListError('');
    });
    const params = businessUsageParams({ period, from, to, model, outcome, scope, selectedMember });
    params.set('section', section);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    fetch(`/api/team/usage?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as UsageListResponse & { message?: string };
        if (!response.ok) throw new Error(body.message ?? '用量明细读取失败');
        if (!active) return;
        setList(body);
        // 越界页由服务端归到有效末页并返回实际 page；这里只同步一次状态，不循环重请求。
        if (body.pagination.page !== page) setPage(body.pagination.page);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setListError(cause instanceof Error ? cause.message : '用量明细读取失败');
      })
      .finally(() => { if (active) setListLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [server, period, from, to, model, outcome, scope, selectedMember, section, page, pageSize, listNonce]);

  const member = summary?.member;
  const waiting = member?.waitingReason ? WAITING_LABELS[member.waitingReason] ?? member.waitingReason : null;
  const showingTeam = Boolean(selectedMember) || summary?.scope === 'team';
  const exportParams = businessUsageParams({ period, from, to, model, outcome, scope, selectedMember });

  const selectPeriod = (next: Period) => {
    setPeriod(next);
    if (next !== 'custom') {
      const range = usagePresetRange(next);
      setFrom(range.from);
      setTo(range.to);
    }
    setPage(1);
  };
  const changeScope = (next: 'self' | 'team') => { setScope(next); setSelectedMember(null); setPage(1); };
  const openMember = (id: string) => { setSelectedMember(id); setPage(1); };
  const backToTeam = () => { setSelectedMember(null); setPage(1); };
  const changeTab = (next: DetailTab) => { setTab(next); setPage(1); };
  const changeOtherKind = (next: OtherKind) => { setOtherKind(next); setPage(1); };
  const changePage = (next: PaginationChange) => {
    if (next.pageSize !== pageSize) { setPageSize(next.pageSize); setPage(1); return; }
    setPage(next.page);
  };
  // 手动刷新保留当前有效页；越界时由响应 pagination.page 收敛。
  const refresh = () => { setSummaryNonce(value => value + 1); setListNonce(value => value + 1); };

  const openTaskDetail = (task: TeamUnifiedTaskView, trigger: HTMLButtonElement) => {
    detailTrigger.current = trigger;
    setDetail({ kind: 'task', task });
  };
  const openAttemptDetail = (item: TeamUsageAttempt, trigger: HTMLButtonElement) => {
    detailTrigger.current = trigger;
    setDetail({ kind: 'attempt', item, section: section as AttemptSection });
  };
  const closeDetail = useCallback(() => {
    setDetail(null);
    const trigger = detailTrigger.current;
    detailTrigger.current = null;
    // 归还焦点：Dialog 关闭后把焦点放回触发「查看详情」的按钮。
    if (trigger) requestAnimationFrame(() => trigger.focus());
  }, []);

  if (!server) return null;

  const detailInfo = DETAIL_NOTES[section];
  // 当前 list 数据必须属于当前 section：切页签时旧数据还在 state 里，
  // 不能把制作任务当调用记录渲染（会短暂出现错误的行与总数）。
  const readyList = list && list.section === section ? list : null;
  const listTotalPages = readyList ? readyList.pagination.totalPages : 1;
  const listPage = readyList ? readyList.pagination.page : page;
  const listTotal = readyList ? readyList.pagination.total : 0;
  const fullRangeCount = tab === 'tasks'
    ? summary?.counts.generationTasks
    : tab === 'channels'
      ? summary?.counts.channelCalls
      : otherKind === 'unmapped' && canViewTeam
        ? summary?.counts.unmappedAttempts
        : summary?.counts.legacyAttempts;
  const unit = tab === 'tasks' ? '个制作任务' : '条记录';

  return <div className="min-w-0 space-y-4" aria-label="费用与用量">
    {teamRole ? <PageToolbar
      role={teamRole}
      subtitle={selectedMember && member
        ? `${member.displayName}的模型消耗与调用记录。金额为工作台记录，不代表供应商最终账单。`
        : showingTeam
          ? '团队额度、模型消耗和成员调用，一处看清。金额为工作台记录，不代表供应商最终账单。'
          : '查看个人额度、模型消耗和实际调用记录。金额为工作台记录，不代表供应商最终账单。'}
      actions={summary?.canViewTeam ? <a className="cap" data-testid="usage-export" href={`/api/team/usage/export?${exportParams}`}>导出 CSV</a> : undefined}
    /> : null}

    {waiting && (
      <p className="flex items-center gap-2 rounded-[var(--radius-control)] bg-warn-tint px-3 py-2 text-[12px] text-warn" role="status">
        <StatusDot tone="warn" />{waiting}
      </p>
    )}

    {member
      ? <QuotaCards member={member} quota={summary?.teamQuota ?? null} detail={Boolean(selectedMember) || summary?.scope === 'self'} />
      : summaryLoading && !summaryError
        ? <div className="card py-10 text-center text-[13px] text-ink-tertiary" role="status">读取额度与汇总…</div>
        : null}

    {summaryError && <div role="alert" className="card border-fail/25 bg-fail-tint p-4 text-[13px] text-fail" data-testid="usage-summary-error">
      <p>{summaryError}</p>
      <button type="button" className="cap mt-3" onClick={() => setSummaryNonce(value => value + 1)}>重新读取汇总</button>
    </div>}

    <GroupList>
      <GroupRow label="账期" stacked>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="团队用量账期" size="small" value={period} onChange={selectPeriod} options={PERIODS.map(item => ({ value: item.key, label: item.label }))} />
          {period === 'custom' && <>
            <label className="text-[12px] text-ink-secondary">开始<input type="date" className="input-field mt-1" value={from} max={to} onChange={event => { setFrom(event.target.value); setPage(1); }} /></label>
            <label className="text-[12px] text-ink-secondary">结束（含）<input type="date" className="input-field mt-1" value={to} min={from} onChange={event => { setTo(event.target.value); setPage(1); }} /></label>
          </>}
        </div>
      </GroupRow>
      {canViewTeam && <GroupRow label="范围" stacked>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="用量统计范围"
            size="small"
            value={showingTeam ? 'team' : 'self'}
            onChange={(next) => changeScope(next)}
            options={[{ value: 'self', label: '仅看自己' }, { value: 'team', label: '全团队' }]}
          />
          {selectedMember && <ToolbarButton onClick={backToTeam}>← 返回全团队</ToolbarButton>}
        </div>
      </GroupRow>}
      <GroupRow label="筛选" stacked>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 text-[12px] text-ink-secondary">模型
            <select className="input-field mt-1" aria-label="模型筛选" value={model} onChange={event => { setModel(event.target.value); setPage(1); }}>
              <option value="">全部模型</option>
              {summary?.modelOptions.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="text-[12px] text-ink-secondary">结果
            <select className="input-field mt-1" aria-label="结果筛选" value={outcome} onChange={event => { setOutcome(event.target.value); setPage(1); }}>
              <option value="">全部结果</option>
              <option value="succeeded">成功</option>
              <option value="failed">失败</option>
            </select>
          </label>
          <ToolbarButton icon="retry" onClick={refresh}>刷新</ToolbarButton>
        </div>
      </GroupRow>
    </GroupList>

    {summary && <ModelAnalysis models={summary.models} trend={summary.trend} totals={summary.totals} counts={summary.counts} />}
    {summary && canViewTeam && summary.scope === 'team' && !selectedMember
      && <MemberTable members={summary.members} onOpen={openMember} />}

    <section className="card p-5" aria-label="用量明细">
      <SectionTitle title="用量明细" note="页签之间互斥：任意时刻只加载并呈现一个明细列表，隐藏页签不预加载全量数据。" aside={`${readyList ? listTotal : fullRangeCount ?? '—'} ${unit}`} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="用量明细分类"
          value={tab}
          onChange={changeTab}
          options={canViewTeam
            ? [{ value: 'tasks' as DetailTab, label: '制作任务' }, { value: 'channels' as DetailTab, label: '通道调用' }, { value: 'other' as DetailTab, label: '其他记录' }]
            : [{ value: 'tasks' as DetailTab, label: '制作任务' }, { value: 'other' as DetailTab, label: '其他记录' }]}
        />
        {tab === 'other' && (canViewTeam
          ? <Segmented
            label="其他记录类型"
            size="small"
            semantics="toggle"
            value={otherKind}
            onChange={changeOtherKind}
            options={[{ value: 'legacy' as OtherKind, label: '非统一模型记录' }, { value: 'unmapped' as OtherKind, label: '待映射记录' }]}
          />
          : <span className="text-[12px] text-ink-tertiary">非统一模型记录</span>)}
      </div>

      {listError
        ? <div role="alert" className="mt-4 rounded-[var(--radius-control)] border border-fail/25 bg-fail-tint p-4 text-[13px] text-fail" data-testid="usage-list-error">
          <p>{listError}</p>
          <button type="button" className="cap mt-3" onClick={() => setListNonce(value => value + 1)}>重试读取明细</button>
        </div>
        : <>
          <div className="mt-2" data-testid="usage-detail-list" data-section={section} aria-busy={listLoading || undefined}>
            {!readyList
              ? <div className="py-12 text-center text-[13px] text-ink-tertiary" role="status">读取用量明细…</div>
              : Array.isArray(readyList.items) && readyList.items.length === 0
                ? <EmptyState icon="logs" title={detailInfo.emptyTitle} description={detailInfo.emptyDescription} />
                : section === 'tasks'
                  ? <TaskUsageTable tasks={readyList.items as TeamUnifiedTaskView[]} canViewTeam={canViewTeam} onOpenDetail={openTaskDetail} />
                  : <AttemptUsageTable items={readyList.items as TeamUsageAttempt[]} canViewTeam={canViewTeam} onOpenDetail={openAttemptDetail} />}
          </div>
          {readyList ? <div className="mt-3 border-t border-hairline pt-2">
            <Pagination
              label={detailInfo.title}
              unit={unit}
              page={listPage}
              pageSize={pageSize}
              total={listTotal}
              totalPages={listTotalPages}
              loading={listLoading}
              onChange={changePage}
            />
          </div> : null}
        </>}
    </section>

    {summary && <p className="flex flex-wrap items-center gap-2 text-[12px] leading-5 text-ink-tertiary">
      <Tag tone="idle">口径</Tag>
      {summary.costNotice} 制作任务 {summary.counts.generationTasks} 个，通道调用 {summary.counts.channelCalls} 次，非统一模型 {summary.counts.legacyAttempts} 条，待映射 {summary.counts.unmappedAttempts} 条。本地 Agent 不计入；未定价与不确定费用不显示为 0，也不代表供应商最终账单。
    </p>}

    <TaskUsageDetailDialog
      open={detail?.kind === 'task'}
      task={detail?.kind === 'task' ? detail.task : null}
      canViewTeam={canViewTeam}
      onClose={closeDetail}
    />
    <AttemptUsageDetailDialog
      open={detail?.kind === 'attempt'}
      item={detail?.kind === 'attempt' ? detail.item : null}
      section={detail?.kind === 'attempt' ? detail.section : 'channels'}
      onClose={closeDetail}
    />
  </div>;
}
