'use client';

import { useState } from 'react';
import ImageUploader, { UploadedFile } from '@/components/ImageUploader';

export interface AssetGridItem {
  id: string;
  filename: string;
  imageUrl?: string;
  role: string;
  usage?: string;
}

interface Props {
  projectId: string;
  assets: AssetGridItem[];
  selectedIds: string[];
  usage: 'scene_seed' | 'shot_source';
  uploadTitle: string;
  uploadHint: string;
  emptyText: string;
  selectionLabel: string;
  maxSelection?: number;
  onSelectionChange: (ids: string[]) => void;
  onUploaded: (files: UploadedFile[]) => void | Promise<void>;
}

type PreviewState = { src: string; title: string; x: number; y: number } | null;

const USAGE_LABELS: Record<string, string> = {
  scene_seed: '场景图 A',
  shot_source: '原始分镜',
};

export default function AssetUploadGrid({
  projectId,
  assets,
  selectedIds,
  usage,
  uploadTitle,
  uploadHint,
  emptyText,
  selectionLabel,
  maxSelection = 1,
  onSelectionChange,
  onUploaded,
}: Props) {
  const [preview, setPreview] = useState<PreviewState>(null);

  const toggle = (id: string) => {
    if (maxSelection === 1) {
      onSelectionChange(selectedIds[0] === id ? [] : [id]);
      return;
    }
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((item) => item !== id));
      return;
    }
    if (selectedIds.length < maxSelection) onSelectionChange([...selectedIds, id]);
  };

  const previewLeft = preview
    ? Math.min(preview.x + 18, (typeof window === 'undefined' ? preview.x + 18 : window.innerWidth - 336))
    : 0;
  const previewTop = preview
    ? Math.min(preview.y + 18, (typeof window === 'undefined' ? preview.y + 18 : window.innerHeight - 276))
    : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-hairline bg-surface-subtle p-4">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-ink">{uploadTitle}</h3>
            <p className="mt-1 text-xs text-ink-secondary">{uploadHint}</p>
          </div>
          <ImageUploader
            role="input"
            usage={usage}
            label=""
            hint=""
            maxFiles={usage === 'scene_seed' ? 1 : 9}
            files={[]}
            onUploaded={onUploaded}
            onRemove={() => {}}
            preprocessEnabled={true}
            targetMaxSide={1536}
            jpegQuality={85}
            projectId={projectId}
          />
        </div>

        <div className="rounded-lg border border-hairline bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">已上传素材</h3>
              <p className="mt-1 text-xs text-ink-secondary">已上传 {assets.length} 张，{selectionLabel}</p>
            </div>
            {selectedIds.length > 0 && (
              <button type="button" onClick={() => onSelectionChange([])} className="btn-secondary btn-sm text-xs">
                清空选择
              </button>
            )}
          </div>

          {assets.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-hairline bg-surface-subtle text-sm text-ink-tertiary">
              {emptyText}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {assets.map((asset) => {
                const selectedIndex = selectedIds.indexOf(asset.id);
                const selected = selectedIndex >= 0;
                return (
                  <button
                    type="button"
                    key={asset.id}
                    onClick={() => toggle(asset.id)}
                    onMouseEnter={(event) => {
                      if (asset.imageUrl) setPreview({ src: asset.imageUrl, title: asset.filename, x: event.clientX, y: event.clientY });
                    }}
                    onMouseMove={(event) => {
                      if (asset.imageUrl) setPreview({ src: asset.imageUrl, title: asset.filename, x: event.clientX, y: event.clientY });
                    }}
                    onMouseLeave={() => setPreview(null)}
                    className={`group relative rounded-lg border bg-white p-1 text-left transition ${
                      selected ? 'border-accent ring-2 ring-accent/20' : 'border-hairline hover:border-accent/40 hover:shadow-sm'
                    }`}
                  >
                    <div className="relative aspect-square overflow-hidden rounded-md bg-surface-subtle">
                      {asset.imageUrl ? (
                        <img src={asset.imageUrl} alt={asset.filename} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-ink-tertiary">无预览</div>
                      )}
                      <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">
                        {USAGE_LABELS[asset.usage || usage] || '素材'}
                      </span>
                      {selected && (
                        <span className="absolute right-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-white">
                          {maxSelection === 1 ? '选中' : selectedIndex + 1}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate px-0.5 text-xs text-ink-secondary">{asset.filename}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {preview && (
        <div
          className="pointer-events-none fixed z-[120] w-80 rounded-xl border border-gray-700 bg-gray-950 p-2 shadow-2xl"
          style={{ left: previewLeft, top: previewTop }}
        >
          <img src={preview.src} alt={preview.title} className="max-h-60 w-full rounded-lg object-contain" />
          <div className="mt-1 truncate px-1 text-xs text-gray-200">{preview.title}</div>
        </div>
      )}
    </div>
  );
}
