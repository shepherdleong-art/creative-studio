'use client';

import type { FinalEditAssetView } from '@/lib/final-edit/types';
import styles from './FinalEditEditor.module.css';

export type AssetFilter = 'all' | 'recommended' | 'used' | 'failed' | 'disabled';

export function FinalEditAssetPool({
  assets,
  filteredAssets,
  selectedAsset,
  filter,
  busy,
  onFilter,
  onSelect,
  onToggleAutoUse,
  onReanalyze,
}: {
  assets: FinalEditAssetView[];
  filteredAssets: FinalEditAssetView[];
  selectedAsset: FinalEditAssetView | null;
  filter: AssetFilter;
  busy: boolean;
  onFilter: (filter: AssetFilter) => void;
  onSelect: (videoJobId: string) => void;
  onToggleAutoUse: (videoJobId: string, disabled: boolean) => void;
  onReanalyze: (videoJobId: string) => void;
}) {
  const filters: Array<[AssetFilter, string]> = [
    ['all', '全部'], ['recommended', '推荐'], ['used', '使用中'], ['failed', '失败'], ['disabled', '禁用'],
  ];

  return (
    <aside className={styles.leftSidebar} aria-label="视频素材池">
      <div className={styles.panelHeading}>
        <div><strong>视频素材</strong><small>当前分镜组的完整视频</small></div>
        <span className={styles.countBadge}>{assets.length} 条</span>
      </div>
      <div className={styles.assetPanel}>
        <div className={styles.assetFilter} aria-label="素材筛选">
          {filters.map(([id, label]) => (
            <button key={id} type="button" className={filter === id ? styles.activeFilter : ''} onClick={() => onFilter(id)}>{label}</button>
          ))}
        </div>
        <p className={styles.assetMeta}>点击静态缩略图预览；拖到视频轨可插入素材。</p>
        <div className={styles.assetScroller}>
          <div className={styles.assetGrid}>
            {filteredAssets.map((asset) => (
              <button
                key={asset.videoJobId}
                type="button"
                draggable
                className={`${styles.assetCard} ${selectedAsset?.videoJobId === asset.videoJobId ? styles.selectedAsset : ''}`}
                onClick={() => onSelect(asset.videoJobId)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'copy';
                  event.dataTransfer.setData('application/x-final-edit-asset', asset.videoJobId);
                  event.dataTransfer.setData('text/plain', asset.videoJobId);
                }}
              >
                {/* The thumbnail endpoint extracts and caches a deterministic video frame. */}
                <img src={asset.thumbnailUrl} alt={`${asset.filename} 缩略图`} draggable={false} />
                <strong>{asset.filename}</strong>
                <small>使用 {asset.usageCount} 次 · {asset.analysisStatus === 'succeeded' ? '已分析' : asset.analysisStatus === 'failed' ? '分析失败' : '待分析'}</small>
              </button>
            ))}
          </div>
        </div>
        {selectedAsset ? (
          <div className={styles.analysisCard}>
            <p><strong>分析摘要</strong><br />{selectedAsset.summary || '暂无可靠摘要'}</p>
            <div className={styles.analysisActions}>
              <label><input type="checkbox" checked={selectedAsset.autoUseDisabled} onChange={(event) => onToggleAutoUse(selectedAsset.videoJobId, event.target.checked)} /> 禁止自动使用</label>
              <button type="button" disabled={busy} onClick={() => onReanalyze(selectedAsset.videoJobId)}>重新分析</button>
            </div>
          </div>
        ) : <p className={styles.assetTip}>当前筛选下没有素材。</p>}
      </div>
    </aside>
  );
}
