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

// V2 素材池语义（规格 §5 第 1 步）：默认全部参与混剪，点击卡片=排除/恢复。
// selectedMaterialKeys 是「将参与」的集合，卡片为排除态 ⇔ ready 且不在集合内。
export function MaterialStep({
  shotSetName,
  materials,
  selectedMaterialKeys,
  onToggle,
  onSelectAll,
  onRefresh,
  onImportFiles,
  onContinue,
  importDisabledReason,
  loading,
}: {
  shotSetName: string;
  materials: MaterialCardView[];
  selectedMaterialKeys: string[];
  onToggle: (materialKey: string) => void;
  onSelectAll: () => void;
  onRefresh: () => void;
  onImportFiles?: (files: File[]) => void;
  onContinue?: () => void;
  importDisabledReason?: string;
  loading?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const included = new Set(selectedMaterialKeys);
  const readyCount = materials.filter((material) => material.status === 'ready').length;
  const excludedCount = materials.filter((material) => material.status === 'ready' && !included.has(material.key)).length;
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
    <>
      <header className={styles.stepHead}>
        <div>
          <p className={`${styles.eyebrow} ${styles.stepTitle}`} style={{ fontSize: 11 }}>STEP 01</p>
          <h1 className={styles.stepTitle} id="mixcut-material-heading">确认本次混剪要用的素材</h1>
          <div className={styles.stepSub} style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            当前分镜组的完成视频默认全部参与混剪，点掉不想要的即可。
            <span className={styles.linked}>已与模块 4 联动，仅显示「{shotSetName || '当前分镜组'}」的真实成功视频</span>
          </div>
        </div>
        <div className={styles.stepActions}>
          <button type="button" className={styles.btn} onClick={onRefresh} disabled={loading}>
            <Icon name="retry" size={14} />{loading ? '同步中' : '同步模块 4'}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={() => fileInputRef.current?.click()}
            disabled={!importEnabled}
            title={importDisabledReason}
          >
            <Icon name="plus" size={14} />{loading ? '正在处理' : '选择视频'}
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

      <div className={styles.stepScroll}>
        <div
          className={`${styles.dropzone} ${dragActive ? styles.dropzoneActive : ''}`}
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
          <div className={styles.dropzoneT1}>{dragActive ? '松开即可导入到本组' : '拖拽视频到这里，或点击导入外部视频'}</div>
          <div className={styles.dropzoneT2} id="mixcut-import-help">支持 MP4 / MOV / AVI / WebM，可一次多选</div>
        </div>
        <p id="mixcut-import-status" className={styles.importStatus} aria-live="polite">{importStatus}</p>

        <div className={styles.poolToolbar}>
          <span><b>{readyCount}</b> 个可用视频 · <b>{included.size}</b> 个将参与混剪</span>
          {excludedCount > 0 && <button type="button" className={styles.linkBtn} onClick={onSelectAll}>恢复全部（已排除 {excludedCount} 个）</button>}
        </div>

        {materials.length > 0 ? (
          <div className={styles.pool}>
            {materials.map((material) => {
              const selectable = material.status === 'ready';
              const excluded = selectable && !included.has(material.key);
              const sourceLabel = material.source === 'module4' ? '模块 4' : '外部导入';
              const stateLabel = material.status === 'missing' ? '文件丢失' : material.status === 'failed' ? '导入失败' : excluded ? '已排除' : '将参与混剪';
              return (
                <button
                  type="button"
                  key={material.key}
                  className={`${styles.mat} ${excluded ? styles.matExcluded : ''} ${!selectable ? styles.matError : ''}`}
                  onClick={() => selectable && onToggle(material.key)}
                  aria-pressed={!excluded}
                  disabled={!selectable}
                  title={excluded ? '点击恢复：重新参与本次混剪' : '点击排除：这条不参与本次混剪'}
                >
                  <span className={styles.matThumb}>
                    {material.thumbnailUrl
                      ? <Image src={material.thumbnailUrl} alt={`${material.filename} 视频缩略图`} fill sizes="(max-width: 1120px) 170px, 220px" unoptimized />
                      : <span className={styles.matThumbFallback}><Icon name="video" size={24} /></span>}
                    <span className={styles.matDur}>{formatDuration(material.durationUs)}</span>
                  </span>
                  <span className={styles.matBadge}><Icon name={excluded ? 'plus' : 'close'} size={11} /></span>
                  <span className={styles.matTag}>已排除</span>
                  <span className={styles.matBody}>
                    <span className={styles.matName}>{material.filename}</span>
                    <span className={styles.matMeta}>{material.errorMessage || (material.width && material.height ? `${material.width} × ${material.height}` : '媒体信息待探测')}</span>
                    <span className={styles.matSrc}>{sourceLabel} · {stateLabel}</span>
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
      </div>

      <footer className={styles.stepFoot}>
        <span className={styles.stepFootMsg}>{included.size > 0 ? `${included.size} 个视频将参与本次混剪，下一步选择脚本和音色。` : '至少保留一个视频才能继续。'}</span>
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onContinue} disabled={!onContinue || included.size === 0 || loading}>下一步：AI 智能创作</button>
      </footer>
    </>
  );
}
