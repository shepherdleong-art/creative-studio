'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/ui/Icon';
import { EmptyState, GroupHeading, GroupList, ToolbarButton } from '@/components/ui/Appearance';
import { teamError } from './client';
import PageToolbar from './PageToolbar';
import TeamProductionControl from './TeamProductionControl';
import TeamTaskModel, { type TeamTaskModelCall } from './TeamTaskModel';
import { TASK_STATUS_LABELS } from '@/lib/team-task-labels';
import type { EmployeeDashboard } from '@/lib/team-service/dashboard';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

type Task = { operationId: string; taskName: string; stepName: string; scopeName: string; scope: { resourceType: string; resourceId: string }; status: string; actorDisplayName: string; model: string | null; providerName: string; modelStatus: string; modelCalls: TeamTaskModelCall[] };
type Project = { id: string; name: string; thumbnailImageUrl?: string; totalJobs: number; completedJobs: number };
type Pools = { ready: boolean; blockers: string[]; pools: Array<{ poolKey: string; capacity: number; enabled: boolean }> };
type Runtime = { proxyAvailable: boolean; cosConfigured: boolean };
const taskLabels = TASK_STATUS_LABELS;

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
 * 员工首页（06 号票）。
 *
 * 五块内容：出错的任务 → 接着做（左栏）；正在生产 → 新建 → 本月用量（右栏）。
 * 数据全部来自 `/api/team/dashboard` 这个只读聚合，页面不自己算「第几步」「百分比」：
 * 那两个规则在 `lib/project-progress.ts` 与 `lib/task-progress.ts` 里，
 * 并由接口测试钉住「非渲染阶段不显示百分比」。
 *
 * 管理员分支（运行总览）归 12 号票，这里原样保留。
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
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pools, setPools] = useState<Pools | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [dashboard, setDashboard] = useState<EmployeeDashboard | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    const results = await Promise.allSettled([
      ...(admin
        ? [
            read<{ items: Task[] }>('/api/team/tasks').then(data => setTasks(data.items)),
            read<Project[]>('/api/projects').then(setProjects),
            read<Pools>('/api/team/pools').then(setPools),
            read<Runtime>('/api/company-provider/health').then(setRuntime),
          ]
        : [read<EmployeeDashboard>('/api/team/dashboard').then(setDashboard)]),
    ]);
    setError(results.some(result => result.status === 'rejected') ? '部分状态读取失败，下面保留上次成功读取的数据。请刷新重试。' : '');
    setBusy(false);
  }, [admin]);
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

  if (admin) {
    return <AdminDashboard
      busy={busy} error={error} pools={pools} projects={projects}
      refresh={refresh} runtime={runtime} tasks={tasks} role={role} displayName={displayName}
    />;
  }

  return <div className="flex min-w-0 flex-col gap-4">
    <PageToolbar
      role={role}
      title={greeting}
      subtitle={productionLine}
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
              <Link className="cap self-center" href={item.taskHref ?? '/team/errors'}>去看看</Link>
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
          {[
            { name: '常规项目', text: '场景、分镜到成片', icon: 'film' as IconName, href: '/projects/new' },
            { name: '批量生产', text: '进入项目开展批量制作', icon: 'grid' as IconName, href: '/projects' },
            { name: '详情页脚本', text: '进入项目编写产品文案', icon: 'text' as IconName, href: '/projects' },
            ...(canvasEnabled ? [{ name: '创作画布', text: '连接灵感与生成流程', icon: 'sparkle' as IconName, href: '/canvas' }] : []),
          ].map((entry) => <Link key={entry.name} href={entry.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-subtle">
            <Icon name={entry.icon} size={18} className="flex-none text-accent" />
            <span className="min-w-0">
              <strong className="block text-ink">{entry.name}</strong>
              <small className="block text-label text-ink-secondary">{entry.text}</small>
            </span>
          </Link>)}
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
  </div>;
}

/**
 * 管理员首页（运行总览）——**12 号票重做这一块**。
 * 06 号票只保证员工分支改版时不动它：这里保留原有的统计卡、全员任务与资源块。
 */
function AdminDashboard({
  busy, displayName, error, pools, projects, refresh, role, runtime, tasks,
}: {
  busy: boolean;
  displayName: string;
  error: string;
  pools: Pools | null;
  projects: Project[] | null;
  refresh: () => Promise<void>;
  role: WorkspaceRole;
  runtime: Runtime | null;
  tasks: Task[] | null;
}) {
  const stats: Array<{ label: string; statuses: string[]; icon: IconName; hint: string }> = [
    { label: '进行中的任务', statuses: ['admitted', 'maybe_sent', 'accepted'], icon: 'play', hint: '服务器持续处理' },
    { label: '等待中的任务', statuses: ['pending', 'deferred'], icon: 'logs', hint: '等待执行条件就绪' },
    { label: '已完成的任务', statuses: ['succeeded'], icon: 'check', hint: '成果保存在服务器' },
    { label: '待核查的提交', statuses: ['unknown', 'reconciling'], icon: 'alert', hint: '先核对结果，再决定重试' },
  ];
  return <div className="flex min-w-0 flex-col gap-4">
    <TeamProductionControl />
    <PageToolbar
      role={role}
      title="生产有序，状态清楚。"
      subtitle={`${displayName}，集中查看任务、资源和异常。`}
      actions={<ToolbarButton icon="retry" disabled={busy} onClick={() => void refresh()}>{busy ? '读取中…' : '刷新状态'}</ToolbarButton>}
    />
    {error && <p role="alert" className="text-warn">{error}</p>}
    <section aria-label="任务统计">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => <div key={stat.label} className="rounded-xl border border-hairline bg-card p-4">
          <header className="flex items-center justify-between text-label text-ink-secondary">{stat.label}<Icon name={stat.icon} size={16} /></header>
          <strong className="mt-2 block text-2xl font-semibold tabular-nums text-ink">
            {tasks === null ? '—' : tasks.filter((task) => stat.statuses.includes(task.status)).length.toString().padStart(2, '0')}
          </strong>
          <small className="text-label text-ink-secondary">{stat.hint}</small>
        </div>)}
      </div>
      <p className="mt-2 text-label text-ink-tertiary">统计最近最多 500 条已登记任务；每 30 秒更新。</p>
    </section>
    {pools && !pools.ready && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-warn-tint px-4 py-3">
      <Icon name="alert" size={17} className="text-warn" />
      <div className="min-w-0 flex-1">
        <strong className="block text-ink">生产资源尚未配置完成</strong>
        <small className="block text-label text-ink-secondary">{pools.blockers.length} 项资源需求待处理，配置完成后才能使用对应生成能力。</small>
      </div>
      <Link className="cap" href="/team/admin/pools">去配置</Link>
    </div>}
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section>
        <SectionHead title="全员任务" action={<Link href="/team/tasks">查看全部 →</Link>} />
        <GroupList>
          {tasks?.length
            ? tasks.slice(0, 5).map((task) => <div key={task.operationId} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <strong className="block truncate text-ink">{task.taskName} · {task.stepName}</strong>
                <small className="block truncate text-label text-ink-secondary">
                  {['project', 'canvas'].includes(task.scope.resourceType)
                    ? <Link className="text-accent" href={task.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(task.scope.resourceId)}` : `/canvas/${encodeURIComponent(task.scope.resourceId)}`}>{task.scopeName}</Link>
                    : task.scopeName} · {task.actorDisplayName}
                </small>
                <TeamTaskModel compact providerName={task.providerName} model={task.model} modelStatus={task.modelStatus} calls={task.modelCalls} />
              </div>
              <span className="flex-none text-label text-ink-secondary">{taskLabels[task.status] ?? task.status}</span>
            </div>)
            : <p className="px-4 py-6 text-ink-secondary">{tasks === null ? '读取任务中…' : '暂无已登记的生产任务'}</p>}
        </GroupList>
      </section>
      <section>
        <SectionHead title="资源与容量" action={<Link href="/team/admin/pools">管理 →</Link>} />
        <GroupList>
          <div className="flex justify-between gap-3 px-4 py-3 text-ink-secondary"><span>已启用资源池</span><strong className="text-ink">{pools ? pools.pools.filter((pool) => pool.enabled).length : '—'}</strong></div>
          <div className="flex justify-between gap-3 border-t border-hairline-soft px-4 py-3 text-ink-secondary"><span>公司模型代理</span><strong className="text-ink">{runtime ? runtime.proxyAvailable ? '已就绪' : '未就绪' : '—'}</strong></div>
          <div className="flex justify-between gap-3 border-t border-hairline-soft px-4 py-3 text-ink-secondary"><span>参考图中转 COS</span><strong className="text-ink">{runtime ? runtime.cosConfigured ? '已配置' : '未配置' : '—'}</strong></div>
        </GroupList>
        <p className="mt-3 text-label leading-5 text-ink-secondary">供应商 Key、代理和共享并发需分别配置。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="cap" href="/settings">配置供应商</Link>
          <Link className="cap" href="/projects">打开项目空间</Link>
        </div>
        <p className="mt-3 text-label text-ink-tertiary">按账号权限展示团队数据 · 最近项目 {projects?.length ?? 0} 个</p>
      </section>
    </div>
  </div>;
}
