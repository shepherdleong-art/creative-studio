'use client';

/**
 * 素材大图／播片预览（素材节点与任务面板共用）。
 * 在文档顶层展示原图，避开 React Flow 节点的缩放和裁切。
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  const url = canvasAssetUrl(assetId);
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label={mediaKind === 'video' ? '视频全屏预览' : '图片全屏预览'}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden border-0 bg-media-scrim px-4 py-14 text-media-foreground backdrop:bg-transparent"
      data-testid={testId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        aria-label="关闭全屏预览"
        className="absolute top-3 right-4 grid size-9 place-items-center rounded-full border border-media-control-border bg-media-control hover:bg-media-scrim"
        onClick={onClose}
      >
        <Icon name="close" size={20} />
      </button>
      {mediaKind === 'video' ? (
        <video
          src={url}
          controls
          autoPlay
          className="mx-auto block h-full max-w-full object-contain"
        />
      ) : (
        <img src={url} alt="素材放大" className="pointer-events-none h-full w-full object-contain" />
      )}
      <a
        className="sc-canvas-button absolute bottom-3 left-1/2 -translate-x-1/2"
        href={`${url}?download=1`}
        download
        data-testid="download-material-zoom"
      >
        下载
      </a>
    </dialog>,
    document.body,
  );
}
