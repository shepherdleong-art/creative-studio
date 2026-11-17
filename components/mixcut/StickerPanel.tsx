'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { PackagingTemplateId } from '@/lib/final-edit/packaging-vars';
import {
  STICKER_STYLE_BY_TEMPLATE,
  resolveStickerStyle,
  type PackagingStickerEditPatch,
  type PackagingStickerInstance,
  type StickerAnimation,
  type StickerStyle,
} from '@/lib/media-core/packaging-stickers';
import { StickerAnimationPopover } from './StickerAnimationPopover';
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

export function StickerPanel({ active, enabled, busy, template, stickers, selectedSticker, defaultAnimation, addBlockedReason, autoLayoutBlockedReason, onAdd, onDragStart, onDragEnd, onPatchSticker, onDefaultAnimationChange, onApplyAnimationToAll, onPlaySticker, onAutoLayout }: {
  active: boolean;
  enabled: boolean;
  busy: boolean;
  template: PackagingTemplateId;
  stickers: PackagingStickerInstance[];
  selectedSticker: PackagingStickerInstance | null;
  defaultAnimation: StickerAnimation;
  addBlockedReason: string;
  autoLayoutBlockedReason: string;
  onAdd: (choice: StickerAssetChoice) => void;
  onDragStart: (choice: StickerAssetChoice) => void;
  onDragEnd: () => void;
  onPatchSticker: (id: string, patch: PackagingStickerEditPatch) => Promise<boolean>;
  onDefaultAnimationChange: (animation: StickerAnimation) => void;
  onApplyAnimationToAll: (animation: StickerAnimation) => void;
  onPlaySticker: (id: string) => void;
  onAutoLayout: (assets: StickerCatalogAsset[]) => void;
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
  const templateAssets = useMemo(() => assets.filter((asset) => asset.style === templateStyle), [assets, templateStyle]);
  const hasAutomatic = stickers.some((sticker) => sticker.origin.kind === 'auto');
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
  const currentAnimation = selectedSticker?.animation ?? defaultAnimation;
  const selectedLabel = selectedSticker ? selectedAsset?.label || selectedSticker.assetId : '';

  return (
    <div className={styles.stickerPanel}>
      <section className={styles.stickerAnimationDefaults} aria-label="动效设置">
        <div className={styles.stickerAnimationDefaultRow}>
          <span>{selectedSticker ? `动效 · 当前贴纸（${selectedLabel}）` : '动效 · 新贴纸默认'}</span>
          <span>{selectedSticker ? '仅当前贴纸' : '仅之后新增'}</span>
        </div>
        <div className={styles.stickerAnimationControls}>
          <StickerAnimationPopover
            value={currentAnimation}
            template={template}
            disabled={busy || !enabled}
            allowFollowTemplate
            onChange={(animation) => {
              if (!selectedSticker) {
                onDefaultAnimationChange(animation);
                return;
              }
              void onPatchSticker(selectedSticker.id, { animation }).then((accepted) => {
                if (accepted) onPlaySticker(selectedSticker.id);
              });
            }}
          />
          <button
            type="button"
            className={styles.stickerAutoButton}
            aria-label={hasAutomatic ? '换一组基础贴纸' : '一键基础布置'}
            title={hasAutomatic ? '换一组基础贴纸' : '一键基础布置'}
            disabled={busy || !enabled || !loaded || Boolean(error) || Boolean(autoLayoutBlockedReason)}
            onClick={() => onAutoLayout(templateAssets)}
          ><Icon name="sparkle" size={13} />{hasAutomatic ? '换一组' : '一键布置'}</button>
        </div>
        <button type="button" className={styles.stickerAnimationApplyAll} disabled={busy || !enabled || stickers.length === 0} onClick={() => onApplyAnimationToAll(currentAnimation)}>应用到全部贴纸</button>
        {autoLayoutBlockedReason && <p className={styles.hintLine}>{autoLayoutBlockedReason}</p>}
      </section>

      <div className={styles.stickerLibraryTools}>
        <div className={styles.stickerScope} role="group" aria-label="素材风格范围">
          <button type="button" className={scope === 'current' ? styles.stickerScopeActive : ''} onClick={() => setScope('current')}>当前模板</button>
          <button type="button" className={scope === 'all' ? styles.stickerScopeActive : ''} onClick={() => setScope('all')}>全部风格</button>
        </div>
        <label className={styles.stickerSearch}>
          <Icon name="search" size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索贴纸" aria-label="搜索贴纸名称" />
          {query && <button type="button" aria-label="清空贴纸搜索" onClick={() => setQuery('')}><Icon name="close" size={12} /></button>}
        </label>
      </div>

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
          <div className={styles.stickerResultMeta} aria-live="polite"><span>{filteredAssets.length} 张 · 点击添加或拖入预览</span><span>{stickers.length} 张已放置</span></div>
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
    </div>
  );
}
