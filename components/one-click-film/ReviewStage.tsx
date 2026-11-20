'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, GroupHeading, GroupList, GroupRow, Tag } from '@/components/ui/Appearance';
import { Icon } from '@/components/ui/Icon';
import type { FilmState } from './types';
import styles from './one-click-film.module.css';

interface ReviewShot {
  id: string;
  index: number;
  startUs: number;
  endUs: number;
  origin: 'detected' | 'manual';
  reviewMark: string;
}

interface Review {
  jobId: string;
  entryCode: string;
  durationUs: number;
  fps: number;
  detection: 'cuts' | 'single' | 'failed';
  detectionError: string | null;
  videoUrl: string | null;
  approved: boolean;
  shots: ReviewShot[];
}

function timecode(us: number): string {
  const seconds = us / 1e6;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

/**
 * 第四步 · A 布局审片：左栏成片列表、中栏预览与时间轴、右栏镜头区间。
 * 按实际切点选镜；手动切分、合并相邻镜头，标记当前版本通过。
 */
export function ReviewStage({ state }: { state: FilmState }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [activeJob, setActiveJob] = useState('');
  const [selectedShot, setSelectedShot] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [splitAt, setSplitAt] = useState('');
  const video = useRef<HTMLVideoElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/one-click-film/${state.project.id}/review`, { cache: 'no-store' });
      const body = await response.json() as { reviews?: Review[]; message?: string; error?: string };
      if (!response.ok) throw new Error(body.message || body.error || '读取审片记录失败');
      setReviews(body.reviews ?? []);
      setActiveJob((current) => current || body.reviews?.[0]?.jobId || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [state.project.id]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const review = reviews.find((item) => item.jobId === activeJob) ?? reviews[0] ?? null;
  const shot = review?.shots.find((item) => item.id === selectedShot) ?? null;

  const post = async (body: Record<string, unknown>) => {
    setError('');
    const response = await fetch(`/api/one-click-film/${state.project.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: review?.jobId, ...body }),
    });
    const payload = await response.json() as { message?: string; error?: string };
    if (!response.ok) throw new Error(payload.message || payload.error || '操作失败');
    await load();
  };

  const seek = (us: number) => {
    const element = video.current;
    if (!element) return;
    element.currentTime = us / 1e6;
    void element.play().catch(() => {});
  };

  if (loading) return <div className={styles.center}><div className={styles.spinner} />读取审片记录…</div>;

  return <div className={styles.review}>
    <div className={styles.reviewLeft}>
      <GroupHeading>成片</GroupHeading>
      {reviews.length === 0
        ? <p className={styles.hint}>还没有已下载的原片。先在生成页完成正文生成。</p>
        : reviews.map((item) => (
          <button
            key={item.jobId}
            type="button"
            className={styles.reviewItem}
            aria-current={item.jobId === review?.jobId}
            onClick={() => { setActiveJob(item.jobId); setSelectedShot(''); }}
          >
            <b>{item.entryCode}</b>
            <small>{item.shots.length} 镜</small>
            <Tag tone={item.approved ? 'ok' : 'warn'}>{item.approved ? '已通过' : '待审'}</Tag>
          </button>
        ))}
    </div>

    <div className={styles.reviewMain}>
      {!review ? <EmptyState icon="film" title="没有可审的成片" description="生成并下载原片后，这里会按实际切点列出镜头。" /> : <>
        <div className={styles.reviewHead}>
          <b>{review.entryCode}</b>
          <small>{timecode(review.durationUs)} · {review.fps.toFixed(0)} fps</small>
          <Tag tone={review.detection === 'failed' ? 'fail' : review.detection === 'single' ? 'idle' : 'ok'}>
            {review.detection === 'failed' ? '识别失败' : review.detection === 'single' ? '一镜到底' : `${review.shots.length} 个实际切点`}
          </Tag>
          {review.approved ? <Tag tone="ok">审片通过</Tag> : null}
        </div>
        {review.videoUrl ? <video ref={video} className={styles.reviewVideo} src={review.videoUrl} controls preload="metadata" /> : null}
        {review.detection === 'failed'
          ? <p className={styles.hintWarn}>{review.detectionError || '切点识别失败'}；整条原片仍可播放，可手动加切点。</p>
          : null}
        <div className={styles.timeline}>
          {review.shots.map((item) => {
            const width = review.durationUs > 0 ? (item.endUs - item.startUs) / review.durationUs * 100 : 0;
            return <button
              key={item.id}
              type="button"
              className={styles.timelineShot}
              style={{ width: `${Math.max(width, 4)}%` }}
              aria-current={item.id === shot?.id}
              onClick={() => { setSelectedShot(item.id); seek(item.startUs); }}
              title={`${item.id} ${timecode(item.startUs)}–${timecode(item.endUs)}`}
            >
              {item.id}
            </button>;
          })}
        </div>
        {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
      </>}
    </div>

    <div className={styles.reviewRight}>
      <GroupHeading>镜头与返工范围</GroupHeading>
      {!review || !shot ? <p className={styles.hint}>在时间轴上点一个镜头。</p> : <>
        <GroupList>
          <GroupRow label="镜头">{shot.id}</GroupRow>
          <GroupRow label="区间">{timecode(shot.startUs)}–{timecode(shot.endUs)}</GroupRow>
          <GroupRow label="来源">{shot.origin === 'manual' ? '手动修整' : '实际切点'}</GroupRow>
          <GroupRow label="审片标记">{shot.reviewMark || '未标记'}</GroupRow>
        </GroupList>
        <div className={styles.reviewActions}>
          <button type="button" className="cap" onClick={() => seek(shot.startUs)}>
            <Icon name="film" size={14} />播放本镜
          </button>
          <button type="button" className="cap" onClick={() => void post({ action: 'mark', shotId: shot.id, mark: 'ok' })}>
            标记本镜
          </button>
          <button
            type="button"
            className="cap"
            disabled={!review.shots[shot.index]}
            onClick={() => void post({ action: 'merge', shotIds: [shot.id, review.shots[shot.index]!.id] })}
          >
            与下一镜合并
          </button>
        </div>
        <GroupHeading>手动切分</GroupHeading>
        <div className={styles.splitRow}>
          <input
            className="input-field"
            value={splitAt}
            onChange={(event) => setSplitAt(event.target.value)}
            placeholder="切点秒数，例如 7.5"
            aria-label="切点秒数"
          />
          <button
            type="button"
            className="cap"
            onClick={() => {
              const seconds = Number(splitAt);
              if (!Number.isFinite(seconds)) { setError('切点必须是数字秒数'); return; }
              void post({ action: 'split', shotId: shot.id, atUs: Math.round(seconds * 1e6) });
            }}
          >
            切分
          </button>
        </div>
        <button
          type="button"
          className="cap cap-primary w-full"
          disabled={review.approved}
          onClick={() => void post({ action: 'approve' })}
          data-testid="one-click-film-approve"
        >
          {review.approved ? '已通过审片' : '标记审片通过'}
        </button>
      </>}
    </div>
  </div>;
}
