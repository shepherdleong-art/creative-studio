'use client';

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { OutputPresetId } from '@/lib/final-edit/types';
import type { FrozenBatchCoverTitleConfig } from '@/lib/batch-production/cover-title';
import type { BatchOutputPoolAssetView } from '@/lib/batch-production/output-arrangement';
import BatchCoverDraftPreview from './BatchCoverDraftPreview';
import styles from '../mixcut/mixcut-content.module.css';

export interface BatchCoverEditorDraft {
  assetId: string | null;
  timeUs: number;
}

interface BatchCoverEditorDrawerProps {
  active: boolean;
  assets: BatchOutputPoolAssetView[];
  initialAssetId: string | null;
  initialTimeUs: number;
  title: FrozenBatchCoverTitleConfig | null;
  outputPreset: OutputPresetId;
  busy: boolean;
  onClose: () => void;
  onApply: (draft: BatchCoverEditorDraft) => Promise<boolean>;
}

function durationUsOf(asset: BatchOutputPoolAssetView | null): number | null {
  return asset?.durationSec != null ? Math.max(1, Math.round(asset.durationSec * 1_000_000)) : null;
}

function clampTimeUs(timeUs: number, asset: BatchOutputPoolAssetView | null): number {
  const durationUs = durationUsOf(asset);
  return durationUs == null ? 0 : Math.max(0, Math.min(timeUs, durationUs - 1));
}

/**
 * 批量成片的封面精调抽屉：交互结构对齐单条剪辑的 CoverEditorDrawer，
 * 但批量模式只允许调整封面来源与抽帧时间，标题和构图沿用已冻结的批次配置。
 */
export default function BatchCoverEditorDrawer({
  active,
  assets,
  initialAssetId,
  initialTimeUs,
  title,
  outputPreset,
  busy,
  onClose,
  onApply,
}: BatchCoverEditorDrawerProps) {
  const [draft, setDraft] = useState<BatchCoverEditorDraft>({ assetId: initialAssetId, timeUs: initialTimeUs });
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const selectedAsset = draft.assetId ? assets.find((asset) => asset.assetId === draft.assetId) ?? null : null;
  const selectedDurationUs = durationUsOf(selectedAsset);
  const selectedTimeUs = clampTimeUs(draft.timeUs, selectedAsset);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const selectedInitialAsset = assets.find((asset) => asset.assetId === initialAssetId) ?? null;
    const draftTimer = window.setTimeout(() => {
      setDraft({ assetId: initialAssetId, timeUs: clampTimeUs(initialTimeUs, selectedInitialAsset) });
    }, 0);
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])]
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      window.clearTimeout(draftTimer);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', keydown);
      previousFocusRef.current?.focus();
    };
  }, [active, assets, initialAssetId, initialTimeUs]);

  useEffect(() => {
    if (active && busy) dialogRef.current?.focus();
  }, [active, busy]);

  if (!active || typeof document === 'undefined') return null;

  const updateAsset = (assetId: string) => {
    const asset = assets.find((item) => item.assetId === assetId) ?? null;
    setDraft({ assetId, timeUs: clampTimeUs(0, asset) });
  };
  const updateTime = (timeUs: number) => setDraft((current) => ({ ...current, timeUs: clampTimeUs(timeUs, selectedAsset) }));

  return createPortal(
    <div
      className={styles.coverDrawerBackdrop}
      data-testid="batch-cover-editor-drawer"
      onPointerDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.coverDrawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-cover-editor-title"
        aria-busy={busy}
        tabIndex={-1}
      >
        <header className={styles.coverDrawerHeader}>
          <div>
            <p className={styles.eyebrow}>BATCH COVER</p>
            <h2 id="batch-cover-editor-title">精调封面</h2>
            <span>{outputPreset.replace('x', ':')} · 当前批次冻结标题</span>
          </div>
          <button ref={closeButtonRef} type="button" aria-label="关闭封面精调" disabled={busy} onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>

        <fieldset className={styles.coverDrawerBody} disabled={busy} aria-label="视频封面设置">
          <aside className={styles.coverSourcePanel}>
            <h3>来源片段</h3>
            <div className={styles.coverSourceList}>
              {assets.map((asset) => (
                <button
                  type="button"
                  key={asset.assetId}
                  className={asset.assetId === draft.assetId ? styles.coverSourceSelected : ''}
                  disabled={asset.excluded}
                  title={asset.excluded ? '该素材已被排除出本批次' : `选择素材「${asset.displayName}」`}
                  onClick={() => updateAsset(asset.assetId)}
                >
                  {asset.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={asset.thumbnailUrl} alt="" />
                  ) : <span className="flex h-12 items-center justify-center text-[10px] text-ink-tertiary">无图</span>}
                  <span>
                    <strong>{asset.displayName}</strong>
                    <small>{asset.durationSec != null ? `${asset.durationSec.toFixed(2)} 秒` : '时长未知'}{asset.excluded ? ' · 已排除' : ''}</small>
                  </span>
                </button>
              ))}
              {assets.length === 0 && <p className="text-xs text-ink-tertiary">没有可用素材</p>}
            </div>
            <label className={styles.fieldLabel}>
              <span>截帧时间 {(selectedTimeUs / 1_000_000).toFixed(2)} 秒</span>
              <input
                aria-label="封面截帧时间"
                type="range"
                min={0}
                max={selectedDurationUs == null ? 0 : selectedDurationUs / 1_000_000}
                step={1 / 24}
                value={selectedTimeUs / 1_000_000}
                disabled={!selectedAsset || selectedDurationUs == null}
                onChange={(event) => updateTime(Number(event.target.value) * 1_000_000)}
              />
            </label>
          </aside>

          <main className={styles.coverCanvasPanel}>
            <div className={styles.coverCanvasWrap} data-output-preset={outputPreset}>
              <BatchCoverDraftPreview
                asset={selectedAsset}
                timeUs={selectedTimeUs}
                title={title}
                outputPreset={outputPreset}
                className="h-full max-w-none"
              />
              <div className={styles.coverSafeArea} aria-label="4% 导出安全区" />
            </div>
            <p>选择来源片段并拖动截帧时间，中央预览会立即更新；虚线框为四边 4% 导出安全区。</p>
          </main>

          <aside className={styles.coverControlsPanel}>
            <section>
              <h3>当前封面</h3>
              <dl className="space-y-2 text-[11px]">
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-ink-tertiary">来源</dt>
                  <dd className="min-w-0 truncate text-right text-ink" title={selectedAsset?.displayName}>{selectedAsset?.displayName || '未选择'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-tertiary">截帧</dt>
                  <dd className="tabular-nums text-ink">{(selectedTimeUs / 1_000_000).toFixed(2)} 秒</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-tertiary">画幅</dt>
                  <dd className="text-ink">{outputPreset.replace('x', ':')}</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>封面标题</h3>
              {title ? (
                <div className="space-y-2 text-[11px] text-ink-secondary">
                  {title.primary && <p className="truncate" title={title.primary}>主标题：{title.primary}</p>}
                  {title.secondary && <p className="truncate" title={title.secondary}>副标题：{title.secondary}</p>}
                  <p className="leading-5 text-ink-tertiary">标题样式与构图随批次冻结，封面精调只修改底图来源和截帧时间。</p>
                </div>
              ) : <p className="text-[11px] leading-5 text-ink-tertiary">本批次未设置封面标题。</p>}
            </section>
            <section>
              <h3>操作说明</h3>
              <p className="text-[11px] leading-5 text-ink-tertiary">取消不会保存本次选择；点击应用后，返回调整片段并使用新的封面实时预览。</p>
            </section>
          </aside>
        </fieldset>

        <footer className={styles.coverDrawerFooter}>
          <span aria-live="polite">{selectedAsset ? `${selectedAsset.displayName} · ${(selectedTimeUs / 1_000_000).toFixed(2)} 秒` : '请选择封面素材'}</span>
          <div>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>取消</button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy || !selectedAsset || selectedDurationUs == null}
              onClick={() => void onApply({ assetId: selectedAsset?.assetId ?? null, timeUs: selectedTimeUs }).then((accepted) => {
                if (accepted) onClose();
              })}
            >{busy ? '正在应用…' : '应用封面'}</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
