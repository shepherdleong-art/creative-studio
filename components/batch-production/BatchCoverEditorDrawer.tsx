'use client';

import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { defaultTextStyle } from '@/lib/media-core/cover-domain';
import type { CoverFraming, TextStyle } from '@/lib/media-core/cover-types';
import type { OutputPresetId } from '@/lib/final-edit/types';
import type { FrozenBatchCoverTitleConfig } from '@/lib/batch-production/cover-title';
import type { BatchOutputPoolAssetView } from '@/lib/batch-production/output-arrangement';
import BatchCoverDraftPreview from './BatchCoverDraftPreview';
import BatchTextStyleEditor from './BatchTextStyleEditor';
import styles from '../mixcut/mixcut-content.module.css';

export interface BatchCoverEditorTitleDraft {
  primary: string;
  secondary: string;
  styles: { primary: TextStyle; secondary: TextStyle };
}

export interface BatchCoverEditorDraft {
  assetId: string | null;
  timeUs: number;
  framing: CoverFraming;
  title: BatchCoverEditorTitleDraft;
}

interface BatchCoverEditorDrawerProps {
  active: boolean;
  assets: BatchOutputPoolAssetView[];
  initialAssetId: string | null;
  initialTimeUs: number;
  title: FrozenBatchCoverTitleConfig | null;
  framing?: CoverFraming | null;
  outputPreset: OutputPresetId;
  busy: boolean;
  onClose: () => void;
  onApply: (draft: BatchCoverEditorDraft) => Promise<boolean>;
}

const DEFAULT_FRAMING: CoverFraming = { scale: 1, offsetX: 0, offsetY: 0 };

function durationUsOf(asset: BatchOutputPoolAssetView | null): number | null {
  return asset?.durationSec != null ? Math.max(1, Math.round(asset.durationSec * 1_000_000)) : null;
}

function clampTimeUs(timeUs: number, asset: BatchOutputPoolAssetView | null): number {
  const durationUs = durationUsOf(asset);
  return durationUs == null ? 0 : Math.max(0, Math.min(timeUs, durationUs - 1));
}

function cloneTitle(title: FrozenBatchCoverTitleConfig | null, outputWidth: number): BatchCoverEditorTitleDraft {
  return {
    primary: title?.primary ?? '',
    secondary: title?.secondary ?? '',
    styles: {
      primary: structuredClone(title?.styles.primary ?? defaultTextStyle('coverPrimary', outputWidth)),
      secondary: structuredClone(title?.styles.secondary ?? defaultTextStyle('coverSecondary', outputWidth)),
    },
  };
}

function createDraft(
  title: FrozenBatchCoverTitleConfig | null,
  framing: CoverFraming | null | undefined,
  assetId: string | null,
  timeUs: number,
  outputWidth: number,
  asset: BatchOutputPoolAssetView | null,
): BatchCoverEditorDraft {
  return {
    assetId,
    timeUs: clampTimeUs(timeUs, asset),
    framing: { ...(framing ?? title?.framing ?? DEFAULT_FRAMING) },
    title: cloneTitle(title, outputWidth),
  };
}

/**
 * 批量成片的封面精调抽屉：交互结构和单条剪辑保持一致，支持来源/截帧、
 * 画面构图、两段标题文字与完整文字样式；应用时只覆盖当前成片计划。
 */
export default function BatchCoverEditorDrawer({
  active,
  assets,
  initialAssetId,
  initialTimeUs,
  title,
  framing,
  outputPreset,
  busy,
  onClose,
  onApply,
}: BatchCoverEditorDrawerProps) {
  const outputWidth = outputPreset === '16x9' ? 1920 : 1080;
  const [draft, setDraft] = useState<BatchCoverEditorDraft>(() => {
    const initialAsset = assets.find((asset) => asset.assetId === initialAssetId) ?? null;
    return createDraft(title, framing, initialAssetId, initialTimeUs, outputWidth, initialAsset);
  });
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // 字体浮层 host 由 BatchTextStyleEditor 自托管（紧跟各自触发器），抽屉不再管 host。
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const initialSnapshotRef = useRef({ title, framing, assets });
  const selectedAsset = draft.assetId ? assets.find((asset) => asset.assetId === draft.assetId) ?? null : null;
  const selectedDurationUs = durationUsOf(selectedAsset);
  const selectedTimeUs = clampTimeUs(draft.timeUs, selectedAsset);
  const previewTitle: FrozenBatchCoverTitleConfig = {
    ...draft.title,
    framing: draft.framing,
  };

  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    initialSnapshotRef.current = { title, framing, assets };
  });

  // 草稿初始化:只在真正「打开这个 drawer / 换了目标封面」时重置。
  // title/framing/assets 每次 loadView 都换引用,不能进依赖,否则应用一次就把草稿冲掉。
  useEffect(() => {
    if (!active) return;
    const snapshot = initialSnapshotRef.current;
    const selectedInitialAsset = snapshot.assets.find((asset) => asset.assetId === initialAssetId) ?? null;
    const timer = window.setTimeout(() => {
      setDraft(createDraft(snapshot.title, snapshot.framing, initialAssetId, initialTimeUs, outputWidth, selectedInitialAsset));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, initialAssetId, initialTimeUs, outputWidth]);

  // 焦点陷阱 / 滚动锁 / ESC:只跟 active 走。
  useEffect(() => {
    if (!active) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 字体面板在 document 捕获阶段先 preventDefault + stopPropagation 并关闭面板；
        // 已被面板消费的 Esc（defaultPrevented）直接放行，不再重复关抽屉。
        if (event.defaultPrevented) return;
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])]
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
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', keydown);
      previousFocusRef.current?.focus();
    };
  }, [active]);

  useEffect(() => {
    if (active && busy) dialogRef.current?.focus();
  }, [active, busy]);

  if (!active || typeof document === 'undefined') return null;

  const updateAsset = (assetId: string) => {
    const asset = assets.find((item) => item.assetId === assetId) ?? null;
    setDraft((current) => ({ ...current, assetId, timeUs: clampTimeUs(0, asset) }));
  };
  const updateTime = (timeUs: number) => setDraft((current) => ({ ...current, timeUs: clampTimeUs(timeUs, selectedAsset) }));
  const patchFraming = (patch: Partial<CoverFraming>) => setDraft((current) => ({ ...current, framing: { ...current.framing, ...patch } }));
  const patchTitle = (part: 'primary' | 'secondary', text: string) => setDraft((current) => ({
    ...current,
    title: { ...current.title, [part]: text.replace(/[\r\n]+/gu, '') },
  }));
  const patchTitleStyle = (part: 'primary' | 'secondary', value: TextStyle) => setDraft((current) => ({
    ...current,
    title: { ...current.title, styles: { ...current.title.styles, [part]: value } },
  }));

  return createPortal(
    <div
      className={styles.coverDrawerBackdrop}
      data-testid="batch-cover-editor-drawer"
      onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}
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
            <span>{outputPreset.replace('x', ':')} · 可调整画面、标题与截帧</span>
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
                  title={asset.excluded ? '该素材已被排除出本批次' : '选择素材「' + asset.displayName + '」'}
                  onClick={() => updateAsset(asset.assetId)}
                >
                  {asset.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={asset.thumbnailUrl} alt="" />
                  ) : <span className="flex h-12 items-center justify-center text-[10px] text-ink-tertiary">无图</span>}
                  <span>
                    <strong>{asset.displayName}</strong>
                    <small>{asset.durationSec != null ? asset.durationSec.toFixed(2) + ' 秒' : '时长未知'}{asset.excluded ? ' · 已排除' : ''}</small>
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
                title={previewTitle}
                framing={draft.framing}
                outputPreset={outputPreset}
              />
              <div className={styles.coverSafeArea} aria-label="4% 导出安全区" />
            </div>
            <p>右侧可调整画面构图、标题文字和样式；标题位置按 X/Y 调整，虚线框为四边 4% 导出安全区。</p>
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
              <h3>画面构图</h3>
              <div className="space-y-3">
                <Range label="缩放" value={draft.framing.scale} min={1} max={3} step={0.05} onChange={(scale) => patchFraming({ scale })} />
                <Range label="水平位置" value={draft.framing.offsetX} min={-1} max={1} step={0.02} onChange={(offsetX) => patchFraming({ offsetX })} />
                <Range label="垂直位置" value={draft.framing.offsetY} min={-1} max={1} step={0.02} onChange={(offsetY) => patchFraming({ offsetY })} />
              </div>
            </section>

            {(['primary', 'secondary'] as const).map((part) => {
              const label = part === 'primary' ? '主标题' : '副标题';
              return (
                <section key={part} aria-label={label + '设置'}>
                  <h3>{label}</h3>
                  <label className="mb-3 block">
                    <span className="mb-1 block text-[11px] text-ink-tertiary">文字内容</span>
                    <input
                      className="h-8 w-full rounded-lg border border-hairline bg-surface px-2 text-xs text-ink"
                      aria-label={label + '文字'}
                      value={draft.title[part]}
                      onChange={(event) => patchTitle(part, event.target.value)}
                    />
                  </label>
                  <BatchTextStyleEditor
                    label={label + '样式'}
                    value={draft.title.styles[part]}
                    outputWidth={outputWidth}
                    onChange={(value) => patchTitleStyle(part, value)}
                  />
                </section>
              );
            })}

            <section>
              <h3>操作说明</h3>
              <p className="text-[11px] leading-5 text-ink-tertiary">取消不会保存本次调整；点击应用后，只更新当前成片计划，其他批量成片不受影响。</p>
            </section>
          </aside>
        </fieldset>

        <footer className={styles.coverDrawerFooter}>
          <span aria-live="polite">{selectedAsset ? selectedAsset.displayName + ' · ' + (selectedTimeUs / 1_000_000).toFixed(2) + ' 秒' : '请选择封面素材'}</span>
          <div>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onClose}>取消</button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy || !selectedAsset || selectedDurationUs == null}
              onClick={() => void onApply({ ...draft, timeUs: selectedTimeUs }).then((accepted) => { if (accepted) onClose(); })}
            >{busy ? '正在应用…' : '应用封面'}</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between gap-2 text-[11px] text-ink-tertiary">
        <span>{label}</span>
        <output className="tabular-nums">{value.toFixed(2)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={styles.rangeInput}
        aria-label={label}
      />
    </label>
  );
}
