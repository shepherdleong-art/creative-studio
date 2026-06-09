'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import JobQueueTable from '@/components/JobQueueTable';
import ResultGallery from '@/components/ResultGallery';
import LogViewer from '@/components/LogViewer';

interface Project {
  id: string;
  name: string;
  providerId: string;
  model: string;
  prompt: string;
  status: string;
  concurrency: number;
  maxAttempts: number;
  images: ImageAsset[];
  jobs: Job[];
  provider: { name: string } | null;
}

interface ImageAsset {
  id: string;
  role: string;
  filename: string;
  path: string;
}

interface Job {
  id: string;
  inputFilename: string;
  outputFilename?: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  latencyMs?: number;
  estimatedCost?: number;
  errorMessage?: string;
  outputImageId?: string;
  inputImageId?: string;
  prompt?: string;
  parentJobId?: string;
  revision?: number;
  reviewMark?: string;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  running: '运行中',
  completed: '已完成',
  partial_failed: '部分失败',
  canceled: '已取消',
  needs_check: '待补抓',
};

export default function ProjectDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      if (data.error) {
        console.error(data.error);
        return;
      }
      setProject(data);

      // Check if queue is running
      const queueRes = await fetch(`/api/projects/${id}/run`);
      const queueData = await queueRes.json();
      setRunning(queueData.queueStatus === 'running');
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProject();
  }, [loadProject]);

  // Poll for updates when running
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(loadProject, 2000);
    return () => clearInterval(interval);
  }, [running, loadProject]);

  const handleAction = async (action: string) => {
    setActionLoading(action);
    try {
      await fetch(`/api/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (action === 'start' || action === 'resume') {
        setRunning(true);
      } else if (action === 'pause') {
        setRunning(false);
      } else if (action === 'cancel') {
        setRunning(false);
      }
      await loadProject();
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async (jobId: string) => {
    // Check if this job is in needs_check status -> use resume-poll instead
    const job = project?.jobs.find((j) => j.id === jobId);
    if (job?.status === 'needs_check') {
      await fetch(`/api/jobs/${jobId}/resume-poll`, { method: 'POST' });
    } else {
      await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
    }
    await loadProject();
  };

  const handleMark = async (jobId: string, mark: string) => {
    await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mark }),
    });
    await loadProject();
  };

  const handleRegenerate = async (jobId: string, prompt: string) => {
    const res = await fetch(`/api/jobs/${jobId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, markOriginal: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert('重新生成失败: ' + (data.error || '未知错误'));
      return;
    }
    // Start queue; ignore 409 if already running
    const runRes = await fetch(`/api/projects/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
    if (!runRes.ok && runRes.status !== 409) {
      const runData = await runRes.json().catch(() => ({}));
      alert('任务已创建，但启动队列失败: ' + (runData.error || runRes.status));
    }
    await loadProject();
  };

  const handleBatchDownload = async () => {
    const succeededJobs = project?.jobs.filter((j) => j.status === 'succeeded' && j.outputFilename) || [];
    if (succeededJobs.length === 0) {
      alert('没有可下载的图片');
      return;
    }

    // Download individually (browser limitation)
    for (const job of succeededJobs) {
      if (job.outputFilename) {
        const a = document.createElement('a');
        a.href = `/api/images/outputs/${job.outputFilename}`;
        a.download = job.outputFilename;
        a.click();
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };

  const handleExportCSV = () => {
    window.open(`/api/projects/${id}/export`, '_blank');
  };

  if (loading) {
    return (
      <div className="text-center py-16">
        <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-4" />
        <p className="text-gray-400">加载项目...</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-500">项目不存在</p>
        <Link href="/" className="text-blue-600 hover:underline mt-2 inline-block">
          返回列表
        </Link>
      </div>
    );
  }

  const succeededJobs = project.jobs.filter((j) => j.status === 'succeeded');
  const hasPendingJobs = project.jobs.some((j) =>
    ['pending', 'retrying'].includes(j.status)
  );

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/" className="text-gray-400 hover:text-gray-600">
              ← 返回
            </Link>
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <span className={`status-badge status-${project.status === 'partial_failed' ? 'failed' : project.status}`}>
              {STATUS_LABELS[project.status] || project.status}
            </span>
          </div>
          <div className="flex gap-4 text-xs text-gray-500 mt-1 flex-wrap">
            <span>供应商: {project.provider?.name || '-'}</span>
            <span>模型: {project.model}</span>
            <span>任务数: {project.jobs.length}</span>
            <span>成功: {succeededJobs.length}</span>
            <span>失败: {project.jobs.filter((j) => j.status === 'failed').length}</span>
          </div>
        </div>

        <div className="flex gap-2">
          {!running && hasPendingJobs && (
            <button
              onClick={() => handleAction('start')}
              disabled={!!actionLoading}
              className="btn-primary"
            >
              {actionLoading === 'start' ? '...' : '▶ 开始运行'}
            </button>
          )}
          {running && (
            <button
              onClick={() => handleAction('pause')}
              disabled={!!actionLoading}
              className="btn-secondary"
            >
              {actionLoading === 'pause' ? '...' : '⏸ 暂停'}
            </button>
          )}
          {running && (
            <button
              onClick={() => handleAction('cancel')}
              disabled={!!actionLoading}
              className="btn-danger"
            >
              {actionLoading === 'cancel' ? '...' : '⏹ 取消'}
            </button>
          )}
          {succeededJobs.length > 0 && (
            <>
              <button onClick={handleBatchDownload} className="btn-secondary">
                批量下载
              </button>
              <button onClick={handleExportCSV} className="btn-secondary">
                导出 CSV
              </button>
            </>
          )}
        </div>
      </div>

      {/* Prompt */}
      {project.prompt && (
        <div className="card p-4 mb-6">
          <h3 className="text-xs font-medium text-gray-500 mb-1">提示词</h3>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{project.prompt}</p>
        </div>
      )}

      {/* Tabs: Queue / Results */}
      <div className="space-y-6">
        {/* Queue section */}
        {project.jobs.length > 0 && (
          <div className="card p-4">
            <h2 className="font-semibold mb-4">任务队列</h2>
            <JobQueueTable
              jobs={project.jobs}
              queueStatus={running ? 'running' : 'idle'}
              onRetry={handleRetry}
              onPause={running ? () => handleAction('pause') : undefined}
              onResume={!running && hasPendingJobs ? () => handleAction('start') : undefined}
              onCancel={running ? () => handleAction('cancel') : undefined}
              running={running}
            />
          </div>
        )}

        {/* Results section */}
        <div className="card p-4">
          <h2 className="font-semibold mb-4">
            结果预览
            {succeededJobs.length > 0 && (
              <span className="text-gray-400 font-normal text-sm ml-2">
                ({succeededJobs.length} 张)
              </span>
            )}
          </h2>
          <ResultGallery
            jobs={project.jobs}
            images={project.images}
            onRetry={handleRetry}
            onMark={handleMark}
            onRegenerate={handleRegenerate}
          />
        </div>

        {/* Logs section */}
        <div className="card p-4">
          <h2 className="font-semibold mb-4">运行日志</h2>
          <LogViewer
            projectId={project.id}
            autoRefresh={running}
          />
        </div>
      </div>
    </div>
  );
}
