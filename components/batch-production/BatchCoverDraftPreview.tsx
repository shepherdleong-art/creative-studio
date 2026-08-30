'use client';

import { useEffect, useRef, useState } from 'react';
import type { FrozenBatchCoverTitleConfig } from '@/lib/batch-production/cover-title';
import { coverFramingGeometry } from '@/lib/media-core/cover-framing';
import { textStyleToSvgElements } from '@/lib/media-core/cover-title-svg';
import type { CoverFraming } from '@/lib/media-core/cover-types';
import { OUTPUT_PRESETS, type OutputPresetId } from '@/lib/final-edit/types';

export interface BatchCoverPreviewAsset {
  assetId: string;
  displayName: string;
  thumbnailUrl?: string;
  previewUrl?: string;
}

interface SourceDimensions {
  key: string;
  width: number;
  height: number;
}

interface BatchCoverDraftPreviewProps {
  asset: BatchCoverPreviewAsset | null;
  timeUs: number;
  title: FrozenBatchCoverTitleConfig | null;
  framing?: CoverFraming | null;
  outputPreset: OutputPresetId;
  className?: string;
  fill?: boolean;
}

/**
 * 封面素材选择/拖动时的即时预览。底图取冻结素材代理，标题层直接复用
 * 正式渲染的 SVG 构造，避免「弹窗看到一套、成片渲染另一套」的偏差。
 */
export default function BatchCoverDraftPreview({
  asset,
  timeUs,
  title,
  framing,
  outputPreset,
  className = '',
  fill = false,
}: BatchCoverDraftPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sourceDimensions, setSourceDimensions] = useState<SourceDimensions | null>(null);
  const outputSize = OUTPUT_PRESETS[outputPreset];
  const sourceKey = asset ? `${asset.assetId}:${asset.previewUrl ?? asset.thumbnailUrl ?? ''}` : '';
  const resolvedFraming = framing ?? title?.framing ?? { scale: 1, offsetX: 0, offsetY: 0 };
  const sourceSize = sourceDimensions?.key === sourceKey ? sourceDimensions : null;
  const frameGeometry = sourceSize
    ? coverFramingGeometry({
      sourceWidth: sourceSize.width,
      sourceHeight: sourceSize.height,
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
      framing: resolvedFraming,
    })
    : null;
  const frameStyle = frameGeometry ? {
    width: `${(frameGeometry.resizedWidth / outputSize.width) * 100}%`,
    height: `${(frameGeometry.resizedHeight / outputSize.height) * 100}%`,
    left: `${-(frameGeometry.left / outputSize.width) * 100}%`,
    top: `${-(frameGeometry.top / outputSize.height) * 100}%`,
    // Tailwind preflight caps media at max-width: 100%, which would clip the
    // enlarged frame on the right after applying the centered negative offset.
    maxWidth: 'none',
  } : undefined;
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
    const readDimensions = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setSourceDimensions({ key: sourceKey, width: video.videoWidth, height: video.videoHeight });
      }
      seek();
    };
    seek();
    readDimensions();
    video.addEventListener('loadedmetadata', readDimensions);
    return () => video.removeEventListener('loadedmetadata', readDimensions);
  }, [asset?.previewUrl, sourceKey, timeUs]);

  if (!asset) {
    return (
      <div className={`${fill ? 'absolute inset-0 h-full w-full' : 'flex aspect-[3/4]'} items-center justify-center rounded-xl bg-surface-subtle text-xs text-ink-tertiary ${className}`} aria-label="封面实时预览">
        选择素材后预览封面
      </div>
    );
  }

  return (
    <figure
      className={fill
        ? `absolute inset-0 h-full w-full overflow-hidden bg-ink ${className}`
        : `relative mx-auto w-full max-w-full overflow-hidden rounded-xl bg-ink ${className}`}
      style={fill ? undefined : { aspectRatio: `${outputSize.width} / ${outputSize.height}` }}
      aria-label="封面实时预览"
    >
      {asset.previewUrl ? (
        <video
          ref={videoRef}
          key={asset.assetId}
          className={`absolute ${frameStyle ? '' : 'inset-0 h-full w-full'} object-cover`}
          style={frameStyle}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              setSourceDimensions({ key: sourceKey, width: video.videoWidth, height: video.videoHeight });
            }
          }}
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
        <img
          src={asset.thumbnailUrl}
          alt={`${asset.displayName} 封面底图预览`}
          className={`absolute ${frameStyle ? '' : 'inset-0 h-full w-full'} object-cover`}
          style={frameStyle}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setSourceDimensions({ key: sourceKey, width: image.naturalWidth, height: image.naturalHeight });
            }
          }}
        />
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
