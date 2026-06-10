'use client';

import { useState } from 'react';

export interface ImagePickerItem {
  id: string;
  label: string;
  filename?: string;
  imageUrl?: string;
  disabled?: boolean;
}

interface Props {
  items: ImagePickerItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  emptyText: string;
}

export default function ImagePickerGrid({ items, selectedId, onSelect, emptyText }: Props) {
  const [preview, setPreview] = useState<{ item: ImagePickerItem; x: number; y: number } | null>(null);

  if (items.length === 0) {
    return <p className="text-sm text-gray-400">{emptyText}</p>;
  }

  const left = preview ? Math.min(preview.x + 16, window.innerWidth - 340) : 0;
  const top = preview ? Math.min(preview.y + 16, window.innerHeight - 300) : 0;

  return (
    <div className="relative">
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              onClick={() => onSelect(item.id)}
              onMouseEnter={(e) => setPreview({ item, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setPreview({ item, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setPreview(null)}
              className={`text-left rounded-lg border-2 overflow-hidden bg-white transition-all ${
                selected
                  ? 'border-blue-500 ring-2 ring-blue-100'
                  : 'border-gray-200 hover:border-blue-300'
              } ${item.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <div className="aspect-square bg-gray-100">
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.label} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
                    无预览
                  </div>
                )}
              </div>
              <div className="p-2">
                <div className="text-xs font-medium truncate">{item.label}</div>
                {item.filename && <div className="text-[10px] text-gray-400 truncate">{item.filename}</div>}
              </div>
            </button>
          );
        })}
      </div>

      {preview?.item.imageUrl && (
        <div
          className="fixed z-[120] pointer-events-none rounded-lg border border-gray-700 bg-gray-900/95 p-2 shadow-2xl"
          style={{ left, top, width: 320 }}
        >
          <img
            src={preview.item.imageUrl}
            alt={preview.item.label}
            className="max-h-[260px] w-full object-contain rounded"
          />
          <div className="mt-1 truncate text-[11px] text-gray-100">{preview.item.label}</div>
        </div>
      )}
    </div>
  );
}
