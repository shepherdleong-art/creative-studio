import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';
import Image from 'next/image';
import { Icon } from '@/components/ui/Icon';
import styles from './MixcutPanel.module.css';

export interface MaterialCardView {
  key: string;
  filename: string;
  durationUs: number;
  width: number;
  height: number;
  thumbnailUrl: string | null;
  source: 'module4' | 'external';
  status: 'ready' | 'missing' | 'failed';
  errorMessage?: string | null;
}

function formatDuration(durationUs: number): string {
  if (!durationUs) return '待探测';
  const seconds = durationUs / 1_000_000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.webm'] as const;

function isSupportedVideoFile(file: File): boolean {
  const filename = file.name.toLowerCase();
  return SUPPORTED_VIDEO_EXTENSIONS.some((extension) => filename.endsWith(extension));
}

export function MaterialStep({
  shotSetName,
  materials,
  selectedMaterialKeys,
  onToggle,
  onSelectAll,
  onClear,
  onRefresh,
  onImportFiles,
  importDisabledReason,
  loading,
}: {
  shotSetName: string;
  materials: MaterialCardView[];
  selectedMaterialKeys: string[];
  onToggle: (materialKey: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onRefresh: () => void;
  onImportFiles?: (files: File[]) => void;
  importDisabledReason?: string;
  loading?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const selected = new Set(selectedMaterialKeys);
  const importEnabled = Boolean(onImportFiles) && !loading;

  const submitFiles = (files: File[]) => {
    const supported = files.filter(isSupportedVideoFile);
    const ignoredCount = files.length - supported.length;
    if (supported.length === 0) {
      setImportStatus('没有可导入的视频，仅支持 MP4、MOV、AVI、WebM。');
      return;
    }
    setImportStatus(
      ignoredCount > 0
        ? `已提交 ${supported.length} 个视频，忽略 ${ignoredCount} 个不支持的文件。`
        : `已提交 ${supported.length} 个视频。`,
    );
    onImportFiles?.(supported);
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length) submitFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (!importEnabled) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) submitFiles(files);
  };

  const handleImportKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!importEnabled || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    fileInputRef.current?.click();
  };

  return (
    <section className={styles.materialStep} aria-labelledby="mixcut-material-heading">
      <header className={styles.stepHeader}>
        <div>
          <p className={styles.eyebrow}>STEP 01</p>
          <h1 id="mixcut-material-heading">选择这次混剪要用的素材</h1>
          <p>从当前分镜组挑选模块 4 的完成视频，也可以补充外部视频。</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.secondaryButton} onClick={onRefresh} disabled={loading}>
            <Icon name="retry" size={15} />{loading ? '同步中' : '同步模块 4'}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => fileInputRef.current?.click()}
            disabled={!importEnabled}
            title={importDisabledReason}
          >
            <Icon name="plus" size={16} />{loading ? '正在处理' : '选择视频'}
          </button>
          <input
            ref={fileInputRef}
            className={styles.hiddenInput}
            type="file"
            multiple
            accept=".mp4,.mov,.avi,.webm,video/mp4,video/quicktime,video/x-msvideo,video/webm"
            onChange={handleFiles}
            disabled={!importEnabled}
          />
        </div>
      </header>

      <div className={styles.syncBanner}>
        <span><Icon name="video" size={18} /></span>
        <div>
          <strong>已与模块 4「视频生成」联动</strong>
          <small>当前只显示「{shotSetName || '当前分镜组'}」中真实存在的成功视频。</small>
        </div>
      </div>

      <div
        className={`${styles.importDropzone} ${dragActive ? styles.importDropzoneActive : ''}`}
        role="button"
        tabIndex={importEnabled ? 0 : -1}
        aria-disabled={!importEnabled}
        aria-describedby="mixcut-import-help mixcut-import-status"
        onClick={() => importEnabled && fileInputRef.current?.click()}
        onKeyDown={handleImportKeyDown}
        onDragEnter={(event) => {
          event.preventDefault();
          if (importEnabled) setDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <Icon name="plus" size={18} />
        <span>
          <strong>{dragActive ? '松开即可导入到本组' : '拖拽视频到这里，或点击选择'}</strong>
          <small id="mixcut-import-help">支持 MP4、MOV、AVI、WebM，可一次选择多个文件</small>
        </span>
      </div>
      <p id="mixcut-import-status" className={styles.importStatus} aria-live="polite">{importStatus}</p>

      <div className={styles.materialToolbar}>
        <strong>{materials.filter((material) => material.status === 'ready').length} 个可用视频</strong>
        <span />
        {selectedMaterialKeys.length > 0
          ? <button type="button" onClick={onClear}>清除本组已选 {selectedMaterialKeys.length} 个</button>
          : materials.some((material) => material.status === 'ready') && <button type="button" onClick={onSelectAll}>全选本组</button>}
      </div>

      {materials.length > 0 ? (
        <div className={styles.materialGrid}>
          {materials.map((material) => {
            const checked = selected.has(material.key);
            const selectable = material.status === 'ready';
            return (
              <button
                type="button"
                key={material.key}
                className={`${styles.materialCard} ${checked ? styles.materialSelected : ''}`}
                onClick={() => selectable && onToggle(material.key)}
                aria-pressed={checked}
                disabled={!selectable}
              >
                <span className={styles.thumbnail}>
                  {material.thumbnailUrl
                    ? <Image src={material.thumbnailUrl} alt={`${material.filename} 视频缩略图`} fill sizes="(max-width: 1120px) 170px, 220px" unoptimized />
                    : <span className={styles.thumbnailFallback}><Icon name="video" size={24} /></span>}
                  <i className={checked ? styles.checkSelected : styles.checkIdle}>{checked && <Icon name="check" size={12} />}</i>
                  <em>{formatDuration(material.durationUs)}</em>
                </span>
                <span className={styles.materialMeta}>
                  <strong>{material.filename}</strong>
                  <small>{material.errorMessage || (material.width && material.height ? `${material.width} × ${material.height}` : '媒体信息待探测')}</small>
                  <span>{material.source === 'module4' ? '模块 4' : '外部导入'} · {material.status === 'ready' ? '就绪' : material.status === 'missing' ? '文件丢失' : '导入失败'}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <Icon name="video" size={26} />
          <strong>当前组还没有可用视频</strong>
          <span>请先返回模块 4 完成视频生成；其他分镜组的素材不会在这里兜底出现。</span>
        </div>
      )}

      {!onImportFiles && importDisabledReason && (
        <p className={styles.importNotice}><Icon name="alert" size={14} />{importDisabledReason}</p>
      )}
    </section>
  );
}
