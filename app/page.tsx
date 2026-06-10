'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

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
    // Also check provider config status
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

  return (
    <div>
      {/* Hero / Welcome section */}
      <div className="card p-6 mb-6 bg-gradient-to-br from-blue-50 to-white border-blue-200">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold mb-2">🖼️ 产品素材工作台</h1>
            <p className="text-gray-600 max-w-lg">
              复杂结构产品的图片生产 + 分镜管理 + 视频任务准备。默认新流程从场景图 A 出发，旧版批量编辑仍可用。
            </p>
          </div>
          <Link href="/projects/new" className="btn-primary text-base px-6 py-2.5 shadow-sm">
            + 新建项目
          </Link>
        </div>
      </div>

      {/* Quick-start guide for first-time users */}
      {isFirstUse && (
        <div className="card p-6 mb-6 border-green-200 bg-green-50/50">
          <h2 className="font-semibold text-lg mb-4">👋 欢迎使用，三步开始</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-sm shrink-0">
                1
              </div>
              <div>
                <div className="font-medium text-sm">配置供应商</div>
                <div className="text-xs text-gray-500 mt-1">
                  在「<Link href="/settings" className="text-blue-600 hover:underline">供应商配置</Link>」页面填入中转站 Base URL 和 API Key
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-sm shrink-0">
                2
              </div>
              <div>
                <div className="font-medium text-sm">上传图片</div>
                <div className="text-xs text-gray-500 mt-1">
                  上传参考图和待编辑图，写一条统一的提示词
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-sm shrink-0">
                3
              </div>
              <div>
                <div className="font-medium text-sm">开始编辑</div>
                <div className="text-xs text-gray-500 mt-1">
                  点击运行，系统自动并发处理、保存结果、导出报告
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Status summary bar */}
      {!isFirstUse && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-blue-600">{projects.length}</div>
            <div className="text-xs text-gray-500 mt-1">项目总数</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-green-600">
              {projects.reduce((s, p) => s + p.completedJobs, 0)}
            </div>
            <div className="text-xs text-gray-500 mt-1">已完成任务</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-orange-600">
              {projects.filter((p) => p.status === 'running').length}
            </div>
            <div className="text-xs text-gray-500 mt-1">运行中</div>
          </div>
          <div className="card p-4 text-center">
            <div className={`text-2xl font-bold ${providerStatus.configured > 0 ? 'text-green-600' : 'text-red-500'}`}>
              {providerStatus.configured}/{providerStatus.total}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              <Link href="/settings" className="hover:underline">供应商已配置</Link>
            </div>
          </div>
        </div>
      )}

      {/* Project list */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {hasProjects ? '项目列表' : ''}
          </h2>
        </div>

        {loading ? (
          <div className="text-center py-8 text-gray-400">
            <div className="animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-2" />
            加载中...
          </div>
        ) : !hasProjects && !isFirstUse ? (
          <div className="text-center py-12">
            <div className="text-5xl mb-4">📂</div>
            <h3 className="text-lg font-medium text-gray-600 mb-2">暂无项目</h3>
            <p className="text-sm text-gray-400 mb-4">创建第一个批量图片编辑项目</p>
            <Link href="/projects/new" className="btn-primary">新建项目</Link>
          </div>
        ) : hasProjects ? (
          <div className="grid gap-4">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="card p-5 hover:shadow-md transition-shadow block"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold text-lg truncate">{p.name}</h3>
                      {p.workflowType === 'complex_product' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">复杂产品</span>
                      )}
                      <span className={`status-badge status-${p.status === 'partial_failed' ? 'failed' : p.status}`}>
                        {STATUS_LABELS[p.status] || p.status}
                      </span>
                    </div>
                    <div className="flex gap-4 text-xs text-gray-500 flex-wrap">
                      <span>模型: {p.model}</span>
                      <span>创建: {new Date(p.createdAt).toLocaleString('zh-CN')}</span>
                      <span>总任务: {p.totalJobs}</span>
                      <span className="text-green-600">成功: {p.completedJobs}</span>
                      {p.failedJobs > 0 && (
                        <span className="text-red-500">失败: {p.failedJobs}</span>
                      )}
                      {p.totalCost > 0 && (
                        <span>总成本: ¥{p.totalCost.toFixed(4)}</span>
                      )}
                    </div>
                    {p.totalJobs > 0 && (
                      <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            p.status === 'completed'
                              ? 'bg-green-500'
                              : p.status === 'failed' || p.status === 'partial_failed'
                              ? 'bg-red-500'
                              : 'bg-blue-500'
                          }`}
                          style={{
                            width: `${Math.round(
                              ((p.completedJobs + p.failedJobs) / p.totalJobs) * 100
                            )}%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleDelete(p.id);
                    }}
                    className="text-gray-300 hover:text-red-500 transition-colors ml-4 shrink-0"
                    title="删除"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
