'use client';

import { useRef, useState } from 'react';
import { EmptyState, GroupList, GroupRow, Tag } from '@/components/ui/Appearance';
import { Icon } from '@/components/ui/Icon';
import { analysisSourceIds, DETAIL_USAGE, SCENE_USAGE, type FilmImage, type FilmState } from './types';
import styles from './one-click-film.module.css';

/**
 * 第二步 · 上传素材：场景图与详情页分区添加、预览、移除。
 * 至少一份素材就能发起分析；换图后需要重新分析。
 */
export function UploadStage({
  state,
  busy,
  onChange,
  onAnalyze,
  onOpenAnalysis,
}: {
  state: FilmState;
  busy: boolean;
  onChange: () => Promise<void>;
  onAnalyze: () => void;
  onOpenAnalysis: () => void;
}) {
  const scene = state.images.filter((image) => image.usage === SCENE_USAGE);
  const detail = state.images.filter((image) => image.usage === DETAIL_USAGE);
  const total = analysisSourceIds(state).length;
  const hasResult = state.analysis?.status === 'succeeded';

  return <div className={styles.stage}>
    <div className={styles.stageBody}>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <b>场景图</b>
          <small>用来核对产品外观；一张就能开始分析。</small>
          <UploadButton usage={SCENE_USAGE} projectId={state.project.id} disabled={busy} onChange={onChange} label="添加场景图" />
        </div>
        <ImageGrid images={scene} disabled={busy} onChange={onChange} empty="还没有场景图。先放一张产品实拍，换场景时会保持产品不变。" />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <b>详情页</b>
          <small>用来支撑具体功能主张，可放多张。</small>
          <UploadButton usage={DETAIL_USAGE} projectId={state.project.id} disabled={busy} onChange={onChange} label="添加详情页" />
        </div>
        <ImageGrid images={detail} disabled={busy} onChange={onChange} empty="还没有详情页。只有外观依据时，脚本不会写具体功能主张。" />
      </section>
    </div>

    <div className={styles.stageFoot}>
      {total === 0 ? (
        <p className={styles.hintWarn} role="status">先上传至少一份素材，才能分析卖点。</p>
      ) : hasResult ? (
        <p className={styles.hint}>已有分析结果，可以直接回看；换图后需要重新分析。</p>
      ) : (
        <p className={styles.hint}>已收录 {total} 份素材，可以开始识别产品名称与卖点。</p>
      )}
      <div className={styles.footActions}>
        {hasResult && <button type="button" className="cap" onClick={onOpenAnalysis}>查看已有结果</button>}
        <button
          type="button"
          className="cap cap-primary"
          disabled={total === 0 || busy}
          onClick={onAnalyze}
          data-testid="one-click-film-analyze"
        >
          {busy ? '分析中…' : `分析 ${total} 份素材`}
        </button>
      </div>
    </div>
  </div>;
}

function UploadButton({
  usage,
  projectId,
  disabled,
  onChange,
  label,
}: {
  usage: string;
  projectId: string;
  disabled: boolean;
  onChange: () => Promise<void>;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append('files', file);
      form.append('role', 'input');
      form.append('projectId', projectId);
      form.append('usage', usage);
      const response = await fetch('/api/upload', { method: 'POST', body: form });
      const body = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(body.message || body.error || '上传失败');
      await onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return <div className={styles.upload}>
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      hidden
      onChange={(event) => void upload(event.target.files)}
    />
    <button type="button" className="cap" disabled={disabled || uploading} onClick={() => input.current?.click()}>
      <Icon name="image" size={14} />{uploading ? '上传中…' : label}
    </button>
    {error ? <small className={styles.hintFail}>{error}</small> : null}
  </div>;
}

function ImageGrid({
  images,
  disabled,
  onChange,
  empty,
}: {
  images: FilmImage[];
  disabled: boolean;
  onChange: () => Promise<void>;
  empty: string;
}) {
  const [error, setError] = useState('');

  const remove = async (image: FilmImage) => {
    setError('');
    try {
      const response = await fetch(`/api/images/${image.id}`, { method: 'DELETE' });
      const body = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(body.message || body.error || '移除失败');
      await onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (images.length === 0) {
    return <EmptyState icon="image" title="还没有图片" description={empty} />;
  }

  return <div className={styles.grid}>
    {images.map((image) => <figure key={image.id} className={styles.tile}>
      <img src={image.url} alt={image.filename} loading="lazy" />
      <figcaption title={image.filename}>{image.filename}</figcaption>
      <button type="button" className={styles.tileRemove} disabled={disabled} onClick={() => void remove(image)} aria-label={`移除 ${image.filename}`}>
        <Icon name="trash" size={13} />
      </button>
    </figure>)}
    {error ? <p className={styles.hintFail}>{error}</p> : null}
  </div>;
}

/** 分析页的素材来源摘要：确认时用来核对每条卖点来自哪张图。 */
export function SourceSummary({ images }: { images: FilmImage[] }) {
  return <GroupList>
    {images.map((image) => <GroupRow key={image.id} label={<span className={styles.sourceName}><img src={image.url} alt="" />{image.filename}</span>}>
      <Tag tone="idle">{image.usage === DETAIL_USAGE ? '详情页' : '场景图'}</Tag>
    </GroupRow>)}
  </GroupList>;
}
