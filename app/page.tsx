'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';

interface Project {
  id: string;
  name: string;
  createdAt: string;
  lastOpenedAt?: string | null;
  providerId: string;
  model: string;
  status: string;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  totalCost: number;
  // 全口径总成本（微元）：来自 usage ledger，无 ledger 记录时回退图片任务估算
  totalUsageCostMicros: number;
  thumbnailImageUrl?: string;
}

interface ProviderStatus {
  total: number;
  configured: number;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  running: '运行中',
  completed: '已完成',
  partial_failed: '部分失败',
  failed: '全部失败',
  canceled: '已取消',
  needs_check: '待补抓',
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'status-pending',
  running: 'status-running',
  completed: 'status-succeeded',
  partial_failed: 'status-partial_failed',
  failed: 'status-failed',
  canceled: 'status-canceled',
  needs_check: 'status-needs_check',
};

type ViewMode = 'card' | 'table';
type SortKey = 'name' | 'createdAt' | 'lastOpenedAt' | 'totalJobs' | 'totalCost';
type SortDir = 'asc' | 'desc';

// 视图偏好活在 localStorage 里,属于 React 之外的状态。用 useSyncExternalStore 读取:
// 服务端快照固定为 'card',客户端在 hydration 之后才切到真实偏好,既不会 hydration 不一致,
// 也不用在 effect 里 setState。同 tab 的写入靠 viewModeListeners 广播,跨 tab 靠 storage 事件。
const VIEW_MODE_STORAGE_KEY = 'creative-studio:projects-view-mode';

const viewModeListeners = new Set<() => void>();

function subscribeViewMode(onChange: () => void): () => void {
  viewModeListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    viewModeListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'table' ? 'table' : 'card';
  } catch {
    return 'card';
  }
}

const readViewModeOnServer = (): ViewMode => 'card';

function writeViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // 隐私模式下 localStorage 可能不可写,偏好丢失即可,不影响功能
  }
  viewModeListeners.forEach((listener) => listener());
}

function progressClass(status: string): string {
  if (status === 'completed') return 'bg-dot-ok';
  // 部分失败 = 黄:还有成果在。只有全军覆没才是红的。
  if (status === 'partial_failed') return 'bg-dot-warn';
  if (status === 'failed') return 'bg-fail';
  return 'bg-accent';
}

function formatDateOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN');
}

function formatCompactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function projectCostYuan(p: Project): number {
  return (p.totalUsageCostMicros || 0) / 1_000_000;
}

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({ total: 0, configured: 0 });
  const [loading, setLoading] = useState(true);
  const viewMode = useSyncExternalStore(subscribeViewMode, readViewMode, readViewModeOnServer);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('lastOpenedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const loadProjects = () => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadProjects();
    fetch('/api/providers')
      .then((r) => r.json())
      .then((data: Array<{ hasApiKey: boolean; enabled: number }>) => {
        const enabled = data.filter((p) => p.enabled);
        setProviderStatus({
          total: enabled.length,
          configured: enabled.filter((p) => p.hasApiKey).length,
        });
      })
      .catch(() => {});
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此项目？所有关联的图片和任务将被清除。')) return;
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    loadProjects();
  };

  const normalizedQuery = query.trim().toLowerCase();

  // 搜索只作用于列表,顶部统计块始终用未过滤的 projects,避免打字时数字乱跳
  const filteredProjects = useMemo(() => {
    if (!normalizedQuery) return projects;
    return projects.filter((p) => {
      const statusLabel = STATUS_LABELS[p.status] ?? p.status;
      return (
        p.name.toLowerCase().includes(normalizedQuery) ||
        (p.model || '').toLowerCase().includes(normalizedQuery) ||
        statusLabel.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [projects, normalizedQuery]);

  // 排序只作用于表格视图 —— 卡片视图没有排序控件,保持接口返回的最近打开 DESC
  const tableProjects = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filteredProjects].sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-CN') * dir;
      if (sortKey === 'totalJobs') return (a.totalJobs - b.totalJobs) * dir;
      if (sortKey === 'totalCost') return (a.totalUsageCostMicros - b.totalUsageCostMicros) * dir;
      if (sortKey === 'lastOpenedAt') {
        return (a.lastOpenedAt || a.createdAt).localeCompare(b.lastOpenedAt || b.createdAt) * dir;
      }
      return a.createdAt.localeCompare(b.createdAt) * dir;
    });
  }, [filteredProjects, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const hasProjects = projects.length > 0;
  const isFirstUse = !loading && !hasProjects && providerStatus.configured === 0;
  const noMatches = hasProjects && filteredProjects.length === 0;

  const steps = [
    { n: 1, title: '配置供应商', body: (<>在「<Link href="/settings" className="link-accent">供应商配置</Link>」填入中转站 Base URL 和 API Key</>) },
    { n: 2, title: '上传图片', body: '上传参考图和待编辑图，写一条统一的提示词' },
    { n: 3, title: '开始编辑', body: '点击运行，系统自动并发处理、保存结果、导出报告' },
  ];

  const sortHeader = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className={`inline-flex items-center gap-1 font-medium transition-colors hover:text-ink ${
        sortKey === key ? 'text-ink' : ''
      } ${align === 'right' ? 'flex-row-reverse' : ''}`}
      aria-label={`按${label}排序`}
    >
      {label}
      <Icon
        name="chevron-right"
        size={13}
        className={`transition-transform ${sortDir === 'asc' ? '-rotate-90' : 'rotate-90'} ${
          sortKey === key ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </button>
  );

  return (
    <div className="space-y-12">
      {/* Hero */}
      <section className="pt-4 text-center">
        <h1 className="text-[2.6rem] font-semibold leading-[1.08] tracking-[-0.022em] text-ink">
          把复杂产品<br />做成一整套素材
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[1.15rem] leading-relaxed text-ink-secondary">
          场景图生产 · 分镜管理 · 视频任务准备。从一张场景图出发，自动并发、保存、导出。
        </p>
        <div className="mt-7 flex items-center justify-center gap-5">
          <Link href="/projects/new" className="btn-primary px-6 py-3 text-base">新建项目</Link>
          {!isFirstUse && <Link href="/settings" className="link-accent text-base">供应商配置 ›</Link>}
        </div>
      </section>

      {/* First-use guide */}
      {isFirstUse && (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="tile p-5">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">{s.n}</div>
              <div className="mt-3 text-sm font-semibold text-ink">{s.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-ink-secondary">{s.body}</div>
            </div>
          ))}
        </section>
      )}

      {/* Stats */}
      {!isFirstUse && (
        <section className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
          <div className="tile p-5 text-center">
            <div className="text-[2rem] font-semibold tracking-tight text-ink">{projects.length}</div>
            <div className="mt-1 text-[0.8rem] text-ink-secondary">项目总数</div>
          </div>
          <div className="tile p-5 text-center">
            <div className="text-[2rem] font-semibold tracking-tight text-ink">{projects.reduce((s, p) => s + p.completedJobs, 0)}</div>
            <div className="mt-1 text-[0.8rem] text-ink-secondary">已完成任务</div>
          </div>
          <div className="tile p-5 text-center">
            <div className="text-[2rem] font-semibold tracking-tight text-accent">{projects.filter((p) => p.status === 'running').length}</div>
            <div className="mt-1 text-[0.8rem] text-ink-secondary">运行中</div>
          </div>
          <div className="tile p-5 text-center">
            <div className={`text-[2rem] font-semibold tracking-tight ${providerStatus.configured > 0 ? 'text-ink' : 'text-fail'}`}>
              {providerStatus.configured}/{providerStatus.total}
            </div>
            <div className="mt-1 text-[0.8rem] text-ink-secondary">
              <Link href="/settings" className="hover:underline">供应商已配置</Link>
            </div>
          </div>
        </section>
      )}

      {/* Project list */}
      <section>
        {hasProjects && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[1.3rem] font-semibold tracking-tight text-ink">
              项目
              {normalizedQuery && (
                <span className="ml-2 text-sm font-normal text-ink-tertiary">
                  {filteredProjects.length} / {projects.length}
                </span>
              )}
            </h2>

            <div className="flex items-center gap-2.5">
              {/* 宽度给在外层:.input-field 自带 width:100%,直接给 input 加 w-* 会被压掉 */}
              <div className="relative w-[16.5rem] max-w-full">
                <Icon
                  name="search"
                  size={15}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索项目名 / 模型 / 状态"
                  aria-label="搜索项目"
                  className="input-field search-field"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:text-ink"
                    aria-label="清除搜索"
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>

              <div className="segmented" role="group" aria-label="列表视图切换">
                <button
                  type="button"
                  aria-pressed={viewMode === 'card'}
                  onClick={() => writeViewMode('card')}
                  className="inline-flex items-center gap-1.5"
                  title="卡片视图"
                >
                  <Icon name="grid" size={14} />卡片
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === 'table'}
                  onClick={() => writeViewMode('table')}
                  className="inline-flex items-center gap-1.5"
                  title="表格视图"
                >
                  <Icon name="table" size={14} />表格
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="py-10 text-center text-ink-tertiary">
            <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            加载中…
          </div>
        ) : !hasProjects && !isFirstUse ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-subtle text-ink-tertiary">
              <Icon name="image" size={26} />
            </div>
            <h3 className="mb-2 text-lg font-medium text-ink">暂无项目</h3>
            <p className="mb-5 text-sm text-ink-tertiary">创建第一个批量图片编辑项目</p>
            <Link href="/projects/new" className="btn-primary">新建项目</Link>
          </div>
        ) : noMatches ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-subtle text-ink-tertiary">
              <Icon name="search" size={24} />
            </div>
            <h3 className="mb-2 text-lg font-medium text-ink">没有匹配的项目</h3>
            <p className="mb-5 text-sm text-ink-tertiary">「{query.trim()}」没有匹配到任何项目名、模型或状态</p>
            <button type="button" onClick={() => setQuery('')} className="btn-secondary">清除搜索</button>
          </div>
        ) : hasProjects && viewMode === 'table' ? (
          <div className="card max-h-[calc(100vh-22rem)] overflow-y-auto overscroll-contain p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-ink-secondary">
                    <th className="px-4 py-2.5 font-medium">{sortHeader('name', '项目')}</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium">模型</th>
                    <th className="px-4 py-2.5 font-medium">{sortHeader('totalJobs', '任务')}</th>
                    <th className="px-4 py-2.5 text-right font-medium">{sortHeader('totalCost', '成本', 'right')}</th>
                    <th className="px-4 py-2.5 font-medium">{sortHeader('createdAt', '创建时间')}</th>
                    <th className="px-4 py-2.5 font-medium">{sortHeader('lastOpenedAt', '最近打开')}</th>
                    <th className="w-10 px-4 py-2.5 font-medium"><span className="sr-only">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  {tableProjects.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => router.push(`/projects/${p.id}`)}
                      className="cursor-pointer border-b border-hairline-soft transition-colors last:border-b-0 hover:bg-surface-subtle"
                    >
                      <td className="max-w-[22rem] px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-surface-subtle text-ink-tertiary">
                            {p.thumbnailImageUrl ? (
                              <img src={p.thumbnailImageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                            ) : (
                              <Icon name="image" size={14} />
                            )}
                          </div>
                          <Link
                            href={`/projects/${p.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="truncate font-medium text-ink hover:underline"
                            title={p.name}
                          >
                            {p.name}
                          </Link>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`status-badge ${STATUS_CLASS[p.status] ?? 'status-pending'}`}>
                          {STATUS_LABELS[p.status] ?? p.status}
                        </span>
                      </td>
                      <td className="max-w-[12rem] truncate px-4 py-2.5 text-ink-secondary" title={p.model}>{p.model}</td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {p.totalJobs > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1 w-14 overflow-hidden rounded-full bg-hairline">
                              <div
                                className={`h-full rounded-full ${progressClass(p.status)}`}
                                style={{ width: `${Math.round(((p.completedJobs + p.failedJobs) / p.totalJobs) * 100)}%` }}
                              />
                            </div>
                            <span className="whitespace-nowrap text-xs">
                              <span className="text-ok">{p.completedJobs}</span>
                              {p.failedJobs > 0 && <span className="text-fail"> +{p.failedJobs}失败</span>}
                              <span className="text-ink-tertiary"> / {p.totalJobs}</span>
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-ink-tertiary">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-ink-secondary">
                        {projectCostYuan(p) > 0 ? `¥${projectCostYuan(p).toFixed(4)}` : <span className="text-ink-tertiary">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-secondary">{formatCompactTime(p.createdAt)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-secondary">{formatCompactTime(p.lastOpenedAt || p.createdAt)}</td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                          className="icon-btn text-ink-tertiary hover:text-fail"
                          title="删除"
                          aria-label={`删除项目 ${p.name}`}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : hasProjects ? (
          /* 宫格视图(参考剪映本地草稿页):大缩略图铺成格子,文字信息压到图下面两行。
             删除按钮是 Link 的兄弟节点而不是子节点 —— button 嵌在 a 里是非法 HTML。 */
          <div className="max-h-[calc(100vh-22rem)] overflow-y-auto overscroll-contain pr-1">
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
              {filteredProjects.map((p) => (
                <div key={p.id} className="group relative">
                  <Link href={`/projects/${p.id}`} className="block">
                    <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-surface-subtle ring-1 ring-hairline transition-shadow group-hover:shadow-[0_10px_30px_rgba(0,0,0,.14)]">
                      {p.thumbnailImageUrl ? (
                        <img src={p.thumbnailImageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <div className="grid h-full w-full place-items-center text-ink-tertiary">
                          <Icon name="image" size={28} />
                        </div>
                      )}
                      <span className={`status-badge absolute left-2 top-2 shadow-sm ${STATUS_CLASS[p.status] ?? 'status-pending'}`}>
                        {STATUS_LABELS[p.status] ?? p.status}
                      </span>
                      {p.totalJobs > 0 && (
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
                          <div
                            className={`h-full ${progressClass(p.status)}`}
                            style={{ width: `${Math.round(((p.completedJobs + p.failedJobs) / p.totalJobs) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="mt-2 truncate text-[0.9rem] font-medium text-ink" title={p.name}>{p.name}</div>
                    {/* 左右对开:左边截断、右边固定,窄格子里也不会把日期挤掉。
                        失败数和精确成本不放这里 —— 红色状态胶囊+红色进度条已经给了信号,
                        要看数字去表格视图。 */}
                    <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-ink-tertiary">
                      <span className="truncate">
                        {p.totalJobs > 0 ? `${p.completedJobs}/${p.totalJobs} 任务` : '暂无任务'}
                        {projectCostYuan(p) > 0 && ` · ¥${projectCostYuan(p).toFixed(2)}`}
                      </span>
                      <span className="shrink-0">{formatDateOnly(p.createdAt)}</span>
                    </div>
                  </Link>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-lg bg-black/45 text-white opacity-0 transition-opacity hover:bg-fail focus-visible:opacity-100 group-hover:opacity-100"
                    title="删除"
                    aria-label={`删除项目 ${p.name}`}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
