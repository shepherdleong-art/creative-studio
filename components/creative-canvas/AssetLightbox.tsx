'use client';

/**
 * 素材大图／播片预览（素材节点与任务面板共用）。
 * 点击遮罩或 Esc 关闭；下载按钮不冒泡。
 */

import { useEffect } from 'react';
import { canvasAssetUrl } from './api';

export function AssetLightbox({
  assetId,
  mediaKind,
  onClose,
  testId = 'asset-lightbox',
}: {
  assetId: string;
  mediaKind: 'image' | 'video';
  onClose: () => void;
  testId?: string;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const url = canvasAssetUrl(assetId);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-media-scrim)] p-8"
      data-testid={testId}
      onClick={onClose}
      role="presentation"
    >
      {mediaKind === 'video' ? (
        <video
          src={url}
          controls
          autoPlay
          className="max-h-full max-w-full rounded-lg"
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <img src={url} alt="素材放大" className="max-h-full max-w-full rounded-lg" />
      )}
      <a
        className="nodrag sc-canvas-button absolute bottom-6"
        href={`${url}?download=1`}
        download
        data-testid="download-material-zoom"
        onClick={(event) => event.stopPropagation()}
      >
        下载
      </a>
    </div>
  );
}
