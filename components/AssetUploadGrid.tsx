'use client';

import { useState } from 'react';
import ImageUploader, { UploadedFile } from '@/components/ImageUploader';
import { Icon } from '@/components/ui/Icon';

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
  onDelete?: (assetId: string) => void | Promise<void>;
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
  onDelete,
}: Props) {
  const [preview, setPreview] = useState<PreviewState>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAssets = normalizedQuery
    ? assets.filter((asset) => asset.filename.toLowerCase().includes(normalizedQuery))
    : assets;

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

  const handleDelete = async (e: React.MouseEvent, assetId: string) => {
    e.stopPropagation();
    if (!onDelete || deletingId) return;
    setDeletingId(assetId);
    try {
      await onDelete(assetId);
    } finally {
      setDeletingId(null);
    }
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
        <div className="flex flex-col rounded-lg border border-hairline bg-surface-subtle p-4">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-ink">{uploadTitle}</h3>
            <p className="mt-1 text-xs text-ink-secondary">{uploadHint}</p>
          </div>
          <div className="flex flex-1 flex-col">
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
        </div>

        <div className="rounded-[18px] border border-hairline bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">已上传素材</h3>
              <p className="mt-1 text-xs text-ink-secondary">
                已上传 {assets.length} 张{normalizedQuery ? `，筛选出 ${filteredAssets.length} 张` : ''}，{selectionLabel}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {assets.length > 0 && (
                <div className="relative w-full sm:w-56">
                  <Icon
                    name="search"
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="按文件名搜索…"
                    className="input-field pr-7 text-xs"
                    style={{ paddingLeft: '2rem' }}
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-tertiary transition hover:text-ink"
                      title="清除搜索"
                      aria-label="清除搜索"
                    >
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              )}
              {selectedIds.length > 0 && (
                <button type="button" onClick={() => onSelectionChange([])} className="btn-secondary btn-sm text-xs whitespace-nowrap">
                  清空选择
                </button>
              )}
            </div>
          </div>

          {assets.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-hairline bg-surface-subtle text-sm text-ink-tertiary">
              {emptyText}
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-hairline bg-surface-subtle text-sm text-ink-tertiary">
              没有匹配「{query}」的素材
            </div>
          ) : (
            <div className="max-h-[420px] overflow-y-auto overscroll-contain rounded-[14px] p-1 pr-2">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                {filteredAssets.map((asset) => {
                const selectedIndex = selectedIds.indexOf(asset.id);
                const selected = selectedIndex >= 0;
                const isDeleting = deletingId === asset.id;
                return (
                  <div
                    key={asset.id}
                    className={`group relative ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(asset.id)}
                      onMouseEnter={(event) => {
                        if (!asset.imageUrl) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        setPreview({ src: asset.imageUrl, title: asset.filename, x: rect.right, y: rect.top });
                      }}
                      onMouseLeave={() => setPreview(null)}
                      className={`w-full rounded-[18px] border p-2 text-left transition ${
                        selected ? 'border-accent bg-white shadow-sm ring-2 ring-accent/20' : 'border-transparent bg-surface-subtle hover:border-accent/30 hover:bg-white hover:shadow-sm'
                      }`}
                    >
                      <div className="relative aspect-[4/3] overflow-hidden rounded-[14px] bg-surface">
                        {asset.imageUrl ? (
                          <img src={asset.imageUrl} alt={asset.filename} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-ink-tertiary">无预览</div>
                        )}
                        <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">
                          {USAGE_LABELS[asset.usage || usage] || '素材'}
                        </span>
                        {selected && (
                          <span className="absolute right-2 top-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-accent px-2 text-xs font-semibold text-white shadow-sm">
                            {maxSelection === 1 ? '选中' : selectedIndex + 1}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 truncate px-1 text-xs font-medium text-ink-secondary">{asset.filename}</div>
                    </button>
                    {onDelete && (
                      <button
                        type="button"
                        onClick={(e) => handleDelete(e, asset.id)}
                        className={`absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition hover:bg-fail group-hover:opacity-100 ${
                          isDeleting ? 'opacity-100' : 'opacity-0'
                        } max-md:opacity-60`}
                        title="删除此图片"
                        aria-label={`删除 ${asset.filename}`}
                      >
                        {isDeleting ? (
                          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        ) : (
                          <Icon name="close" size={14} />
                        )}
                      </button>
                    )}
                  </div>
                );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {preview && (
        <div
          className="theme-preview-popover w-80"
          style={{ left: previewLeft, top: previewTop }}
        >
          <img src={preview.src} alt={preview.title} className="max-h-60 w-full rounded-lg object-contain" />
          <div className="theme-preview-caption px-1 text-xs">{preview.title}</div>
        </div>
      )}
    </div>
  );
}
