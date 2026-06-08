'use client';

import { useCallback, useState } from 'react';

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
}: Props) {
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
    [role, files.length, maxFiles, onUploaded]
  );

  return (
    <div>
      <label className="label">
        {label}
        {files.length > 0 && (
          <span className="text-gray-400 font-normal ml-2">
            ({files.length} 张)
          </span>
        )}
      </label>
      {hint && <p className="text-xs text-gray-500 mb-2">{hint}</p>}

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
        className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
          dragOver
            ? 'border-blue-400 bg-blue-50'
            : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          id={`upload-${role}`}
        />
        <label
          htmlFor={`upload-${role}`}
          className="cursor-pointer text-sm text-gray-600"
        >
          {uploading ? (
            <span className="text-blue-600">上传中...</span>
          ) : (
            <>
              <div className="text-2xl mb-1">📁</div>
              <div>拖拽图片到此处，或点击选择</div>
              <div className="text-xs text-gray-400 mt-1">
                支持 PNG / JPEG / WebP，单文件最大 20MB
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
                className="w-full aspect-square object-cover rounded-lg border border-gray-200"
              />
              <button
                onClick={() => onRemove(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
              <div className="text-[10px] text-gray-400 truncate mt-0.5">
                {file.filename}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
