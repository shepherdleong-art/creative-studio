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
  videoUrl?: string;
  /** 用户可见的友好名称（D5）；filename 只服务播放 URL/物理路径。 */
  displayName?: string | null;
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

/**
 * 受保护海报的失败占位。
 *
 * 不保留破图图标的唯一可靠做法是：加载失败后把 <img> 从 DOM 摘掉，换成这条占位。
 * 不做任何重试 —— 重试只会对着同一个 401/404 无限请求。
 */
function PosterFallback({ note }: { note: string }) {
  return (
    <div
      data-testid="video-poster-fallback"
      role="img"
      aria-label={`缩略图不可用：${note}`}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        background: 'var(--color-surface-subtle)',
        color: 'var(--color-ink-tertiary)',
        fontSize: '0.7rem',
        textAlign: 'center',
        padding: '0 8px',
      }}
    >
      <Icon name="image" size={20} />
      <span>缩略图不可用</span>
    </div>
  );
}

/**
 * 结果卡海报缩略图。
 *
 * 必须 unoptimized：海报是 /api/images/... 下的会话鉴权资源，Next 图片优化器由
 * 服务端内部发请求、不带入站 Cookie，在 server 模式下必然 401 破图。unoptimized
 * 让浏览器用自带会话的同源请求直接取图 —— 鉴权、私有缓存策略都保持原样。
 */
function PosterThumb({ url }: { url: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) return <PosterFallback note="读取失败或无权访问" />;
  return (
    <Image
      src={url}
      alt="视频缩略图"
      fill
      sizes="300px"
      className="object-cover"
      unoptimized
      onError={() => setFailedUrl(url)}
    />
  );
}

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

  // 卡片顺序完全保留列表 API 的入参顺序（createdAt DESC, rowid ASC：最新批次
  // 在前、批内按提交顺序）。状态不参与位置计算——任务从 pending 变为
  // running/succeeded/failed 时卡片不跳位，与 C4 场景图的排序契约一致。
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
      {visibleJobs.length === 0 && (
        <div className="result-empty min-h-[120px]">
          <Icon name="video" size={24} />
          <span>暂无可用视频</span>
        </div>
      )}
      {visibleJobs.map((job) => {
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
                    <PosterThumb url={job.posterImageUrl} />
                  ) : (
                    <video
                      src={job.videoUrl ? `${job.videoUrl}?preview=1` : undefined}
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
              {(job.displayName || job.filename) && (
                <div className="result-name" title={job.displayName || job.filename}>
                  {job.displayName || job.filename}
                </div>
              )}
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
                      href={job.videoUrl}
                      download={job.displayName || job.filename}
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
