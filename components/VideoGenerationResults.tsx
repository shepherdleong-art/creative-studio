'use client';

import Image from 'next/image';
import { Icon } from '@/components/ui/Icon';

interface VideoJob {
  id: string;
  shotId: string;
  providerId: string;
  model: string;
  templateId: string | null;
  prompt: string;
  durationSec: number;
  status: string;
  providerTaskId?: string;
  providerStatus?: string;
  filename?: string;
  localVideoPath?: string;
  errorMessage?: string;
  providerName?: string;
  templateName?: string;
  posterImageUrl?: string;
}

interface Props {
  videoJobs: VideoJob[];
  onPreview: (jobId: string) => void;
  onRetry: (jobId: string) => void | Promise<void>;
  onResumePoll: (jobId: string) => void | Promise<void>;
  activePreviewJobId: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  succeeded: '完成',
  failed: '失败',
  running: '运行中',
  pending: '等待',
  needs_check: '待补抓',
  canceled: '已取消',
};

export default function VideoGenerationResults({ videoJobs, onPreview, onRetry, onResumePoll, activePreviewJobId }: Props) {
  if (videoJobs.length === 0) {
    return (
      <div className="result-empty">
        <Icon name="video" size={28} />
        <span>暂无视频任务</span>
      </div>
    );
  }

  const sorted = [...videoJobs].sort((a, b) => {
    const order: Record<string, number> = { succeeded: 0, running: 1, pending: 2, needs_check: 3, failed: 4, canceled: 5 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });

  return (
    <div className="flex flex-col gap-3">
      {sorted.map((job) => {
        const isActive = activePreviewJobId === job.id;
        const isSucceeded = job.status === 'succeeded';
        const isFailed = job.status === 'failed' || job.status === 'canceled';
        const isRunning = job.status === 'pending' || job.status === 'running';
        const isNeedsCheck = job.status === 'needs_check';

        return (
          <div key={job.id} className={`result-card ${isActive ? 'active' : ''}`}>
            <div className="result-thumb" onClick={() => isSucceeded && job.filename && onPreview(job.id)}>
              {isSucceeded ? (
                <>
                  {job.posterImageUrl ? (
                    <Image src={job.posterImageUrl} alt="视频缩略图" fill sizes="300px" className="object-cover" />
                  ) : (
                    <video
                      src={job.filename ? `/api/videos/videos/${encodeURIComponent(job.filename)}` : undefined}
                      preload="metadata"
                      muted
                      className="w-full h-full object-cover"
                    />
                  )}
                  <div className="play-overlay">
                    <Icon name="play" size={28} />
                  </div>
                </>
              ) : isRunning ? (
                <div style={{ color: 'rgba(255,255,255,.4)', fontSize: '0.72rem', textAlign: 'center', background: '#1d1d1f', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  生成中…
                </div>
              ) : (
                <div style={{ color: 'rgba(255,255,255,.4)', fontSize: '0.72rem', textAlign: 'center', background: '#1d1d1f', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {STATUS_LABELS[job.status] || job.status}
                </div>
              )}
            </div>

            <div className="result-info">
              <div className="result-meta-row">
                <span className={`status-badge result-status status-${isSucceeded ? 'succeeded' : isFailed ? 'failed' : isRunning ? 'running' : 'pending'}`}>
                  {STATUS_LABELS[job.status] || job.status}
                </span>
                <span className="result-meta">
                  {job.providerName || '-'} / {job.templateName || '自定义'} / {job.durationSec}s
                </span>
              </div>

              <div className="result-actions">
                {isSucceeded && job.filename && (
                  <>
                    <a
                      href={`/api/videos/videos/${encodeURIComponent(job.filename)}`}
                      download
                      className="result-action link-accent"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Icon name="download" size={11} />
                      <span>下载</span>
                    </a>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onPreview(job.id); }}
                      className="result-action link-accent"
                    >
                      {isActive ? '正在播放' : '播放'}
                    </button>
                  </>
                )}
                {isNeedsCheck && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onResumePoll(job.id); }}
                    className="result-action link-accent"
                  >
                    补抓结果
                  </button>
                )}
                {isFailed && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onRetry(job.id); }}
                    className="result-action link-accent"
                  >
                    重试
                  </button>
                )}
              </div>

              {job.errorMessage && (
                <div className="mt-1 break-words text-fail" style={{ fontSize: '0.6rem' }}>
                  {job.errorMessage}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
