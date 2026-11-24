'use client';

import { useState } from 'react';
import { AssetLightbox } from './AssetLightbox';
import { canvasAssetUrl } from './api';

export function formatTaskElapsed(createdAt: string, completedAt?: string): string | null {
  if (!completedAt) return null;
  const ms = Date.parse(completedAt) - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? '<1S' : `${Math.round(ms / 1000)}S`;
}

export function TaskResultThumbnail({ assetId, mediaKind, label, testId, className = '' }: {
  assetId: string;
  mediaKind: 'image' | 'video';
  label: string;
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const url = canvasAssetUrl(assetId);
  return <>
    <button type="button" className={`sc-canvas-task-thumb ${className}`} data-testid={testId}
      aria-label={label} onClick={() => setOpen(true)}>
      {mediaKind === 'image' ? <img src={url} alt="" loading="lazy" /> : <>
        <video src={url} muted playsInline preload="metadata" />
        <span className="sc-canvas-task-thumb-badge" aria-hidden>▶</span>
      </>}
    </button>
    {open && <AssetLightbox assetId={assetId} mediaKind={mediaKind} onClose={() => setOpen(false)} testId="task-lightbox" />}
  </>;
}
