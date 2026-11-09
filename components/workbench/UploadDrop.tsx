'use client';

import { useRef, useState, type DragEvent } from 'react';
import { Icon } from '@/components/ui/Icon';
import { uploadImages } from '@/lib/image-upload-client';
import s from './workbench.module.css';

const ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * 「上传原始图片」投放区（07 号票）：**可以拖入，也可以多选**。
 *
 * 第 1 步（原始场景图 A）与第 2 步（原始分镜图）共用；上传走现有的
 * `uploadImages`（团队版走分片上传），落到 `input` + 指定的 `usage`。
 * 上传完成后把服务端返回的文件交给调用方刷新项目，本组件自己不存图。
 */
export default function UploadDrop({
  projectId,
  usage,
  label,
  hint,
  maxFiles = 20,
  onUploaded,
  solid = false,
}: {
  projectId: string;
  usage: 'scene_seed' | 'shot_source';
  label: string;
  hint?: string;
  maxFiles?: number;
  /** 上传成功后调用（一般传 `loadProject`）。 */
  onUploaded: () => void | Promise<void>;
  solid?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');

  const send = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || uploading) return;
    const files = Array.from(fileList).filter((file) => ACCEPT.split(',').includes(file.type));
    if (files.length === 0) {
      setError('请选择 PNG / JPEG / WebP 格式的图片');
      return;
    }
    if (files.length > maxFiles) {
      setError(`一次最多上传 ${maxFiles} 张`);
      return;
    }
    setError('');
    setUploading(true);
    try {
      const form = new FormData();
      files.forEach((file) => form.append('files', file));
      form.append('role', 'input');
      form.append('usage', usage);
      form.append('preprocessEnabled', 'true');
      form.append('targetMaxSide', '1536');
      form.append('jpegQuality', '85');
      form.append('projectId', projectId);
      const response = await uploadImages(form);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || body.error || `上传失败（${response.status}）`);
      }
      await onUploaded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败，请重试');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragOver(false);
    void send(event.dataTransfer.files);
  };

  return (
    <div className={s.upload}>
      <button
        type="button"
        className={`${s.drop}${solid ? ` ${s.dropSolid}` : ''}${dragOver ? ` ${s.dropOver}` : ''}`}
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        aria-label={`${label}（拖入或点击，可多选）`}
      >
        <span>{uploading ? '上传中…' : label}</span>
        {hint ? <small>{uploading ? '正在写入素材库' : hint}</small> : null}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className={s.hiddenInput}
        onChange={(event) => void send(event.target.files)}
        aria-label={label}
      />
      {error ? (
        <p className={s.errorText} role="alert">
          <Icon name="alert" size={12} /> {error}
        </p>
      ) : null}
    </div>
  );
}
