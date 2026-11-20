'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, GroupHeading, GroupList, GroupRow, Tag, ToolbarButton } from '@/components/ui/Appearance';
import { Icon } from '@/components/ui/Icon';
import type { FilmState } from './types';
import type { ReworkCandidate } from '@/lib/one-click-film/rework';
import { ReworkPanel } from './ReworkPanel';
import { useShotThumbnails } from './useShotThumbnails';
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
  entryId: string;
  entryCode: string;
  durationUs: number;
  fps: number;
  detection: 'cuts' | 'single' | 'failed';
  detectionError: string | null;
  videoUrl: string | null;
  approved: boolean;
  draft: boolean;
  hdApproved: boolean;
  hdVideoUrl: string | null;
  reviewSourceId: string | null;
  undoMergeId: string | null;
  shots: ReviewShot[];
}

function timecode(us: number): string {
  const centiseconds = Math.round(us / 10_000);
  const minutes = Math.floor(centiseconds / 6000);
  return `${String(minutes).padStart(2, '0')}:${((centiseconds % 6000) / 100).toFixed(2).padStart(5, '0')}`;
}

/**
 * 第四步 · A 布局审片：左栏成片列表、中栏预览与时间轴、右栏镜头区间。
 * 按实际切点选镜；手动切分、合并相邻镜头，标记当前版本通过。
 */
export function ReviewStage({ state, focus, onAdjustSound, onlyEntry }: {
  state: FilmState;
  focus?: { code: string; shotId?: string };
  onAdjustSound?: (code: string) => void;
  onlyEntry?: boolean;
}) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [activeJob, setActiveJob] = useState('');
  const [selectedShot, setSelectedShot] = useState(focus?.shotId ?? '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [playheadUs, setPlayheadUs] = useState<number | null>(null);
  const [posting, setPosting] = useState(false);
  const [comparison, setComparison] = useState<{ candidate: ReworkCandidate | null; seam: string }>({ candidate: null, seam: '' });
  const compare = useCallback((candidate: ReworkCandidate | null, seam: string) => setComparison({ candidate, seam }), []);
  const video = useRef<HTMLVideoElement>(null);
  const playbackEnd = useRef<number | null>(null);
  const singleEntry = onlyEntry ? focus?.code : undefined;

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/one-click-film/${state.project.id}/review`, { cache: 'no-store' });
      const body = await response.json() as { reviews?: Review[]; message?: string; error?: string };
      if (!response.ok) throw new Error(body.message || body.error || '读取审片记录失败');
      const entries = body.reviews ?? [];
      const visible = singleEntry ? entries.filter((row) => row.entryCode === singleEntry) : entries;
      setReviews(visible);
      setActiveJob((current) => current || visible.find((row) => row.entryCode === focus?.code)?.jobId || visible[0]?.jobId || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [state.project.id, focus?.code, singleEntry]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const review = reviews.find((item) => item.jobId === activeJob) ?? reviews[0] ?? null;
  const shot = review?.shots.find((item) => item.id === selectedShot) ?? review?.shots[0] ?? null;
  const previewUrl = review?.hdVideoUrl || review?.videoUrl;
  const sampleTime = (item: ReviewShot) => Math.round((item.startUs + item.endUs) / 2);
  const thumbnail = useShotThumbnails(review?.hdVideoUrl || review?.videoUrl,
    review?.shots.map(sampleTime).join(',') ?? '');
  const durationUs = review?.durationUs ?? 0;
  const timelineDurationUs = durationUs;
  const percent = (us: number) => `${100 * us / (timelineDurationUs || 1)}%`;
  const fps = review && Number.isFinite(review.fps) && review.fps > 0 ? review.fps : 24;
  const lastFrame = Math.round(timelineDurationUs * fps / 1e6);
  const positionUs = playheadUs ?? shot?.startUs ?? 0;
  const playheadFrame = Math.max(0, Math.min(lastFrame, Math.round((positionUs) * fps / 1e6)));
  const timeForFrame = (frame: number) => frame === lastFrame ? timelineDurationUs : Math.round(frame * 1e6 / fps);
  const splitAt = timeForFrame(playheadFrame);
  const canSplit = !!previewUrl && !!shot && splitAt > shot.startUs + 100_000 && splitAt < shot.endUs - 100_000;
  const nextShot = review?.shots[shot?.index ?? -1];
  const soundMode = state.entries.find((entry) => entry.code === review?.entryCode)?.soundMode;

  const post = async (body: Record<string, unknown>) => {
    if (!review || posting) return;
    setError('');
    setPosting(true);
    try {
      const response = await fetch(`/api/one-click-film/${state.project.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: review.jobId, ...body }),
      });
      const payload = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.message || payload.error || '操作失败');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPosting(false);
    }
  };

  const seek = (us: number, endUs?: number) => {
    const time = Math.max(0, us / 1e6);
    setPlayheadUs(Math.round((time) * 1e6));
    playbackEnd.current = endUs === undefined ? null : endUs / 1e6;
    const element = video.current;
    if (!element) return;
    if (endUs === undefined) element.pause();
    element.currentTime = time;
    if (endUs !== undefined) void element.play().catch(() => {});
  };

  const scrub = (frame: number) => {
    const us = timeForFrame(frame);
    const currentShot = review?.shots.find((item) => us >= item.startUs && us < item.endUs);
    if (currentShot && currentShot.id !== shot?.id) {
      setSelectedShot(currentShot.id);
      compare(null, '');
    }
    seek(us);
  };

  if (loading) return <div className={styles.center}><div className={styles.spinner} />读取审片记录…</div>;

  return <div className={styles.review}>
    <div className={styles.reviewLeft}>
      <GroupHeading action={<span className={styles.hint}>{reviews.length} 条</span>}>本次成片</GroupHeading>
      {reviews.length === 0
        ? <p className={styles.hint}>还没有已下载的原片。先在生成页完成正文生成。</p>
        : reviews.map((item) => (
          <button
            key={item.jobId}
            type="button"
            className={styles.reviewItem}
            aria-current={item.jobId === review?.jobId}
            onClick={() => {
              if (item.jobId === review?.jobId) return;
              video.current?.pause();
              setActiveJob(item.jobId);
              setSelectedShot('');
              setPlayheadUs(0);
              playbackEnd.current = null;
              compare(null, '');
            }}
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
          <small className="tnum">{timecode(review.durationUs)} · {fps.toFixed(2).replace(/\.00$/, '')} fps</small>
          <Tag tone={review.detection === 'failed' ? 'fail' : review.detection === 'single' ? 'idle' : 'ok'}>
            {review.detection === 'failed' ? '识别失败'
              : review.shots.some((item) => item.origin === 'manual') ? `${review.shots.length} 个镜头 · 已修整`
              : review.detection === 'single' ? '一镜到底' : `${review.shots.length} 个镜头`}
          </Tag>
          {review.approved ? <Tag tone="ok">审片通过</Tag> : null}
        </div>
        {previewUrl ? <div className={styles.reviewMonitor}>
          <div className={styles.monitorFrame}>
            {comparison.candidate?.videoUrl ? <Tag>当前成片</Tag> : null}
            <video key={`${review.jobId}:${previewUrl}`} ref={video} aria-label="当前成片" className={styles.reviewVideo}
              src={previewUrl} controls preload="metadata"
              onLoadedMetadata={(event) => {
                const time = Math.max(0, positionUs / 1e6);
                event.currentTarget.currentTime = Math.min(time, event.currentTarget.duration);
              }}
              onTimeUpdate={(event) => {
                const element = event.currentTarget;
                if (playbackEnd.current !== null && element.currentTime >= playbackEnd.current) {
                  element.pause();
                  element.currentTime = playbackEnd.current;
                  playbackEnd.current = null;
                }
                setPlayheadUs(Math.round((element.currentTime) * 1e6));
              }} />
          </div>
          {comparison.candidate?.videoUrl ? <div className={styles.monitorFrame}>
            <Tag>候选片段</Tag>
            <video aria-label="候选片段" className={styles.reviewVideo} src={comparison.candidate.videoUrl} controls muted preload="metadata" />
          </div> : null}
        </div> : null}
        {comparison.seam && comparison.candidate ? <video
          aria-label="接缝预览" className={styles.reviewVideo} src={comparison.seam} controls
          onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, comparison.candidate!.replaceStartUs / 1e6 - 0.75); }}
          onTimeUpdate={(event) => {
            if (event.currentTarget.currentTime > comparison.candidate!.replaceEndUs / 1e6 + 0.75) {
              event.currentTarget.currentTime = Math.max(0, comparison.candidate!.replaceStartUs / 1e6 - 0.75);
            }
          }}
        /> : null}
        {review.detection === 'failed'
          ? <p className={styles.hintWarn}>{review.detectionError || '切点识别失败'}；整条原片仍可播放，可手动加切点。</p>
          : null}
        <section className={styles.timeline} aria-label="剪辑时间轴">
          <div className={styles.timelineHead}>
            <h3>剪辑时间轴</h3>
            <span className={`${styles.timelineClock} tnum`}>{timecode(timeForFrame(playheadFrame))} / {timecode(timelineDurationUs)}</span>
            <div className={styles.inlineActions}>
              <ToolbarButton disabled={!nextShot || posting} onClick={() => void post({ action: 'merge', shotIds: [shot?.id, nextShot?.id] })}>
                与下一镜合并
              </ToolbarButton>
              <ToolbarButton disabled={!review.undoMergeId || posting}
                onClick={() => void post({ action: 'undo-merge', mergeId: review.undoMergeId })}>撤回合并</ToolbarButton>
              <ToolbarButton icon="scissors" disabled={!canSplit || posting} onClick={() => {
                seek(splitAt);
                void post({ action: 'split', shotId: shot?.id, atUs: splitAt });
              }}>在播放头处切分</ToolbarButton>
            </div>
          </div>
          <div className={styles.timelineGrid}>
            <div className={styles.trackName}>时间</div>
            <div className={styles.timelineRuler}>
              <div className={`${styles.rulerLabels} tnum`} aria-hidden="true">
                {Array.from({ length: 6 }, (_, index) => <span key={index}>
                  {timecode(timelineDurationUs * index / 5).slice(0, -1)}
                </span>)}
              </div>
              <input className={styles.timelineScrubber} type="range" min={0} max={lastFrame} step={1}
                value={playheadFrame} aria-label="时间轴播放头" aria-valuetext={timecode(timeForFrame(playheadFrame))}
                disabled={!previewUrl || posting} onChange={(event) => scrub(Number(event.currentTarget.value))} />
            </div>
            <div className={styles.trackName}><Icon name="film" size={15} />画面</div>
            <div className={styles.videoLane}>
              {review.shots.map((item) => {
                const image = thumbnail(sampleTime(item));
                return <button key={item.id} type="button" className={styles.timelineShot}
                style={{ left: percent(item.startUs), width: percent(item.endUs - item.startUs) }}
                aria-current={item.id === shot?.id} aria-label={item.id}
                onClick={() => {
                  setSelectedShot(item.id);
                  compare(null, '');
                  seek(item.startUs);
                }}
                title={`镜头 ${item.index} · ${timecode(item.startUs)}–${timecode(item.endUs)}`}
              >
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 即时截取的本地视频帧
                  <img className={styles.shotThumbnail} src={image} alt="" draggable={false} />
                ) : <div className={styles.shotThumbnail} aria-hidden="true" />}
                <span className={styles.shotCaption}>
                  <strong>镜头 {String(item.index).padStart(2, '0')}</strong>
                  <small className="tnum">{((item.endUs - item.startUs) / 1e6).toFixed(2)} 秒</small>
                </span>
              </button>;
              })}
            </div>
              <div className={styles.trackName}><Icon name="mic" size={15} />声音</div>
              <div className={styles.audioLane}>
                <div className={styles.audioClip} style={{ left: 0 }}>
                  <Icon name="lock" size={13} />{soundMode === 'tts' ? '连续旁白与现场声' : '连续原声'}
                  <span className="tnum">{(durationUs / 1e6).toFixed(2)} 秒</span>
                </div>
              </div>
            <div className={styles.playheadLane} aria-hidden="true">
              <div className={styles.playheadLine} style={{ left: lastFrame ? `${playheadFrame / lastFrame * 100}%` : 0 }} />
            </div>
          </div>
          <div className={styles.timelineFoot}>
            {shot ? <span className="tnum">选区 {timecode(shot.startUs)}–{timecode(shot.endUs)}</span> : null}
            <span>拖动播放头预览，方向键逐帧定位</span>
          </div>
        </section>
        <div className={styles.approveBar}>
          <button type="button" className="cap cap-primary" disabled={review.approved || posting}
            onClick={() => void post({ action: 'approve' })} data-testid="one-click-film-approve">
            <Icon name="check" size={15} />
            {review.approved ? '已通过审片' : '标记审片通过'}
          </button>
        </div>
        {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
      </>}
    </div>

    <div className={styles.reviewRight} role="region" aria-label="审片操作" tabIndex={0}>
        <GroupHeading>镜头与返工范围</GroupHeading>
        {!review || !shot ? <p className={styles.hint}>在时间轴上点一个镜头。</p> : <>
          <GroupList>
            <GroupRow label="镜头">{shot.id}</GroupRow>
            <GroupRow label="区间">{timecode(shot.startUs)}–{timecode(shot.endUs)}</GroupRow>
            <GroupRow label="来源">{shot.origin === 'manual' ? '手动修整' : '实际切点'}</GroupRow>
            <GroupRow label="审片标记">{shot.reviewMark || '未标记'}</GroupRow>
          </GroupList>
          <div className={styles.reviewActions}>
            <button type="button" className="cap" onClick={() => seek(shot.startUs, shot.endUs)}>
              <Icon name="film" size={14} />播放本镜
            </button>
            <button type="button" className="cap" disabled={posting} onClick={() => void post({ action: 'mark', shotId: shot.id, mark: 'ok' })}>
              标记本镜
            </button>
          </div>
        </>}
        {review ? <>
          <ReworkPanel key={`${review.jobId}:${shot?.id ?? ''}`} projectId={state.project.id} images={state.images}
            review={review} shot={shot} reload={load} onCompare={compare}
            onAdjustSound={onAdjustSound ? () => onAdjustSound(review.entryCode) : undefined} />
        </> : null}
    </div>
  </div>;
}
