'use client';

import { useState } from 'react';

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
  providerTaskId?: string;
  providerStatus?: string;
  pollCount?: number;
  lastPolledAt?: string;
  remoteImageUrl?: string;
}

interface Props {
  jobs: Job[];
  queueStatus?: 'idle' | 'running' | 'paused';
  onRetry: (jobId: string) => void;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
  running: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  retrying: '重试中',
  canceled: '已取消',
  needs_check: '待补抓',
};

export default function JobQueueTable({
  jobs,
  queueStatus,
  onRetry,
  onPause,
  onResume,
  onCancel,
  running,
}: Props) {
  const counts = {
    total: jobs.length,
    succeeded: jobs.filter((j) => j.status === 'succeeded').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    running:
      jobs.filter((j) => j.status === 'running' || j.status === 'retrying')
        .length,
    pending: jobs.filter((j) => j.status === 'pending').length,
  };

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const filteredJobs = statusFilter === 'all' ? jobs : jobs.filter((j) => j.status === statusFilter);

  return (
    <div>
      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <div className="flex gap-3 text-sm">
          <span className="text-ink-secondary">
            总计: <strong>{counts.total}</strong>
          </span>
          <span className="text-ok">
            成功: <strong>{counts.succeeded}</strong>
          </span>
          <span className="text-fail">
            失败: <strong>{counts.failed}</strong>
          </span>
          <span className="text-accent">
            运行中: <strong>{counts.running}</strong>
          </span>
          <span className="text-ink-tertiary">
            等待: <strong>{counts.pending}</strong>
          </span>
        </div>

        {/* Status filter */}
        <div className="flex gap-1">
          {(['all', 'succeeded', 'failed', 'running', 'pending'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${
                statusFilter === s
                  ? 'bg-ink text-white'
                  : 'bg-surface-subtle text-ink-secondary hover:bg-hairline'
              }`}
            >
              {s === 'all' ? '全部' : s === 'succeeded' ? '成功' : s === 'failed' ? '失败' : s === 'running' ? '运行中' : '等待'}
            </button>
          ))}
        </div>

        <div className="ml-auto flex gap-2">
          {running && onPause && (
            <button onClick={onPause} className="btn-secondary btn-sm">
              暂停
            </button>
          )}
          {!running && counts.pending > 0 && onResume && (
            <button onClick={onResume} className="btn-primary btn-sm">
              {queueStatus === 'paused' ? '继续' : '开始'}
            </button>
          )}
          {(running || queueStatus === 'paused') && onCancel && (
            <button onClick={onCancel} className="btn-danger btn-sm">
              取消
            </button>
          )}
        </div>
      </div>

      {/* Job list */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-ink-secondary">
              <th className="pb-2 font-medium">输入文件</th>
              <th className="pb-2 font-medium">状态</th>
              <th className="pb-2 font-medium">远端进度</th>
              <th className="pb-2 font-medium">尝试</th>
              <th className="pb-2 font-medium">耗时</th>
              <th className="pb-2 font-medium">成本</th>
              <th className="pb-2 font-medium">错误</th>
              <th className="pb-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-sm text-ink-tertiary">
                  {statusFilter === 'all' ? '暂无任务' : `无 "${statusFilter === 'succeeded' ? '成功' : statusFilter === 'failed' ? '失败' : statusFilter === 'running' ? '运行中' : '等待'}" 状态的任务`}
                </td>
              </tr>
            ) : (
              filteredJobs.map((job) => (
              <tr key={job.id} className="border-b border-hairline-soft">
                <td className="py-2 max-w-[200px] truncate" title={job.inputFilename}>
                  {job.inputFilename}
                </td>
                <td className="py-2">
                  <span className={`status-badge status-${job.status}`}>
                    {STATUS_LABELS[job.status] || job.status}
                  </span>
                </td>
                <td className="py-2 text-xs text-ink-secondary">
                  {job.providerTaskId ? (
                    <div>
                      <div>task: {job.providerTaskId.slice(0, 10)}</div>
                      <div>{job.providerStatus || '-'} / 轮询 {job.pollCount || 0}</div>
                      {job.lastPolledAt && (
                        <div>上次: {new Date(job.lastPolledAt + 'Z').toLocaleTimeString('zh-CN')}</div>
                      )}
                    </div>
                  ) : job.status === 'running' ? (
                    <span>同步等待中</span>
                  ) : (
                    <span>-</span>
                  )}
                </td>
                <td className="py-2 text-ink-secondary">
                  {job.attempt}/{job.maxAttempts}
                </td>
                <td className="py-2 text-ink-secondary">
                  {job.latencyMs ? `${(job.latencyMs / 1000).toFixed(1)}s` : '-'}
                </td>
                <td className="py-2 text-ink-secondary">
                  {job.estimatedCost ? `¥${job.estimatedCost.toFixed(4)}` : '-'}
                </td>
                <td className="max-w-[150px] truncate py-2 text-xs text-fail" title={job.errorMessage || ''}>
                  {job.errorMessage || ''}
                </td>
                <td className="py-2">
                  {job.status === 'needs_check' && (
                    <button
                      onClick={() => onRetry(job.id)}
                      className="link-accent text-xs"
                    >
                      补抓结果
                    </button>
                  )}
                  {(job.status === 'failed' || job.status === 'canceled') && (
                    <button
                      onClick={() => onRetry(job.id)}
                      className="link-accent text-xs"
                    >
                      重试
                    </button>
                  )}
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
