'use client';

import { useCallback, useState, useId } from 'react';
import { Icon } from '@/components/ui/Icon';

export interface UploadedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  role: string;
  relativePath: string;
  imageUrl: string;
  originalSizeBytes?: number;
  processedSizeBytes?: number;
  originalWidth?: number;
  originalHeight?: number;
  processedWidth?: number;
  processedHeight?: number;
  usage?: string;
}

interface Props {
  role: 'reference' | 'input';
  label: string;
  hint?: string;
  maxFiles?: number;
  onUploaded: (files: UploadedFile[]) => void;
  files: UploadedFile[];
  onRemove: (index: number) => void;
  preprocessEnabled?: boolean;
  targetMaxSide?: number;
  jpegQuality?: number;
  projectId?: string;
  usage?: string;
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export default function ImageUploader({
  role,
  label,
  hint,
  maxFiles = 50,
  onUploaded,
  files,
  onRemove,
  preprocessEnabled = true,
  targetMaxSide = 1536,
  jpegQuality = 85,
  projectId,
  usage,
}: Props) {
  const inputId = useId();
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;

      const imageFiles = Array.from(fileList).filter((f) =>
        ALLOWED_TYPES.includes(f.type)
      );

      if (imageFiles.length === 0) {
        alert('请选择 PNG / JPEG / WebP 格式的图片');
        return;
      }

      if (files.length + imageFiles.length > maxFiles) {
        alert(`最多上传 ${maxFiles} 张图片`);
        return;
      }

      setUploading(true);
      try {
        const form = new FormData();
        imageFiles.forEach((f) => form.append('files', f));
        form.append('role', role);
        form.append('preprocessEnabled', String(preprocessEnabled));
        form.append('targetMaxSide', String(targetMaxSide));
        form.append('jpegQuality', String(jpegQuality));
        if (projectId) form.append('projectId', projectId);
        if (usage) form.append('usage', usage);

        const res = await fetch('/api/upload', {
          method: 'POST',
          body: form,
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Upload failed (${res.status})`);
        }

        const data = await res.json();
        onUploaded(data.files);
      } catch (err) {
        alert('上传失败: ' + String(err));
      } finally {
        setUploading(false);
      }
    },
    [role, files.length, maxFiles, onUploaded, preprocessEnabled, targetMaxSide, jpegQuality, projectId, usage]
  );

  return (
    <div className="flex h-full flex-col">
      <label className="label">
        {label}
        {files.length > 0 && (
          <span className="ml-2 font-normal text-ink-tertiary">
            ({files.length} 张)
          </span>
        )}
      </label>
      {hint && <p className="mb-2 text-xs text-ink-secondary">{hint}</p>}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`flex flex-1 flex-col items-center justify-center border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
          dragOver
            ? 'border-accent bg-run-tint'
            : 'border-hairline hover:border-accent/40'
        }`}
      >
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          id={inputId}
        />
        <label
          htmlFor={inputId}
          className="cursor-pointer text-sm text-ink-secondary"
        >
          {uploading ? (
            <span className="text-accent">上传中...</span>
          ) : (
            <>
              <Icon name="folder" size={28} className="mx-auto mb-1 text-ink-tertiary" />
              <div>拖拽图片到此处，或点击选择</div>
              <div className="mt-1 text-xs text-ink-tertiary">
                支持 PNG / JPEG / WebP，大图会在本地上传后自动压缩
              </div>
            </>
          )}
        </label>
      </div>

      {files.length > 0 && (
        <div className="mt-3 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
          {files.map((file, i) => (
            <div key={file.id || i} className="relative group">
              <img
                src={file.imageUrl}
                alt={file.filename}
                className="aspect-square w-full rounded-lg border border-hairline object-cover"
              />
              <button
                onClick={() => onRemove(i)}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-fail text-white opacity-0 transition-opacity group-hover:opacity-100"
                title="移除"
                aria-label="移除图片"
              >
                <Icon name="close" size={12} />
              </button>
              <div className="mt-0.5 truncate text-[10px] text-ink-tertiary">
                {file.filename}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
