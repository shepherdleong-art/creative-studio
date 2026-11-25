'use client';

import { useCallback, useState } from 'react';
import { GroupHeading, GroupList, GroupRow, ToolbarButton } from '@/components/ui/Appearance';
import type { ReviewShot, ReviewState } from '@/lib/one-click-film/review';
import type { ReworkCandidate } from '@/lib/one-click-film/rework';
import type { FilmImage } from './types';
import { ReworkPanel } from './ReworkPanel';
import styles from './one-click-film.module.css';

export type FilmReview = ReviewState & {
  entryId: string;
  draft: boolean;
  hdApproved: boolean;
  hdVideoUrl: string | null;
  undoMergeId: string | null;
};

export function ShotInspector({ projectId, images, review, shot, positionUs, busy, reload, onPlay, onAdjustSound }: {
  projectId: string;
  images: FilmImage[];
  review: FilmReview;
  shot: ReviewShot;
  positionUs: number;
  busy: boolean;
  reload: () => Promise<void>;
  onPlay: () => void;
  onAdjustSound: () => void;
}) {
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [comparison, setComparison] = useState<{ candidate: ReworkCandidate | null; seam: string }>({ candidate: null, seam: '' });
  const compare = useCallback((candidate: ReworkCandidate | null, seam: string) => setComparison({ candidate, seam }), []);
  const { candidate, seam } = comparison;
  const next = review.shots[review.shots.indexOf(shot) + 1];
  const post = async (action: string, fields: object) => {
    setPosting(true);
    setError('');
    try {
      const response = await fetch(`/api/one-click-film/${projectId}/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, jobId: review.jobId, ...fields }) });
      if (!response.ok) throw new Error((await response.json()).message || '镜头操作失败');
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPosting(false); }
  };
  const locked = busy || posting;
  return <section role="region" aria-label="审片操作" className={styles.reviewSectionBody}>
    <GroupHeading>镜头与返工范围</GroupHeading>
    <GroupList>
      <GroupRow label="镜头">{shot.id}</GroupRow>
      <GroupRow label="正文区间">{(shot.startUs / 1e6).toFixed(2)}–{(shot.endUs / 1e6).toFixed(2)} 秒</GroupRow>
      <GroupRow label="来源">{shot.origin === 'manual' ? '手动修整' : '实际切点'}</GroupRow>
      <GroupRow label="审片标记">{shot.reviewMark || '未标记'}</GroupRow>
    </GroupList>
    {review.detection === 'failed' && <p className={styles.hintWarn}>{review.detectionError || '切点识别失败，可手动切分镜头。'}</p>}
    <div className={styles.inlineActions}>
      <ToolbarButton disabled={locked} onClick={onPlay}>播放本镜</ToolbarButton>
      <ToolbarButton disabled={locked} onClick={() => void post('mark', { shotId: shot.id, mark: 'ok' })}>标记本镜</ToolbarButton>
      <ToolbarButton disabled={locked || !next} onClick={() => void post('merge', { shotIds: [shot.id, next?.id] })}>与下一镜合并</ToolbarButton>
      <ToolbarButton disabled={locked || !review.undoMergeId} onClick={() => void post('undo-merge', { mergeId: review.undoMergeId })}>撤回合并</ToolbarButton>
      <ToolbarButton disabled={locked || positionUs <= shot.startUs + 100000 || positionUs >= shot.endUs - 100000}
        onClick={() => void post('split', { shotId: shot.id, atUs: positionUs })}>在播放头处切分</ToolbarButton>
    </div>
    <ReworkPanel projectId={projectId} images={images} review={review} shot={shot}
      reload={reload} onCompare={compare} onAdjustSound={onAdjustSound} />
    {candidate?.videoUrl && <video className={styles.reviewVideo} aria-label="候选片段" src={candidate.videoUrl} controls muted />}
    {candidate && seam && <video className={styles.reviewVideo} aria-label="接缝预览" src={seam} controls
      onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, candidate.replaceStartUs / 1e6 - 0.75); }}
      onTimeUpdate={(event) => {
        if (event.currentTarget.currentTime > candidate.replaceEndUs / 1e6 + 0.75)
          event.currentTarget.currentTime = Math.max(0, candidate.replaceStartUs / 1e6 - 0.75);
      }} />}
    {error && <p role="alert" className={styles.hintFail}>{error}</p>}
  </section>;
}
