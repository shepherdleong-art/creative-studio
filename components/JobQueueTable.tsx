'use client';

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
  queueStatus?: string;
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

  return (
    <div>
      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <div className="flex gap-3 text-sm">
          <span className="text-gray-500">
            总计: <strong>{counts.total}</strong>
          </span>
          <span className="text-green-600">
            成功: <strong>{counts.succeeded}</strong>
          </span>
          <span className="text-red-600">
            失败: <strong>{counts.failed}</strong>
          </span>
          <span className="text-blue-600">
            运行中: <strong>{counts.running}</strong>
          </span>
          <span className="text-gray-400">
            等待: <strong>{counts.pending}</strong>
          </span>
        </div>

        <div className="ml-auto flex gap-2">
          {running && onPause && (
            <button onClick={onPause} className="btn-secondary btn-sm">
              暂停
            </button>
          )}
          {!running && counts.pending > 0 && onResume && (
            <button onClick={onResume} className="btn-primary btn-sm">
              继续
            </button>
          )}
          {running && onCancel && (
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
            <tr className="border-b border-gray-200 text-left text-gray-500">
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
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-gray-100">
                <td className="py-2 max-w-[200px] truncate" title={job.inputFilename}>
                  {job.inputFilename}
                </td>
                <td className="py-2">
                  <span className={`status-badge status-${job.status}`}>
                    {STATUS_LABELS[job.status] || job.status}
                  </span>
                </td>
                <td className="py-2 text-xs text-gray-500">
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
                <td className="py-2 text-gray-500">
                  {job.attempt}/{job.maxAttempts}
                </td>
                <td className="py-2 text-gray-500">
                  {job.latencyMs ? `${(job.latencyMs / 1000).toFixed(1)}s` : '-'}
                </td>
                <td className="py-2 text-gray-500">
                  {job.estimatedCost ? `¥${job.estimatedCost.toFixed(4)}` : '-'}
                </td>
                <td className="py-2 max-w-[150px] truncate text-red-500 text-xs" title={job.errorMessage || ''}>
                  {job.errorMessage || ''}
                </td>
                <td className="py-2">
                  {job.status === 'needs_check' && (
                    <button
                      onClick={() => onRetry(job.id)}
                      className="text-purple-600 hover:text-purple-800 text-xs"
                    >
                      补抓结果
                    </button>
                  )}
                  {(job.status === 'failed' || job.status === 'canceled') && (
                    <button
                      onClick={() => onRetry(job.id)}
                      className="text-blue-600 hover:text-blue-800 text-xs"
                    >
                      重试
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
