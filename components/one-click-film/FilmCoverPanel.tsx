'use client';

import { resolveFilmCoverMedia, type FilmCoverMedia } from '@/lib/one-click-film/cover-media';
import { FINAL_EDIT_FPS } from '@/lib/media-core/render-contract';
import { Tag } from '@/components/ui/Appearance';
import { Icon } from '@/components/ui/Icon';
import type { FilmReview } from './ReviewStage';
import styles from './one-click-film.module.css';

const sourceLabel = (cover: FilmCoverMedia) => {
  switch (cover.kind) {
    case 'auto_frame': return cover.fallback ? '默认首帧' : '自动挑帧';
    case 'video_frame': return '本片画面';
    case 'project_image': return '项目图片';
    case 'generated_image': return 'AI 生成';
  }
};

export function FilmCoverPanel({ media, frames, signature, shots, image, thumbnail, expanded, busy, canTakeCurrent,
  onToggle, onSelect, onTakeCurrent }: {
  media?: FilmCoverMedia;
  frames: number;
  signature: string;
  shots: FilmReview['shots'];
  image: string;
  thumbnail: (timeUs: number) => string | undefined;
  expanded: boolean;
  busy: boolean;
  canTakeCurrent: boolean;
  onToggle: () => void;
  onSelect: (media?: FilmCoverMedia) => void;
  onTakeCurrent: () => void;
}) {
  const cover = resolveFilmCoverMedia(media, { frames, signature });
  const frame = 'frame' in cover ? cover.frame : 0;
  const shotRows = shots.map(shot => {
    const first = Math.min(frames - 1, Math.round(shot.startUs * FINAL_EDIT_FPS / 1e6));
    const last = Math.max(first, Math.min(frames - 1, Math.round(shot.endUs * FINAL_EDIT_FPS / 1e6) - 1));
    return { shot, first, last, image: thumbnail(Math.round((shot.startUs + shot.endUs) / 2)) };
  });
  const selected = shotRows.find(row => frame >= row.first && frame <= row.last) ?? shotRows[0];
  const selectFrame = (next: number, shotId: string) => onSelect({ kind: 'video_frame', frame: next, shotId,
    framing: cover.kind === 'video_frame' ? cover.framing : undefined });

  return <section className={styles.filmCoverPanel} aria-label="封面底图">
    <div className={styles.filmCoverSummary}>
      <div className={styles.filmCoverThumb}>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- 服务器从当前草稿抽帧
          <img src={image} alt="当前封面底图" />
        ) : <Icon name="image" size={20} />}
      </div>
      <div className={styles.filmCoverSource}>
        <Tag tone="idle">{sourceLabel(cover)}</Tag>
        <button type="button" className="cap" aria-expanded={expanded} disabled={busy} onClick={onToggle}>更换封面</button>
      </div>
    </div>
    {media?.kind === 'video_frame' && media.frame !== frame ? <p className={styles.hint} role="status">原选帧超出正文，已定位到最后一帧。</p> : null}
    {expanded ? <>
      <div className={styles.inlineActions}>
        <button type="button" className="cap" disabled={busy || !canTakeCurrent} onClick={onTakeCurrent}>取当前播放画面</button>
        <button type="button" className="cap" disabled={busy || !media} onClick={() => onSelect()}>恢复默认封面</button>
      </div>
      <div className={styles.filmCoverShots} role="group" aria-label="本片画面">
        {shotRows.map(row => {
          const label = `镜头 ${String(row.shot.index).padStart(2, '0')}`;
          return <button key={row.shot.id} type="button" aria-pressed={'frame' in cover && row === selected} disabled={busy}
            className={styles.filmCoverShot} onClick={() => selectFrame(Math.floor((row.first + row.last) / 2), row.shot.id)}>
            {row.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- 预览解码器的镜头缩略图
              <img src={row.image} alt="" />
            ) : <Icon name="image" size={18} />}
            <span>{label}</span>
          </button>;
        })}
      </div>
      {selected ? <label className={styles.editRow}>封面帧 <output className="tnum">{(frame / FINAL_EDIT_FPS).toFixed(3)} 秒</output>
        <input type="range" aria-label="封面帧" min={selected.first} max={selected.last} step={1}
          value={Math.max(selected.first, Math.min(selected.last, frame))} disabled={busy || selected.first === selected.last}
          onChange={event => selectFrame(event.target.valueAsNumber, selected.shot.id)} />
      </label> : null}
    </> : null}
  </section>;
}
