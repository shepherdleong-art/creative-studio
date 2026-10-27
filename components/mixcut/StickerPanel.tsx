'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { PackagingTemplateId } from '@/lib/final-edit/packaging-vars';
import {
  STICKER_STYLES,
  STICKER_STYLE_BY_TEMPLATE,
  resolveStickerStyle,
  type PackagingStickerEditPatch,
  type PackagingStickerInstance,
  type StickerStyle,
} from '@/lib/media-core/packaging-stickers';
import styles from './mixcut-content.module.css';

export type StickerCatalogCategory = 'opening' | 'explain' | 'ending' | 'gesture' | 'annotation' | 'special';

export type StickerCatalogAsset = {
  style: StickerStyle;
  style_name: string;
  category: StickerCatalogCategory;
  id: string;
  label: string;
  file: string;
  thumbnail: string;
  width: number;
  height: number;
  alpha_gt8_bbox: [number, number, number, number];
  file_bytes: number;
  sha256: string;
};

export type StickerAssetChoice = {
  asset: StickerCatalogAsset;
  styleMode: PackagingStickerInstance['styleMode'];
  fixedStyle: StickerStyle | null;
};

const STYLE_LABELS: Record<StickerStyle, string> = {
  show: '立体综艺',
  comic: '圆润卡通',
  journal: '手帐拼贴',
  editorial: '暖调杂志',
};

const CATEGORIES: Array<{ id: 'all' | StickerCatalogCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'opening', label: '开头吸引' },
  { id: 'explain', label: '中段讲解' },
  { id: 'ending', label: '结尾引导' },
  { id: 'gesture', label: '手势' },
  { id: 'annotation', label: '箭头圈注' },
];

function stickerResourceUrl(relativePath: string): string {
  return `/api/packaging/stickers/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

function NumberProperty({ label, value, min, max, step, suffix, disabled, onCommit }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  return (
    <label className={styles.stickerProperty}>
      <span>{label}</span>
      <span className={styles.stickerNumberWrap}>
        <input
          key={`${label}:${value}`}
          type="number"
          defaultValue={Number(value.toFixed(2))}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onBlur={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next) && next !== value) onCommit(next);
          }}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          aria-label={label}
        />
        <span>{suffix}</span>
      </span>
    </label>
  );
}

export function StickerPanel({ active, enabled, busy, template, stickers, selectedSticker, addBlockedReason, onAdd, onDragStart, onDragEnd, onPatchSticker, onDuplicateSticker, onDeleteSticker }: {
  active: boolean;
  enabled: boolean;
  busy: boolean;
  template: PackagingTemplateId;
  stickers: PackagingStickerInstance[];
  selectedSticker: PackagingStickerInstance | null;
  addBlockedReason: string;
  onAdd: (choice: StickerAssetChoice) => void;
  onDragStart: (choice: StickerAssetChoice) => void;
  onDragEnd: () => void;
  onPatchSticker: (id: string, patch: PackagingStickerEditPatch) => void;
  onDuplicateSticker: (id: string) => void;
  onDeleteSticker: (id: string) => void;
}) {
  const [assets, setAssets] = useState<StickerCatalogAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [retryId, setRetryId] = useState(0);
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [category, setCategory] = useState<'all' | StickerCatalogCategory>('all');
  const [query, setQuery] = useState('');
  const didDragRef = useRef(false);
  const templateStyle = STICKER_STYLE_BY_TEMPLATE[template];

  useEffect(() => {
    if (!active || loaded) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/packaging/stickers/catalog.json', { signal: controller.signal });
        const body = await response.json() as { assets?: StickerCatalogAsset[]; message?: string };
        if (!response.ok) throw new Error(body.message || `贴纸目录读取失败（${response.status}）`);
        if (!Array.isArray(body.assets)) throw new Error('贴纸目录格式无效');
        if (!controller.signal.aborted) {
          setAssets(body.assets);
          setLoaded(true);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoaded(true);
        }
      }
    })();
    return () => controller.abort();
  }, [active, loaded, retryId]);
  const loading = active && !loaded && !error;

  const scopedAssets = useMemo(() => scope === 'current' ? assets.filter((asset) => asset.style === templateStyle) : assets, [assets, scope, templateStyle]);
  const filteredAssets = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return scopedAssets.filter((asset) => {
      if (category !== 'all' && asset.category !== category) return false;
      if (!keyword) return true;
      return `${asset.label} ${asset.id} ${asset.style_name}`.toLocaleLowerCase().includes(keyword);
    });
  }, [scopedAssets, category, query]);

  const choiceFor = (asset: StickerCatalogAsset): StickerAssetChoice => {
    const fixed = asset.id === 'special' || asset.style !== templateStyle;
    return { asset, styleMode: fixed ? 'fixed' : 'follow-template', fixedStyle: fixed ? asset.style : null };
  };
  const addDisabled = busy || !enabled || Boolean(addBlockedReason);
  const selectedAsset = selectedSticker
    ? assets.find((asset) => asset.id === selectedSticker.assetId && asset.style === resolveStickerStyle(selectedSticker, template))
    : null;

  return (
    <div className={styles.stickerPanel}>
      <div className={styles.stickerSectionHead}>
        <span><Icon name="image" size={14} />贴纸素材</span>
        <span className={styles.stickerCount}>{stickers.length} 张已放置</span>
      </div>

      <div className={styles.stickerScope} role="group" aria-label="素材风格范围">
        <button type="button" className={scope === 'current' ? styles.stickerScopeActive : ''} onClick={() => setScope('current')}>当前模板</button>
        <button type="button" className={scope === 'all' ? styles.stickerScopeActive : ''} onClick={() => setScope('all')}>全部风格</button>
      </div>

      <label className={styles.stickerSearch}>
        <Icon name="search" size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索贴纸名称" aria-label="搜索贴纸名称" />
        {query && <button type="button" aria-label="清空贴纸搜索" onClick={() => setQuery('')}><Icon name="close" size={12} /></button>}
      </label>

      <div className={styles.stickerCategories} aria-label="贴纸分类">
        {CATEGORIES.map((item) => (
          <button
            type="button"
            key={item.id}
            className={category === item.id ? styles.stickerCategoryActive : ''}
            aria-pressed={category === item.id}
            onClick={() => setCategory(item.id)}
          >{item.label}</button>
        ))}
      </div>

      {addBlockedReason && <p className={styles.stickerNotice}><Icon name="alert" size={12} />{addBlockedReason}</p>}
      {error ? (
        <div className={styles.stickerEmpty} role="alert">
          <span>{error}</span>
          <button type="button" className={styles.linkBtn} onClick={() => { setLoaded(false); setError(''); setRetryId((value) => value + 1); }}>重新加载</button>
        </div>
      ) : loading ? (
        <div className={styles.stickerEmpty}>正在读取贴纸目录…</div>
      ) : (
        <>
          <div className={styles.stickerResultMeta} aria-live="polite">{filteredAssets.length} 张 · 点击添加或拖入预览</div>
          <div className={styles.stickerGrid}>
            {filteredAssets.map((asset) => {
              const choice = choiceFor(asset);
              return (
                <button
                  type="button"
                  key={`${asset.style}/${asset.id}`}
                  className={styles.stickerAsset}
                  disabled={addDisabled}
                  draggable={!addDisabled}
                  title={`${asset.label} · ${scope === 'all' ? asset.style_name : STYLE_LABELS[asset.style]}`}
                  aria-label={`添加贴纸 ${asset.label}`}
                  onClick={() => {
                    if (didDragRef.current) { didDragRef.current = false; return; }
                    onAdd(choice);
                  }}
                  onDragStart={(event) => {
                    didDragRef.current = true;
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('text/plain', `${asset.style}/${asset.id}`);
                    onDragStart(choice);
                  }}
                  onDragEnd={() => {
                    onDragEnd();
                    window.setTimeout(() => { didDragRef.current = false; }, 0);
                  }}
                >
                  <span className={styles.stickerThumb}>
                    {/* 缩略图只用于素材库；原始 PNG 由 overlay 按实际实例加载。 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={stickerResourceUrl(asset.thumbnail)} alt="" loading="lazy" decoding="async" draggable={false} />
                  </span>
                  <span className={styles.stickerAssetLabel}>{asset.label}</span>
                  {scope === 'all' && <span className={styles.stickerAssetStyle}>{asset.style_name}</span>}
                </button>
              );
            })}
          </div>
          {filteredAssets.length === 0 && <div className={styles.stickerEmpty}>没有符合当前筛选的贴纸</div>}
        </>
      )}

      {selectedSticker && (
        <section className={styles.stickerSelected} aria-label="当前贴纸属性">
          <div className={styles.stickerSectionHead}>
            <span><Icon name="settings" size={13} />当前贴纸</span>
            <span className={styles.stickerCount}>{selectedAsset?.label || selectedSticker.assetId} · {((selectedSticker.endFrame - selectedSticker.startFrame) / 24).toFixed(2)}s</span>
          </div>
          <div className={styles.stickerActionRow}>
            <button type="button" className={styles.stickerActionButton} disabled={busy || !enabled} onClick={() => onDuplicateSticker(selectedSticker.id)}><Icon name="copy" size={12} />复制</button>
            <button type="button" className={`${styles.stickerActionButton} ${styles.stickerActionDanger}`} disabled={busy || !enabled} onClick={() => onDeleteSticker(selectedSticker.id)}><Icon name="trash" size={12} />删除</button>
          </div>
          <label className={styles.stickerPropertyWide}>
            <span>素材风格</span>
            <select
              value={selectedSticker.styleMode === 'follow-template' ? 'follow-template' : selectedSticker.fixedStyle ?? templateStyle}
              disabled={busy || !enabled}
              onChange={(event) => {
                const value = event.target.value;
                onPatchSticker(selectedSticker.id, value === 'follow-template'
                  ? { styleMode: 'follow-template', fixedStyle: null }
                  : { styleMode: 'fixed', fixedStyle: value as StickerStyle });
              }}
            >
              <option value="follow-template" disabled={selectedSticker.assetId === 'special'}>跟随当前模板</option>
              {STICKER_STYLES.map((style) => <option key={style} value={style} disabled={selectedSticker.assetId === 'special' && style !== selectedSticker.fixedStyle}>{STYLE_LABELS[style]}</option>)}
            </select>
          </label>
          <div className={styles.stickerPropertyGrid}>
            <NumberProperty label="中心 X" value={selectedSticker.centerXPct} min={0} max={100} step={0.1} suffix="%" disabled={busy || !enabled} onCommit={(centerXPct) => onPatchSticker(selectedSticker.id, { centerXPct })} />
            <NumberProperty label="中心 Y" value={selectedSticker.centerYPct} min={0} max={100} step={0.1} suffix="%" disabled={busy || !enabled} onCommit={(centerYPct) => onPatchSticker(selectedSticker.id, { centerYPct })} />
            <NumberProperty label="视觉宽度" value={selectedSticker.visualWidthPct} min={1} max={1000} step={1} suffix="%" disabled={busy || !enabled} onCommit={(visualWidthPct) => onPatchSticker(selectedSticker.id, { visualWidthPct })} />
            <NumberProperty label="旋转" value={selectedSticker.rotationDeg} min={-180} max={180} step={1} suffix="°" disabled={busy || !enabled} onCommit={(rotationDeg) => onPatchSticker(selectedSticker.id, { rotationDeg })} />
          </div>
          <p className={styles.hintLine}>也可在预览中拖动位置、角点等比缩放和顶部手柄旋转。</p>
        </section>
      )}
    </div>
  );
}
