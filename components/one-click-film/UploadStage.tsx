'use client';

import { useRef, useState, type DragEvent } from 'react';
import { GroupList, GroupRow, Tag, ToolbarButton } from '@/components/ui/Appearance';
import { Icon } from '@/components/ui/Icon';
import { uploadImages } from '@/lib/image-upload-client';
import { analysisSourceIds, DETAIL_USAGE, SCENE_USAGE, type FilmImage, type FilmState } from './types';
import styles from './one-click-film.module.css';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

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
  const activeMutation = useRef(false);
  const [updating, setUpdating] = useState(false);

  const mutate = async (request: () => Promise<Response>, fallback: string) => {
    if (busy || activeMutation.current) return;
    activeMutation.current = true;
    setUpdating(true);
    try {
      const response = await request();
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        throw new Error(body?.message || body?.error || fallback);
      }
      await onChange();
    } finally {
      activeMutation.current = false;
      setUpdating(false);
    }
  };

  return <div className={styles.materials}>
    <div className={styles.stageTitle}>
      <div>
        <h2>产品素材</h2>
        <p className={styles.hint}>场景图用来核对产品外观，详情页用来提取卖点。</p>
      </div>
      <div className={styles.inlineActions}>
        {hasResult && <ToolbarButton onClick={onOpenAnalysis}>查看已有结果</ToolbarButton>}
        <button
          type="button"
          className="cap cap-primary"
          disabled={total === 0 || busy || updating}
          onClick={onAnalyze}
          data-testid="one-click-film-analyze"
        >
          <Icon name="sparkle" size={15} />
          {busy ? '分析中…' : `分析 ${total} 份素材`}
        </button>
      </div>
    </div>
    <div className={styles.materialCards}>
      <MaterialCard title="场景图" usage={SCENE_USAGE} projectId={state.project.id} images={scene}
        disabled={busy || updating} mutate={mutate} />
      <MaterialCard title="详情页" usage={DETAIL_USAGE} projectId={state.project.id} images={detail}
        disabled={busy || updating} mutate={mutate} />
    </div>
    {total === 0 ? <p className={styles.hint}>上传至少一张图片即可开始分析。</p> : null}
  </div>;
}

function MaterialCard({
  title,
  usage,
  projectId,
  images,
  disabled,
  mutate,
}: {
  title: string;
  usage: string;
  projectId: string;
  images: FilmImage[];
  disabled: boolean;
  mutate: (request: () => Promise<Response>, fallback: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const label = `添加${title}`;

  const upload = async (files: FileList | null) => {
    if (disabled || !files?.length) return;
    const selected = Array.from(files);
    if (selected.some((file) => file.type ? !IMAGE_TYPES.includes(file.type) : !/\.(png|jpe?g|webp)$/i.test(file.name))) {
      setError('请选择 PNG、JPEG 或 WebP 图片。');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      for (const file of selected) form.append('files', file);
      form.append('role', 'input');
      form.append('projectId', projectId);
      form.append('usage', usage);
      await mutate(() => uploadImages(form), '上传失败');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (image: FilmImage) => {
    setError('');
    try {
      await mutate(() => fetch(`/api/images/${image.id}`, { method: 'DELETE' }), '移除失败');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files');

  return <section className={styles.materialCard} aria-label={title} data-drag-over={dragOver && !disabled}
    onDragEnter={(event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragOver(true);
    }}
    onDragOver={(event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    }}
    onDragLeave={(event) => {
      if (!isFileDrag(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragOver(false);
    }}
    onDrop={(event) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      void upload(event.dataTransfer.files);
    }}
  >
    <div className={styles.materialHead}>
      <h3>{title}</h3>
      <span className={`${styles.hint} tnum`}>{images.length} 张</span>
      <ToolbarButton icon="upload" disabled={disabled} onClick={() => input.current?.click()}>
        {uploading ? '上传中…' : label}
      </ToolbarButton>
    </div>
    <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} multiple aria-label={label} hidden
      onChange={(event) => { void upload(event.currentTarget.files); event.currentTarget.value = ''; }} />
    <div className={styles.materialBody}>
      {images.length ? <div className={styles.grid}>
        {images.map((image) => <figure key={image.id} className={styles.tile}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt={image.filename} loading="lazy" />
          <figcaption title={image.filename}>{image.filename}</figcaption>
          <button type="button" className="icon-btn" disabled={disabled} onClick={() => void remove(image)} aria-label={`移除 ${image.filename}`}>
            <Icon name="trash" size={14} />
          </button>
        </figure>)}
      </div> : <button type="button" className={styles.materialDrop} aria-label={`拖入或选择${title}`}
        disabled={disabled} onClick={() => input.current?.click()}>
        <Icon name="upload" size={20} />
        <strong>{uploading ? '正在上传…' : `拖入${title}，或点击选择`}</strong>
        <small>PNG、JPEG、WebP，可多选</small>
      </button>}
      {error ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    </div>
  </section>;
}

/** 分析页的素材来源摘要：确认时用来核对每条卖点来自哪张图。 */
export function SourceSummary({ images }: { images: FilmImage[] }) {
  return <GroupList>
    {images.map((image) => <GroupRow key={image.id} label={<span className={styles.sourceName}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt="" />{image.filename}
    </span>}>
      <Tag tone="idle">{image.usage === DETAIL_USAGE ? '详情页' : '场景图'}</Tag>
    </GroupRow>)}
  </GroupList>;
}
