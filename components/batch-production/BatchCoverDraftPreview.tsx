'use client';

import { useEffect, useRef } from 'react';
import type { FrozenBatchCoverTitleConfig } from '@/lib/batch-production/cover-title';
import { textStyleToSvgElements } from '@/lib/media-core/cover-title-svg';
import { OUTPUT_PRESETS, type OutputPresetId } from '@/lib/final-edit/types';

export interface BatchCoverPreviewAsset {
  assetId: string;
  displayName: string;
  thumbnailUrl?: string;
  previewUrl?: string;
}

interface BatchCoverDraftPreviewProps {
  asset: BatchCoverPreviewAsset | null;
  timeUs: number;
  title: FrozenBatchCoverTitleConfig | null;
  outputPreset: OutputPresetId;
  className?: string;
}

/**
 * 封面素材选择/拖动时的即时预览。底图取冻结素材代理，标题层直接复用
 * 正式渲染的 SVG 构造，避免「弹窗看到一套、成片渲染另一套」的偏差。
 */
export default function BatchCoverDraftPreview({
  asset,
  timeUs,
  title,
  outputPreset,
  className = '',
}: BatchCoverDraftPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const outputSize = OUTPUT_PRESETS[outputPreset];
  const previewSvg = title
    ? [
      title.primary.trim() ? textStyleToSvgElements(title.styles.primary, title.primary, outputSize) : '',
      title.secondary.trim() ? textStyleToSvgElements(title.styles.secondary, title.secondary, outputSize) : '',
    ].join('')
    : '';

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const seek = () => {
      if (Number.isFinite(timeUs) && timeUs >= 0) video.currentTime = timeUs / 1_000_000;
    };
    seek();
    video.addEventListener('loadedmetadata', seek);
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [asset?.previewUrl, timeUs]);

  if (!asset) {
    return (
      <div className={`flex aspect-[3/4] items-center justify-center rounded-xl bg-surface-subtle text-xs text-ink-tertiary ${className}`} aria-label="封面实时预览">
        选择素材后预览封面
      </div>
    );
  }

  return (
    <figure
      className={`relative mx-auto w-full max-w-sm overflow-hidden rounded-xl bg-ink ${className}`}
      style={{ aspectRatio: `${outputSize.width} / ${outputSize.height}` }}
      aria-label="封面实时预览"
    >
      {asset.previewUrl ? (
        <video
          ref={videoRef}
          key={asset.assetId}
          className="absolute inset-0 h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
          poster={asset.thumbnailUrl}
          aria-label={`${asset.displayName} 封面底图预览`}
        >
          <source src={asset.previewUrl} type="video/mp4" />
        </video>
      ) : asset.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.thumbnailUrl} alt={`${asset.displayName} 封面底图预览`} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-surface/70">暂无底图预览</div>
      )}
      {previewSvg && (
        <svg
          viewBox={`0 0 ${outputSize.width} ${outputSize.height}`}
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="封面标题实时预览"
          className="pointer-events-none absolute inset-0 h-full w-full"
          dangerouslySetInnerHTML={{ __html: previewSvg }}
        />
      )}
    </figure>
  );
}
