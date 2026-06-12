'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';

interface Project {
  id: string;
  name: string;
  createdAt: string;
  providerId: string;
  model: string;
  status: string;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  totalCost: number;
  workflowType?: string;
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
  canceled: '已取消',
  needs_check: '待补抓',
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'status-pending',
  running: 'status-running',
  completed: 'status-succeeded',
  partial_failed: 'status-failed',
  canceled: 'status-canceled',
  needs_check: 'status-needs_check',
};

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({ total: 0, configured: 0 });
  const [loading, setLoading] = useState(true);

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

  const hasProjects = projects.length > 0;
  const isFirstUse = !loading && !hasProjects && providerStatus.configured === 0;

  const steps = [
    { n: 1, title: '配置供应商', body: (<>在「<Link href="/settings" className="link-accent">供应商配置</Link>」填入中转站 Base URL 和 API Key</>) },
    { n: 2, title: '上传图片', body: '上传参考图和待编辑图，写一条统一的提示词' },
    { n: 3, title: '开始编辑', body: '点击运行，系统自动并发处理、保存结果、导出报告' },
  ];

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
        {hasProjects && <h2 className="mb-4 text-[1.3rem] font-semibold tracking-tight text-ink">项目</h2>}

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
        ) : hasProjects ? (
          <div className="space-y-3">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="card flex items-center gap-4 p-4 transition-shadow hover:shadow-[0_8px_28px_rgba(0,0,0,.08)]"
              >
                <div className="grid h-[60px] w-[60px] shrink-0 place-items-center rounded-[14px] bg-surface-subtle text-ink-tertiary">
                  <Icon name="image" size={22} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <h3 className="truncate font-semibold text-ink">{p.name}</h3>
                    {p.workflowType === 'complex_product' && <span className="pill bg-check-tint text-check">复杂产品</span>}
                    <span className={`status-badge ${STATUS_CLASS[p.status] ?? 'status-pending'}`}>{STATUS_LABELS[p.status] ?? p.status}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-3.5 text-xs text-ink-secondary">
                    <span>模型 {p.model}</span>
                    <span>{new Date(p.createdAt).toLocaleString('zh-CN')}</span>
                    <span>总任务 {p.totalJobs}</span>
                    <span className="text-ok">成功 {p.completedJobs}</span>
                    {p.failedJobs > 0 && <span className="text-fail">失败 {p.failedJobs}</span>}
                    {p.totalCost > 0 && <span>¥{p.totalCost.toFixed(4)}</span>}
                  </div>
                  {p.totalJobs > 0 && (
                    <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-hairline">
                      <div
                        className={`h-full rounded-full ${
                          p.status === 'completed' ? 'bg-dot-ok' : p.status === 'failed' || p.status === 'partial_failed' ? 'bg-fail' : 'bg-accent'
                        }`}
                        style={{ width: `${Math.round(((p.completedJobs + p.failedJobs) / p.totalJobs) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDelete(p.id); }}
                  className="icon-btn shrink-0 text-ink-tertiary hover:text-fail"
                  title="删除"
                  aria-label="删除"
                >
                  <Icon name="trash" size={17} />
                </button>
                <Icon name="chevron-right" size={20} className="shrink-0 text-ink-tertiary" />
              </Link>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}