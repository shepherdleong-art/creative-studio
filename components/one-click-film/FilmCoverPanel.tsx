'use client';

import { useState } from 'react';
import { resolveFilmCoverMedia, type FilmCoverMedia } from '@/lib/one-click-film/cover-media';
import { FINAL_EDIT_FPS } from '@/lib/media-core/render-contract';
import { Segmented, Tag } from '@/components/ui/Appearance';
import { Icon } from '@/components/ui/Icon';
import type { OneClickFilmTemplateId } from '@/lib/one-click-film/packaging-constants';
import { FilmCoverGenerationPanel } from './FilmCoverGenerationPanel';
import type { FilmReview } from './ReviewStage';
import { DETAIL_USAGE, SCENE_USAGE, type FilmImage } from './types';
import styles from './one-click-film.module.css';

const sourceLabel = (cover: FilmCoverMedia) => {
  switch (cover.kind) {
    case 'auto_frame': return cover.fallback ? '默认首帧' : '自动挑帧';
    case 'video_frame': return '本片画面';
    case 'project_image': return '项目图片';
    case 'generated_image': return 'AI 生成';
  }
};

export function FilmCoverPanel({ media, frames, signature, shots, image, thumbnail, expanded, busy, canTakeCurrent, projectId, images, entryCode, template,
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
  projectId: string;
  images: FilmImage[];
  entryCode: string;
  template: OneClickFilmTemplateId;
  onToggle: () => void;
  onSelect: (media?: FilmCoverMedia) => void;
  onTakeCurrent: () => void;
}) {
  const cover = resolveFilmCoverMedia(media, { frames, signature });
  const [sourceTab, setSourceTab] = useState<'video' | 'project' | 'generate'>(cover.kind === 'generated_image' ? 'generate' : cover.kind === 'project_image' ? 'project' : 'video');
  const projectImages = images.filter(item => item.usage === SCENE_USAGE || item.usage === DETAIL_USAGE);
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
        <button type="button" className="cap" disabled={busy || !media} onClick={() => onSelect()}>恢复默认封面</button>
      </div>
      <Segmented value={sourceTab} onChange={setSourceTab} size="small" label="封面来源"
        options={[{ value: 'video', label: '本片画面' }, { value: 'project', label: '项目图片' }, { value: 'generate', label: 'AI 生成全景' }]} />
      {sourceTab === 'video' ? <div className={styles.filmCoverPanelContent} role="tabpanel" aria-label="本片画面">
        <div className={styles.inlineActions}>
          <button type="button" className="cap" disabled={busy || !canTakeCurrent} onClick={onTakeCurrent}>取当前播放画面</button>
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
      </div> : sourceTab === 'project' ? <div role="tabpanel" aria-label="项目图片">
        {projectImages.length ? <div className={styles.filmCoverShots}>
          {projectImages.map(item => {
            const usage = item.usage === SCENE_USAGE ? '场景图' : '详情页图';
            return <button type="button" key={item.id} className={styles.filmCoverShot} title={item.filename}
              aria-label={`${usage} ${item.filename}`} aria-pressed={cover.kind === 'project_image' && cover.assetId === item.id}
              disabled={busy} onClick={() => onSelect({ kind: 'project_image', assetId: item.id,
                framing: cover.kind === 'project_image' && cover.assetId === item.id ? cover.framing : undefined })}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 项目内的受权缩略图，避免加载原图 */}
              <img src={`/api/one-click-film/${encodeURIComponent(projectId)}/packaging?coverThumbnail=${encodeURIComponent(item.id)}`} alt="" loading="lazy" />
              <span>{usage}</span><span className={styles.filmCoverFilename}>{item.filename}</span>
            </button>;
          })}
        </div> : <p className={styles.hint}>暂无项目图片。可在「素材与脚本」上传场景图或详情页图片。</p>}
      </div> : <FilmCoverGenerationPanel projectId={projectId} entryCode={entryCode} template={template} images={projectImages}
        cover={cover} busy={busy} onSelect={onSelect} />}
    </> : null}
  </section>;
}
