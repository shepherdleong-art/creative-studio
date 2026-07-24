import { useRef, type ChangeEvent } from 'react';
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
  const selected = new Set(selectedMaterialKeys);

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length) onImportFiles?.(files);
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
            disabled={!onImportFiles}
            title={importDisabledReason}
          >
            <Icon name="plus" size={16} />导入到当前组
          </button>
          <input
            ref={fileInputRef}
            className={styles.hiddenInput}
            type="file"
            multiple
            accept=".mp4,.mov,.avi,.webm,video/mp4,video/quicktime,video/x-msvideo,video/webm"
            onChange={handleFiles}
            disabled={!onImportFiles}
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
