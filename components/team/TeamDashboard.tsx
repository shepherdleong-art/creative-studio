'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { EmptyState, GroupHeading, GroupList } from '@/components/ui/Appearance';
import { Dialog } from '@/components/ui/Dialog';
import { teamError } from './client';
import PageToolbar from './PageToolbar';
import TeamConsoleOverview from './TeamConsoleOverview';
import ResolveErrorButton from './ResolveErrorButton';
import type { EmployeeDashboard } from '@/lib/team-service/dashboard';
import { WORKSPACE_CREATE_ENTRIES, type WorkspaceRole } from '@/lib/workspace-navigation';

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(await teamError(response, '读取工作台状态失败'));
  return response.json() as Promise<T>;
}

function money(minor: number | null): string {
  return minor === null ? '不限额' : `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 按北京时间分上下午问好：问候语是工具栏标题，不需要服务器按秒刷新。 */
function greetingForNow(now = new Date()): string {
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }));
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

const STAGE_LABELS: Record<string, string> = {
  upload: '上传素材',
  remote_submit: '提交给供应商',
  remote_poll: '查询生成结果',
  download: '下载结果',
  local_media: '处理素材',
  client_update: '客户端更新',
  client_ui: '客户端界面',
  server_release: '服务器版本',
  server_config: '服务器配置',
  server_api: '服务器接口',
  storage: '服务器存储',
};

function stepPips(step: number, empty: boolean) {
  return <span className="flex items-center gap-1" aria-hidden="true">
    {[1, 2, 3, 4, 5].map((n) => (
      <i
        key={n}
        className={`block h-1 w-3 rounded-full ${n < step ? 'bg-accent' : n === step ? (empty ? 'bg-warn' : 'bg-accent') : 'bg-hairline'}`}
      />
    ))}
  </span>;
}

function SectionHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return <GroupHeading action={action}>{title}</GroupHeading>;
}

/**
 * 团队首页的**分流点**。
 *
 * - 管理员 → `TeamConsoleOverview`（运行总览，归 12 号票）。
 * - 员工 → `EmployeeWorkbench`（员工工作台，归 06 号票）。
 *
 * 用「两个组件」而不是「一个组件里按 admin 分支」，是因为两边分属不同票：分开后各自的
 * 数据请求与 JSX 互不影响，也不会出现「先 return 再调 hook」这种条件 hook 写法。
 * 员工分支的实现原样来自 06 号票，12 号票没有改动它的任何一块。
 */
export default function TeamDashboard({
  admin,
  displayName,
  canvasEnabled,
  role,
}: {
  admin: boolean;
  displayName: string;
  canvasEnabled: boolean;
  role: WorkspaceRole;
}) {
  if (admin) return <TeamConsoleOverview role={role} displayName={displayName} />;
  return <EmployeeWorkbench displayName={displayName} canvasEnabled={canvasEnabled} role={role} />;
}

/**
 * 员工首页（06 号票）。
 *
 * 五块内容：出错的任务 → 接着做（左栏）；正在生产 → 新建 → 本月用量（右栏）。
 * 数据全部来自 `/api/team/dashboard` 这个只读聚合，页面不自己算「第几步」「百分比」：
 * 那两个规则在 `lib/project-progress.ts` 与 `lib/task-progress.ts` 里，
 * 并由接口测试钉住「非渲染阶段不显示百分比」。
 */
function EmployeeWorkbench({
  displayName,
  canvasEnabled,
  role,
}: {
  displayName: string;
  canvasEnabled: boolean;
  role: WorkspaceRole;
}) {
  const [dashboard, setDashboard] = useState<EmployeeDashboard | null>(null);
  const [error, setError] = useState('');
  const [upcomingFeature, setUpcomingFeature] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      read<EmployeeDashboard>('/api/team/dashboard').then(setDashboard),
    ]);
    setError(results.some(result => result.status === 'rejected') ? '部分状态读取失败，下面保留上次成功读取的数据。请刷新重试。' : '');
  }, []);
  useEffect(() => {
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const greeting = useMemo(() => `${greetingForNow()}，${displayName}`, [displayName]);
  const runningTotal = dashboard?.running.total ?? 0;
  const productionLine = runningTotal > 0
    ? `还有 ${runningTotal} 条在生产，关掉窗口也不会停`
    : '现在没有在生产的任务，新建一个马上开始';

  return <div className="flex min-w-0 flex-col gap-4">
    <PageToolbar
      role={role}
      title={greeting}
      subtitle={<span data-testid="workbench-production-line">{productionLine}</span>}
      actions={<>
        <Link className="cap" href="/projects"><Icon name="search" size={15} />找项目</Link>
        <Link className="cap cap-primary" href="/projects/new"><Icon name="plus" size={15} />新建项目</Link>
      </>}
    />
    {error && <p role="alert" className="text-warn">{error}</p>}
    {dashboard === null && !error ? <p className="text-ink-secondary">正在读取工作台…</p> : null}
    {dashboard && <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      {/* ── 左栏：出错的任务 → 接着做 ── */}
      <div className="flex min-w-0 flex-col gap-3">
        <SectionHead
          title="出错的任务"
          action={dashboard.errors.length > 0 ? <Link href="/team/errors">全部 →</Link> : undefined}
        />
        <GroupList>
          {dashboard.errors.length === 0
            ? <div className="px-4 py-5 text-ink-secondary">
              现在没有出错的任务。<small className="mt-1 block text-ink-tertiary">任务失败时会在这里写清哪一步错了、能怎么办。</small>
            </div>
            : dashboard.errors.map((item) => <div key={item.errorId} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full bg-fail-tint text-fail"><Icon name="alert" size={15} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-ink">{STAGE_LABELS[item.stage] ?? '这一步'}出错</strong>
                  {item.scopeName && <span className="text-label text-ink-secondary">{item.scopeName}</span>}
                </div>
                <p className="mt-1 text-ink-secondary">{item.safeMessage}</p>
                <p className="mt-1 text-label leading-5 text-ink-tertiary">能怎么办：{item.actionHint}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 self-center">
                <ResolveErrorButton errorId={item.errorId} onResolved={() => {
                  setDashboard((current) => current ? { ...current, errors: current.errors.filter((entry) => entry.errorId !== item.errorId) } : current);
                  void refresh();
                }} />
                <Link className="cap" href={item.taskHref ?? `/team/errors?errorId=${encodeURIComponent(item.errorId)}`}>去看看</Link>
              </div>
            </div>)}
        </GroupList>

        <SectionHead title="接着做" action={<Link href="/projects">全部项目</Link>} />
        {dashboard.projects.length === 0
          ? <EmptyState
            icon="image"
            title="还没有项目"
            description="新建一个项目，先放一张原始场景图，就能生成场景候选。"
            action={<Link className="cap cap-primary" href="/projects/new">新建项目</Link>}
          />
          : <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {dashboard.projects.map((project) => <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="group overflow-hidden rounded-xl border border-hairline bg-card transition-colors hover:border-accent"
              data-testid="dashboard-project"
            >
              <div className="grid aspect-[4/3] place-items-center overflow-hidden bg-group text-ink-secondary">
                {project.thumbnailImageUrl
                  ? <img src={project.thumbnailImageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                  : <Icon name="image" size={26} />}
              </div>
              <div className="p-3">
                <strong className="block truncate text-ink" title={project.name}>{project.name}</strong>
                <small className="mt-1 block truncate text-label text-ink-secondary">
                  {[project.storeCode, project.productionType].filter(Boolean).join(' · ') || '未填店铺与生产类型'}
                </small>
                <div className="mt-2 flex items-center gap-2">
                  {stepPips(project.progress.step, project.progress.empty)}
                  <small className="text-label text-ink-secondary">
                    第 {project.progress.step} 步 {project.progress.label}
                  </small>
                </div>
              </div>
            </Link>)}
          </div>}
      </div>

      {/* ── 右栏：正在生产 → 新建 → 本月用量 ── */}
      <div className="flex min-w-0 flex-col gap-3">
        <SectionHead title="正在生产" action={<Link href="/team/tasks">我的任务</Link>} />
        <GroupList>
          {dashboard.running.items.length === 0
            ? <div className="px-4 py-5 text-ink-secondary">
              现在没有在生产的任务。<small className="mt-1 block text-ink-tertiary">新建项目后，这里的进度会自动更新。</small>
            </div>
            : dashboard.running.items.map((item) => <div key={item.operationId} className="px-4 py-3" data-testid="dashboard-running">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-ink" title={item.label}>{item.label}</span>
                <small className="flex-none text-label text-ink-secondary">{item.detail}</small>
              </div>
              {/* 只有真实可测的阶段（目前只有渲染）才有进度条；其余只写文字。 */}
              {item.percent !== null && <div className="mt-2 h-1 overflow-hidden rounded-full bg-track">
                <i className="block h-full rounded-full bg-accent" style={{ width: `${item.percent}%` }} />
              </div>}
            </div>)}
        </GroupList>

        <SectionHead title="新建" />
        <GroupList>
          {WORKSPACE_CREATE_ENTRIES.filter((entry) => !entry.requiresCanvas || canvasEnabled).map((entry) => {
            const className = 'flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-subtle';
            const content = <>
              <Icon name={entry.icon} size={18} className="flex-none text-accent" />
              <span className="min-w-0">
                <strong className="block text-ink">{entry.name}</strong>
                <small className="block text-label text-ink-secondary">{entry.text}</small>
              </span>
            </>;
            return entry.href
              ? <Link key={entry.name} href={entry.href} className={className}>{content}</Link>
              : <button key={entry.name} type="button" className={className} onClick={() => setUpcomingFeature(entry.name)}>{content}</button>;
          })}
        </GroupList>

        <SectionHead title="本月用量" action={<Link href="/usage">明细</Link>} />
        <GroupList>
          <div className="px-4 py-3" data-testid="dashboard-usage">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ink">已用 {money(dashboard.usage.monthChargedMinor)}</span>
              <small className="text-label text-ink-secondary">额度 {money(dashboard.usage.monthlyLimitMinor)}</small>
            </div>
            {dashboard.usage.monthlyLimitMinor !== null && dashboard.usage.monthlyLimitMinor > 0 && <div className="mt-2 h-1 overflow-hidden rounded-full bg-track">
              <i
                className={`block h-full rounded-full ${dashboard.usage.monthChargedMinor >= dashboard.usage.monthlyLimitMinor ? 'bg-fail' : 'bg-accent'}`}
                style={{ width: `${Math.min(100, Math.round(dashboard.usage.monthChargedMinor / dashboard.usage.monthlyLimitMinor * 100))}%` }}
              />
            </div>}
            <small className="mt-2 block text-label text-ink-tertiary">
              {dashboard.usage.monthlyLimitMinor === null
                ? '本月不限额；金额为工作台记录，不代表供应商最终账单。'
                : `剩余 ${money(dashboard.usage.remainingMinor)}；这里只读，额度由管理员设置。`}
            </small>
          </div>
        </GroupList>
      </div>
    </div>}
    <Dialog
      open={upcomingFeature !== null}
      title={upcomingFeature ?? ''}
      description="功能开发中，敬请期待"
      onClose={() => setUpcomingFeature(null)}
      footer={<button type="button" className="cap cap-primary" onClick={() => setUpcomingFeature(null)}>知道了</button>}
    />
  </div>;
}
