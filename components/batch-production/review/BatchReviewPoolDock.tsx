'use client';

import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { BatchOutputPoolAssetView } from '@/lib/batch-production/output-arrangement';
import type { MaterialDragItem } from './types';
import styles from './batch-unified-review.module.css';

export interface BatchReviewPoolDockProps {
  projectId: string;
  batchId: string;
  selectedPlanId: string | null;
  poolAssets: BatchOutputPoolAssetView[];
  focusedAssetId: string | null;
  onSelectFocusedAsset: (assetId: string | null) => void;
  onPreviewAsset: (asset: BatchOutputPoolAssetView | null) => void;
  onAssetImported?: () => void;
}

export default function BatchReviewPoolDock({
  projectId,
  batchId,
  selectedPlanId,
  poolAssets,
  focusedAssetId,
  onSelectFocusedAsset,
  onPreviewAsset,
  onAssetImported,
}: BatchReviewPoolDockProps) {
  const [tab, setTab] = useState<'opening' | 'body'>('opening');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Hover scrub state per card
  const [scrubbingAssetId, setScrubbingAssetId] = useState<string | null>(null);
  const [scrubRatio, setScrubRatio] = useState<number>(0);
  const hoverVideoRef = useRef<HTMLVideoElement | null>(null);

  const openingCount = useMemo(() => poolAssets.filter((a) => a.role === 'opening').length, [poolAssets]);
  const bodyCount = useMemo(() => poolAssets.filter((a) => (a.role ?? 'body') === 'body').length, [poolAssets]);

  // Group assets by role
  const filteredAssets = useMemo(() => {
    return poolAssets.filter((asset) => {
      const assetRole = asset.role ?? 'body';
      return assetRole === tab;
    });
  }, [poolAssets, tab]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('projectId', projectId);
      formData.append('batchId', batchId);
      formData.append('role', tab);
      for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
      }
      const response = await fetch('/api/batch-production/assets/import', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || `上传失败 (${response.status})`);
      }
      onAssetImported?.();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>, asset: BatchOutputPoolAssetView) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setScrubbingAssetId(asset.assetId);
    setScrubRatio(ratio);
    if (hoverVideoRef.current && Number.isFinite(hoverVideoRef.current.duration) && hoverVideoRef.current.duration > 0) {
      hoverVideoRef.current.currentTime = ratio * hoverVideoRef.current.duration;
    }
  };

  const handlePointerLeave = () => {
    setScrubbingAssetId(null);
    setScrubRatio(0);
    if (hoverVideoRef.current) {
      hoverVideoRef.current.pause();
    }
  };

  return (
    <section className={`${styles.dock} h-full`} aria-label="素材池">
      {/* v14:素材池标题 + 添加素材 */}
      <div className={styles.dockHead}>
        <h3 className="text-xs font-semibold text-ink">素材池 · 本项目</h3>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,image/*"
            multiple
            className="hidden"
            onChange={handleUpload}
          />
          <button
            type="button"
            className="btn-primary flex h-7 items-center gap-1 px-2.5 text-[11px]"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="plus" size={12} />
            <span>{uploading ? '导入中…' : '添加素材'}</span>
          </button>
        </div>
      </div>

      {/* v14:开场/正文页签,数量动态变化(M-01) */}
      <div className="px-3 pt-2.5">
        <div className="flex rounded-lg bg-surface-subtle p-0.5" role="group" aria-label="素材分类">
          <button
            type="button"
            className={`flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition ${
              tab === 'opening' ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary hover:text-ink'
            }`}
            aria-pressed={tab === 'opening'}
            onClick={() => setTab('opening')}
          >
            开场素材库 · {openingCount}
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition ${
              tab === 'body' ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary hover:text-ink'
            }`}
            aria-pressed={tab === 'body'}
            onClick={() => setTab('body')}
          >
            正文素材库 · {bodyCount}
          </button>
        </div>
        <p className="mt-1.5 px-0.5 text-[10px] leading-relaxed text-ink-tertiary">
          {tab === 'opening' ? (
            <>✓ {openingCount} 份开场素材 <span className="opacity-80">生成后自动归库 · 新批次首镜分散取用</span></>
          ) : (
            <>✓ {bodyCount} 份正文素材 <span className="opacity-80">拖到片段上替换 · 左缘间隙插入 · 末尾追加</span></>
          )}
        </p>
      </div>

      {uploadError && (
        <div className="bg-fail/10 px-3 py-1.5 text-xs text-fail flex items-center justify-between">
          <span>{uploadError}</span>
          <button type="button" onClick={() => setUploadError(null)}>×</button>
        </div>
      )}

      <div className={styles.poolGrid}>
        {filteredAssets.map((asset) => {
          const isFocused = focusedAssetId === asset.assetId;
          // v14 卡片用量:视频轨道引用总次数与涉及成片数(封面不计入,全批次口径)
          const totalUses = Object.values(asset.useCountByPlanId).reduce((sum, count) => sum + count, 0);
          const filmCount = Object.values(asset.useCountByPlanId).filter((count) => count > 0).length;
          const isCover = selectedPlanId ? asset.coverUsedByPlanIds.includes(selectedPlanId) : false;
          const isScrubbing = scrubbingAssetId === asset.assetId;
          const currentTimeSec = (asset.durationSec ?? 0) * scrubRatio;

          return (
            <article
              key={asset.assetId}
              className={`${styles.poolCard} ${isFocused ? 'ring-2 ring-accent' : ''}`}
              draggable
              onDragStart={(e) => {
                const item: MaterialDragItem = {
                  assetId: asset.assetId,
                  displayName: asset.displayName,
                  durationSec: asset.durationSec,
                  thumbnailUrl: asset.thumbnailUrl,
                  previewUrl: asset.previewUrl,
                };
                e.dataTransfer.setData('application/json', JSON.stringify(item));
                e.dataTransfer.effectAllowed = 'copyMove';
              }}
            >
              <div
                className={`${styles.poolPoster} ${isScrubbing ? styles.poolPosterHover : ''}`}
                onPointerMove={(e) => handlePointerMove(e, asset)}
                onPointerLeave={handlePointerLeave}
              >
                {asset.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={asset.thumbnailUrl} alt={asset.displayName} loading="lazy" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[10px] text-ink-tertiary">
                    无封面
                  </div>
                )}

                {asset.previewUrl && (
                  <video
                    ref={isScrubbing ? hoverVideoRef : undefined}
                    src={asset.previewUrl}
                    muted
                    playsInline
                    preload="metadata"
                    className={styles.poolPosterVideo}
                  />
                )}

                {isScrubbing && (
                  <>
                    <div className={styles.poolPosterScrubBar}>
                      <div
                        className={styles.poolPosterScrubProgress}
                        style={{ width: `${scrubRatio * 100}%` }}
                      />
                    </div>
                    <span className={styles.poolPosterTimeTag}>
                      {Math.floor(currentTimeSec / 60)}:{(currentTimeSec % 60).toFixed(1).padStart(4, '0')}
                    </span>
                  </>
                )}

                <span className="absolute top-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-white">
                  {asset.durationSec != null ? `${asset.durationSec.toFixed(1)}s` : '未知'}
                </span>
              </div>

              <div className={styles.poolCardBody}>
                <h4 className="truncate text-xs font-medium text-ink" title={asset.displayName}>
                  {asset.displayName}
                </h4>

                <div className="flex flex-wrap items-center gap-1 text-[9px] text-ink-tertiary">
                  <span>
                    已用 {totalUses} 次 · {filmCount} 条成片
                  </span>
                  {isCover && (
                    <span className="rounded-full bg-accent/10 px-1.5 py-0.2 text-accent">
                      当前封面
                    </span>
                  )}
                </div>

                <div className={styles.poolCardActions}>
                  <button
                    type="button"
                    className={styles.poolCardButton}
                    onClick={() => onPreviewAsset(asset)}
                  >
                    <span aria-hidden="true" className={styles.poolPlayIcon}>▶</span>预览
                  </button>
                  <button
                    type="button"
                    className={styles.poolCardButton}
                    aria-pressed={isFocused}
                    onClick={() => onSelectFocusedAsset(isFocused ? null : asset.assetId)}
                  >
                    {isFocused ? '取消定位' : '定位用法'}
                  </button>
                </div>
              </div>
            </article>
          );
        })}

        {filteredAssets.length === 0 && (
          <div className="col-span-full py-12 text-center text-xs text-ink-tertiary">
            {tab === 'opening' ? '开场素材库暂无素材，点击右上角「添加素材」' : '正文素材库暂无素材'}
          </div>
        )}
      </div>

      {/* v14 底部:悬浮提示 + 自动取用规则入口 */}
      <div className={styles.poolFooter}>
        <span className="text-[10px] text-ink-tertiary">悬浮左右滑动，浏览素材画面</span>
        <button
          type="button"
          className="text-[10px] text-ink-secondary hover:text-accent transition"
          onClick={() => setRulesOpen(true)}
        >
          自动取用规则 ⓘ
        </button>
      </div>

      {/* 开场素材库 · 自动归库与调用规则说明(真实行为,非演示) */}
      {rulesOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pool-rules-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setRulesOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-hairline pb-3">
              <h3 id="pool-rules-title" className="font-semibold text-ink">开场素材库 · 自动归库与调用</h3>
              <button type="button" className="btn-secondary h-7 w-7 p-0" onClick={() => setRulesOpen(false)}>×</button>
            </div>
            <div className="space-y-2 text-xs leading-relaxed text-ink-secondary">
              <p className="font-medium text-ink">你只需要生成开场，后面直接复用。</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>自定义生成的开场视频，生成成功后自动归入本项目 / 开场素材库；</li>
                <li>下一次批量生产的首镜自动从开场库分散取用，其余镜头从正文库分配；</li>
                <li>归库幂等：重试或刷新不会重复登记；</li>
                <li>新增开场只影响后续批次与显式编辑，不会重排已生成的成片。</li>
              </ol>
              <p>库内只显示生成成功、可用的视频；未生成完成的开场不参与分配。也可以通过「添加素材」手工导入到当前分类。</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
