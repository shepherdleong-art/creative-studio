'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { getCachedFontOptions, requestFontOptions } from '@/components/system-fonts';
import { useFontFavorites } from '@/components/font-preferences';
import {
  fontIdentity,
  mergeFontSources,
  sortFontFamilies,
} from '@/lib/media-core/font-identity';
import styles from './SystemFontPicker.module.css';

export interface SystemFontPickerProps {
  value: string;
  ariaLabel?: string;
  disabled?: boolean;
  onChange: (family: string) => void;
  compact?: boolean;
  /** 封面抽屉等场景提供 dialog 内的 overlay host，浮层挂到 host 而非 document.body。 */
  portalRoot?: HTMLElement | null;
}

const BATCH_SIZE = 80;
const SAMPLE_TEXT = '春风正好 Aa 123';

type FontRowGroup = 'current' | 'favorite' | 'rest';

const GROUP_LABELS: Record<FontRowGroup, string> = {
  current: '当前字体',
  favorite: '收藏',
  rest: '全部字体',
};

interface FontRow {
  family: string;
  group: FontRowGroup;
  /** 当前选中但未检测到：置顶「当前字体」保护行。 */
  currentMissing?: boolean;
  /** 已收藏但当前未检测到：仅「收藏」页显示为不可选行。 */
  favoriteMissing?: boolean;
}

export default function SystemFontPicker({
  value,
  ariaLabel = '字体',
  disabled = false,
  onChange,
  compact = false,
  portalRoot,
}: SystemFontPickerProps) {
  const [open, setOpen] = useState(false);
  // fonts 只装「检测到的字体目录」（服务端扫盘 + queryLocalFonts）。
  // 绝不把当前 value 掺进来——掺了 currentMissing 就恒为 false，
  // 「当前字体」保护行永远不渲染，缺失字体会被静默当成普通可选项。
  const [fonts, setFonts] = useState<string[]>(() => getCachedFontOptions() ?? []);
  /** 目录就绪前不得把任何字体判成「未检测到」，否则首帧会误报缺失。 */
  const [catalogReady, setCatalogReady] = useState(() => getCachedFontOptions() !== null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'favorites'>('all');
  const [refreshError, setRefreshError] = useState('');
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeControl, setActiveControl] = useState<'select' | 'star'>('select');
  /** 扩容后落焦点的统一通路：End / 边界 ArrowDown 先扩容再聚焦，经 state 触发渲染后的 effect。 */
  const [pendingFocus, setPendingFocus] = useState<{ index: number; control: 'select' | 'star' } | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; upward: boolean } | null>(null);
  const { favorites, toggleFavorite } = useFontFavorites();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // stale-while-revalidate：首帧用缓存，挂载后后台拉最新，不重置搜索/页签/收藏/选择。
  useEffect(() => {
    void requestFontOptions().then((options) => {
      setFonts((current) => mergeFontSources([current, options]));
      setCatalogReady(true);
    }).catch(() => undefined);
  }, []);

  const fontsById = useMemo(() => new Set(fonts.map(fontIdentity)), [fonts]);
  /** 目录未就绪时一律按「已检测到」处理，只有拿到目录后才敢判缺失。 */
  const isDetected = useCallback(
    (family: string) => !catalogReady || fontsById.has(fontIdentity(family)),
    [catalogReady, fontsById],
  );
  const currentMissing = Boolean(value) && !isDetected(value);
  const favoritesById = useMemo(() => new Set(favorites.map(fontIdentity)), [favorites]);

  // 「全部」页：当前缺失保护行 → 收藏 → 其余（收藏按偏好顺序，其余按 collator）。
  const allBase = useMemo<FontRow[]>(() => {
    const rows: FontRow[] = [];
    if (currentMissing) rows.push({ family: value, group: 'current', currentMissing: true });
    for (const family of sortFontFamilies(fonts, favorites)) {
      rows.push({ family, group: favoritesById.has(fontIdentity(family)) ? 'favorite' : 'rest' });
    }
    return rows;
  }, [fonts, favorites, favoritesById, currentMissing, value]);

  // 「收藏」页：收藏里在册的可选行 + 收藏里缺失的不可选行。
  const favoritesBase = useMemo<FontRow[]>(
    () => favorites.map((family) => (isDetected(family)
      ? { family, group: 'favorite' as const }
      : { family, group: 'favorite' as const, favoriteMissing: true })),
    [favorites, isDetected],
  );

  const filterRows = useCallback((rows: FontRow[], q: string): FontRow[] => {
    const id = fontIdentity(q);
    if (!id) return rows;
    return rows.filter((row) => fontIdentity(row.family).includes(id));
  }, []);

  const allRows = useMemo(() => filterRows(allBase, query), [allBase, query, filterRows]);
  const favRows = useMemo(() => filterRows(favoritesBase, query), [favoritesBase, query, filterRows]);

  // 全部页渐进加载：当前字体与收藏组始终完整，其余按批追加。
  const allHead = allRows.filter((row) => row.group !== 'rest');
  const allTail = allRows.filter((row) => row.group === 'rest');
  const allVisible = [...allHead, ...allTail.slice(0, visibleCount)];
  const visibleRows = tab === 'all' ? allVisible : favRows;
  const hasMore = tab === 'all' && visibleCount < allTail.length;
  /** 只有同时存在多个组时才显示分组标题，单组时标题是噪音。 */
  const showGroups = new Set(visibleRows.map((row) => row.group)).size > 1;

  const refresh = useCallback(async () => {
    setRefreshError('');
    try {
      const options = await requestFontOptions(true);
      setFonts((current) => mergeFontSources([current, options]));
      setCatalogReady(true);
    } catch {
      setRefreshError('刷新失败，已保留现有列表');
    }
  }, []);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPosition(null);
    setActiveIndex(-1);
    setPendingFocus(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const selectFamily = useCallback((family: string) => {
    onChange(family);
    close(true);
  }, [onChange, close]);

  // 打开时计算浮层位置；监听 resize 与捕获阶段 scroll 重算，避免被右栏 overflow 裁掉。
  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(320, Math.max(240, rect.width));
      const height = 360;
      const upward = rect.bottom + height > window.innerHeight - 12 && rect.top - height > 12;
      const top = upward ? rect.top - height : rect.bottom + 6;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setPosition({ top: Math.max(8, top), left, width, upward });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  // 打开后：搜索框自动聚焦；Esc 关闭并把焦点还给触发器。
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const input = overlayRef.current?.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
      if (input) input.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 点外部或 Tab 移出：只关闭浮层，不抢回触发器焦点。
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (overlayRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === 'Tab') {
        // 焦点移到浮层之外 → 关闭（不抢焦点）；抽屉场景由外层陷阱接管。
        window.setTimeout(() => {
          const active = document.activeElement as Node | null;
          if (active && !overlayRef.current?.contains(active)) close(false);
        }, 0);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  const focusRowControl = useCallback((index: number, control: 'select' | 'star') => {
    const el = overlayRef.current?.querySelector<HTMLButtonElement>(
      `[data-font-row="${index}"][data-font-control="${control}"]`,
    );
    if (el) el.focus();
  }, []);

  // 消费 pendingFocus：在列表扩容后的这次渲染里聚焦，行不存在时静默跳过；
  // 清空延后到宏任务，避免 effect 内同步 setState 触发级联渲染。
  useEffect(() => {
    if (!pendingFocus) return;
    focusRowControl(pendingFocus.index, pendingFocus.control);
    const timer = window.setTimeout(() => setPendingFocus(null), 0);
    return () => window.clearTimeout(timer);
  }, [pendingFocus, focusRowControl]);

  const handleListKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      // 全部页在当前批次最后一行且还有更多时：先追加下一批，再落焦点到 activeIndex + 1
      // （追加后它一定存在），不能被扩容前的 visibleRows.length 钳回原位。
      if (event.key === 'ArrowDown' && tab === 'all' && activeIndex >= 0 && activeIndex === visibleRows.length - 1 && hasMore) {
        const next = activeIndex + 1;
        setVisibleCount((count) => count + BATCH_SIZE);
        setActiveIndex(next);
        setPendingFocus({ index: next, control: activeControl });
        return;
      }
      let next = activeIndex;
      if (activeIndex < 0) {
        next = event.key === 'ArrowDown' ? 0 : visibleRows.length - 1;
      } else {
        next = event.key === 'ArrowDown' ? Math.min(visibleRows.length - 1, activeIndex + 1) : Math.max(0, activeIndex - 1);
      }
      setActiveIndex(next);
      focusRowControl(next, activeControl);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const nextControl = activeControl === 'select' ? 'star' : 'select';
      setActiveControl(nextControl);
      if (activeIndex >= 0) focusRowControl(activeIndex, nextControl);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      focusRowControl(0, activeControl);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      // End 加载完整结果并聚焦真正的末项：按扩容后的行数算下标，不依赖旧闭包的 visibleRows.length。
      const last = tab === 'all' ? allHead.length + allTail.length - 1 : favRows.length - 1;
      if (last < 0) return;
      if (tab === 'all') setVisibleCount(allTail.length);
      setActiveIndex(last);
      setPendingFocus({ index: last, control: activeControl });
      return;
    }
  }, [activeIndex, activeControl, visibleRows.length, hasMore, tab, allTail.length, allHead.length, favRows.length, focusRowControl]);

  const onListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
      setVisibleCount((count) => count + BATCH_SIZE);
    }
  }, []);

  const switchTab = useCallback((nextTab: 'all' | 'favorites') => {
    setTab(nextTab);
    setVisibleCount(BATCH_SIZE);
    setActiveIndex(-1);
    setPendingFocus(null);
  }, []);

  const changeQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    setVisibleCount(BATCH_SIZE);
    setActiveIndex(-1);
    setPendingFocus(null);
  }, []);

  const isFavorite = useCallback((family: string) => favoritesById.has(fontIdentity(family)), [favoritesById]);

  const overlay = open && position ? createPortal(
    <div
      id="system-font-picker-overlay"
      ref={overlayRef}
      className={styles.overlay}
      role="dialog"
      aria-label={`${ariaLabel}选择`}
      style={{ top: position.top, left: position.left, width: position.width, maxHeight: 360 }}
    >
      <div className={styles.header}>
        <div className={styles.searchWrap}>
          <Icon name="search" size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            type="text"
            value={query}
            placeholder="搜索字体"
            aria-label="搜索字体"
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(0);
                focusRowControl(0, 'select');
              }
            }}
          />
          {query && (
            <button type="button" className={styles.searchClear} aria-label="清空搜索" onClick={() => changeQuery('')}>
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        <div className={styles.tabs} role="tablist" aria-label="字体范围">
          <button type="button" role="tab" aria-selected={tab === 'all'} className={`${styles.tab} ${tab === 'all' ? styles.tabActive : ''}`} onClick={() => switchTab('all')}>全部</button>
          <button type="button" role="tab" aria-selected={tab === 'favorites'} className={`${styles.tab} ${tab === 'favorites' ? styles.tabActive : ''}`} onClick={() => switchTab('favorites')}>收藏</button>
        </div>
      </div>
      <div ref={bodyRef} className={styles.body} onScroll={onListScroll} onKeyDown={handleListKeyDown} role="list" aria-label="字体列表">
        {visibleRows.length === 0 && (
          <div className={styles.empty}>{catalogReady ? '没有找到匹配字体' : '正在读取系统字体…'}</div>
        )}
        {visibleRows.map((row, index) => {
          const selected = fontIdentity(row.family) === fontIdentity(value);
          const favorite = isFavorite(row.family);
          const unusable = Boolean(row.currentMissing || row.favoriteMissing);
          // 分组标题不占行号：data-font-row 仍是纯行索引，键盘导航不受影响。
          const heading = showGroups && (index === 0 || visibleRows[index - 1].group !== row.group)
            ? <div className={styles.groupTitle}>{GROUP_LABELS[row.group]}</div>
            : null;
          return (
            <Fragment key={row.family}>
              {heading}
              <div className={`${styles.row} ${selected ? styles.rowSelected : ''}`} role="listitem">
                <button
                  type="button"
                  data-font-row={index}
                  data-font-control="select"
                  className={styles.sample}
                  style={unusable ? undefined : { fontFamily: `"${row.family.replace(/"/gu, '\\"')}", sans-serif` }}
                  aria-disabled={unusable ? true : undefined}
                  aria-label={`${row.family}${selected ? '（当前）' : ''}${unusable ? '（当前未检测到）' : ''}`}
                  onClick={() => { if (!unusable) selectFamily(row.family); }}
                >
                  <span className={styles.familyName}>{row.family}</span>
                  <span className={unusable ? styles.sampleDisabled : ''}>{SAMPLE_TEXT}</span>
                </button>
                {unusable && <span className={styles.missingTag}>未检测到</span>}
                <button
                  type="button"
                  data-font-row={index}
                  data-font-control="star"
                  className={`${styles.starButton} ${favorite ? styles.starOn : ''}`}
                  aria-label={favorite ? `取消收藏 ${row.family}` : `收藏 ${row.family}`}
                  aria-pressed={favorite}
                  onClick={() => toggleFavorite(row.family)}
                >
                  <Icon name="star" size={14} />
                </button>
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className={styles.footer}>
        <span>{visibleRows.length}{hasMore ? '+' : ''} 个字体</span>
        <button type="button" className={styles.refreshButton} onClick={() => void refresh()}>刷新字体</button>
        {refreshError && <span className={styles.refreshError}>{refreshError}</span>}
      </div>
    </div>,
    portalRoot ?? document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${compact ? styles.triggerCompact : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'system-font-picker-overlay' : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.triggerLabel} style={value ? { fontFamily: `"${value.replace(/"/gu, '\\"')}", sans-serif` } : undefined}>{value || '选择字体'}</span>
        <Icon name="chevron-down" size={14} className={styles.triggerChevron} />
      </button>
      {overlay}
    </>
  );
}
