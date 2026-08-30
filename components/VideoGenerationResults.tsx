'use client';

import Image from 'next/image';
import { useState } from 'react';
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
  tailImageId?: string | null;
  rejectedAt?: string | null;
  rejectReason?: string | null;
}

interface Props {
  videoJobs: VideoJob[];
  onPreview: (jobId: string) => void;
  onRetry: (jobId: string) => void | Promise<void>;
  onResumePoll: (jobId: string) => void | Promise<void>;
  onCancel: (jobId: string) => void | Promise<void>;
  onReject: (jobId: string, reason?: string) => void | boolean | Promise<void | boolean>;
  onUnreject: (jobId: string) => void | Promise<void>;
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

export default function VideoGenerationResults({ videoJobs, onPreview, onRetry, onResumePoll, onCancel, onReject, onUnreject, activePreviewJobId }: Props) {
  const [showRejected, setShowRejected] = useState(false);
  const [rejectingJobId, setRejectingJobId] = useState<string | null>(null);
  const [rejectReasonDraft, setRejectReasonDraft] = useState('');
  const [rejectSubmittingJobId, setRejectSubmittingJobId] = useState<string | null>(null);
  const rejectedJobs = videoJobs.filter((job) => Boolean(job.rejectedAt));
  const visibleJobs = showRejected ? videoJobs : videoJobs.filter((job) => !job.rejectedAt);
  if (videoJobs.length === 0) {
    return (
      <div className="result-empty">
        <Icon name="video" size={28} />
        <span>暂无视频任务</span>
      </div>
    );
  }

  const sorted = [...visibleJobs].sort((a, b) => {
    const order: Record<string, number> = { succeeded: 0, running: 1, pending: 2, needs_check: 3, failed: 4, canceled: 5 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });

  const cancelReject = () => {
    if (rejectSubmittingJobId) return;
    setRejectingJobId(null);
    setRejectReasonDraft('');
  };

  const submitReject = async (jobId: string) => {
    if (rejectSubmittingJobId) return;
    setRejectSubmittingJobId(jobId);
    try {
      const result = await onReject(jobId, rejectReasonDraft.trim() || undefined);
      if (result !== false) {
        setRejectingJobId(null);
        setRejectReasonDraft('');
      }
    } finally {
      setRejectSubmittingJobId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {rejectedJobs.length > 0 && (
        <button
          type="button"
          className="btn-secondary btn-sm self-start"
          onClick={() => setShowRejected((value) => !value)}
          aria-pressed={showRejected}
        >
          {showRejected ? '隐藏已剔除' : `显示已剔除（${rejectedJobs.length}）`}
        </button>
      )}
      {sorted.length === 0 && (
        <div className="result-empty min-h-[120px]">
          <Icon name="video" size={24} />
          <span>暂无可用视频</span>
        </div>
      )}
      {sorted.map((job) => {
        const isActive = activePreviewJobId === job.id;
        const isSucceeded = job.status === 'succeeded';
        const isRejected = Boolean(job.rejectedAt);
        const isFailed = job.status === 'failed' || job.status === 'canceled';
        const isRunning = job.status === 'pending' || job.status === 'running';
        const isNeedsCheck = job.status === 'needs_check';

        return (
          <div key={job.id} className={`result-card ${isActive ? 'active' : ''} ${isRejected ? 'is-rejected' : ''}`}>
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
                {job.tailImageId && (
                  <span className="shrink-0 rounded bg-surface-subtle px-1.5 py-0.5 text-[9px] font-medium text-ink-secondary">
                    首尾帧
                  </span>
                )}
                {isRejected && (
                  <span className="shrink-0 rounded bg-surface-subtle px-1.5 py-0.5 text-[9px] font-medium text-ink-secondary" title={job.rejectReason || undefined}>
                    已剔除
                  </span>
                )}
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
                {isSucceeded && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isRejected) {
                        void onUnreject(job.id);
                      } else {
                        setRejectingJobId(job.id);
                        setRejectReasonDraft('');
                      }
                    }}
                    className={`result-action ${isRejected ? 'link-accent' : 'text-fail'}`}
                  >
                    {isRejected ? '恢复使用' : '剔除'}
                  </button>
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
                {(isRunning || isNeedsCheck) && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onCancel(job.id); }}
                    className="result-action text-fail"
                  >
                    取消
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

              {isSucceeded && !isRejected && rejectingJobId === job.id && (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitReject(job.id);
                  }}
                >
                  <input
                    type="text"
                    value={rejectReasonDraft}
                    onChange={(event) => setRejectReasonDraft(event.target.value)}
                    maxLength={500}
                    placeholder="剔除原因（可选）"
                    aria-label="剔除原因，可选"
                    className="input-field min-w-[160px] flex-1"
                    disabled={rejectSubmittingJobId === job.id}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="result-action text-fail"
                    disabled={rejectSubmittingJobId === job.id}
                  >
                    确认剔除
                  </button>
                  <button
                    type="button"
                    className="result-action link-accent"
                    onClick={cancelReject}
                    disabled={rejectSubmittingJobId === job.id}
                  >
                    取消
                  </button>
                </form>
              )}

              {job.errorMessage && (
                <div className="mt-1 break-words text-fail" style={{ fontSize: '0.6rem' }}>
                  {job.errorMessage}
                </div>
              )}
              {isRejected && job.rejectReason && (
                <div className="mt-1 break-words text-ink-tertiary" style={{ fontSize: '0.6rem' }}>
                  剔除原因：{job.rejectReason}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
