'use client';

// §9 ② / §10 ① 卖点字体下拉选择器（剪映式三版块：系统 / 收藏 / 最近使用）
// - 列表来自后端枚举 API（fontkit cmap 中文检测、中文优先排序已在服务端完成）
// - 搜索输入用 useDeferredValue 保持打字流畅（列表数百项）
// - §10 ①b：三版块常驻渲染，空版块显示引导文案（此前空即隐藏，用户从未见到收藏/最近）
// - §10 ②：顶部内置「模板原生字体」默认项（选中=不注入用户字体，保持各模板原生设计）
// - 收藏/最近使用存 localStorage（版本化 key，天然全局跨项目）
// - 行内字体名用系统字体族渲染（所见即所得）

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import styles from './mixcut-content.module.css';

export interface SystemFontItem {
  key: string;
  file: string;
  family: string;
  nameZh: string;
  supportsCn: boolean;
}

/** 字体槽（物化/API 共用，与后端 FONT_SLOT_ALIASES 对应）。 */
export type FontSlotName = 'title' | 'subtitle' | 'point';

const FAVORITES_KEY = 'packaging-font-favorites-v1';
const RECENT_KEY = 'packaging-font-recent-v1';
const RECENT_LIMIT = 10;
const NONE_LABEL = '模板原生字体';

function readStringArray(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) || '[]');
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string').slice(0, 100);
  } catch { /* 脏数据忽略 */ }
  return [];
}

function displayName(entry: SystemFontItem): string {
  return entry.nameZh ? `${entry.nameZh}（${entry.family}）` : entry.family;
}

export function FontPicker({ current, slot, onSelect, onSelectNone, disabled, noneLabel = NONE_LABEL }: {
  current: { family: string; file: string } | null;
  slot: FontSlotName;
  onSelect: (entry: SystemFontItem, materializedFile: string) => void;
  onSelectNone: () => void;
  disabled?: boolean;
  noneLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [fonts, setFonts] = useState<SystemFontItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => readStringArray(FAVORITES_KEY));
  const [recent, setRecent] = useState<string[]>(() => readStringArray(RECENT_KEY));
  const deferredQuery = useDeferredValue(query);

  const loadFonts = useCallback(async (force: boolean) => {
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(force ? '/api/packaging/system-fonts?refresh=1' : '/api/packaging/system-fonts');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      setFonts(Array.isArray(body.fonts) ? body.fonts : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开面板即拉取列表（服务端有 mtime 缓存，重复打开成本低；bundle-conditional：不打开不请求）
  useEffect(() => {
    const timer = window.setTimeout(() => { if (open) void loadFonts(false); }, 0);
    return () => window.clearTimeout(timer);
  }, [open, loadFonts]);

  useEffect(() => {
    try { window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch { /* 忽略 */ }
  }, [favorites]);
  useEffect(() => {
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* 忽略 */ }
  }, [recent]);

  const byKey = useMemo(() => new Map((fonts ?? []).map((entry) => [entry.key, entry])), [fonts]);
  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const list = fonts ?? [];
    if (!q) return list;
    return list.filter((entry) => entry.family.toLowerCase().includes(q) || entry.nameZh.includes(q) || entry.file.toLowerCase().includes(q));
  }, [fonts, deferredQuery]);
  const favoriteEntries = useMemo(() => favorites.map((key) => byKey.get(key)).filter((entry): entry is SystemFontItem => Boolean(entry)), [favorites, byKey]);
  const recentEntries = useMemo(() => recent.map((key) => byKey.get(key)).filter((entry): entry is SystemFontItem => Boolean(entry)), [recent, byKey]);

  const toggleFavorite = useCallback((key: string) => {
    setFavorites((currentList) => (currentList.includes(key) ? currentList.filter((item) => item !== key) : [...currentList, key]));
  }, []);

  const pushRecent = useCallback((key: string) => {
    setRecent((currentList) => [key, ...currentList.filter((item) => item !== key)].slice(0, RECENT_LIMIT));
  }, []);

  const selectEntry = useCallback((entry: SystemFontItem) => {
    if (disabled) return;
    setOpen(false);
    pushRecent(entry.key);
    void (async () => {
      try {
        const response = await fetch('/api/packaging/system-fonts/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: entry.key, slot }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
        onSelect(entry, String(body.font || ''));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [disabled, onSelect, pushRecent, slot]);

  const selectNone = useCallback(() => {
    if (disabled) return;
    setOpen(false);
    onSelectNone();
  }, [disabled, onSelectNone]);

  const refreshScan = useCallback(() => {
    if (loading) return;
    void loadFonts(true);
  }, [loading, loadFonts]);

  const renderRow = (entry: SystemFontItem, fav: boolean) => (
    <li key={entry.key} className={styles.pkFontItem}>
      <button
        type="button"
        className={`${styles.pkFontPick} ${current?.file === entry.file ? styles.pkFontPickActive : ''}`}
        onClick={() => selectEntry(entry)}
        title={displayName(entry)}
      >
        <span className={styles.pkFontName} style={{ fontFamily: `"${entry.family}", sans-serif` }}>{displayName(entry)}</span>
        {entry.supportsCn && <span className={`${styles.chip} ${styles.chipGrey}`}>中</span>}
      </button>
      <button
        type="button"
        className={`${styles.pkFontStar} ${fav ? styles.pkFontStarOn : ''}`}
        aria-label={fav ? '取消收藏' : '收藏'}
        onClick={() => toggleFavorite(entry.key)}
      >
        {fav ? '★' : '☆'}
      </button>
    </li>
  );

  return (
    <div className={styles.pkFontPicker}>
      <button type="button" className={styles.btn} disabled={disabled} onClick={() => setOpen((value) => !value)}>
        {current ? current.family : noneLabel}
      </button>
      {open && (
        <div className={styles.pkFontPop}>
          <div className={styles.pkFontSearchRow}>
            <input
              type="search"
              className={styles.pkFontSearch}
              placeholder="搜索字体名称…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索字体名称"
            />
            <button type="button" className={styles.textButton} disabled={loading} onClick={refreshScan}>
              {loading ? '扫描中…' : '刷新'}
            </button>
          </div>
          {message ? (
            <p className={styles.exportBlocker}><Icon name="alert" size={14} />{message}</p>
          ) : null}
          <div className={styles.pkFontSections}>
            {([['系统', 'system'], ['收藏', 'favorite'], ['最近使用', 'recent']] as const).map(([title, section]) => {
              if (section === 'system') {
                return (
                  <section key={title}>
                    <h4 className={styles.pkFontSectionTitle}>{title}</h4>
                    <ul className={styles.pkFontList}>
                      <li className={styles.pkFontItem}>
                        <button
                          type="button"
                          className={`${styles.pkFontPick} ${current == null ? styles.pkFontPickActive : ''}`}
                          onClick={selectNone}
                          title={noneLabel}
                        >
                          <span className={styles.pkFontName}>{noneLabel}</span>
                        </button>
                      </li>
                      {!fonts && loading ? <li className={styles.cardSub}>正在扫描系统字体…</li> : (
                        <>
                          {filtered.slice(0, 300).map((entry) => renderRow(entry, favorites.includes(entry.key)))}
                          {filtered.length === 0 && <li className={styles.cardSub}>无匹配字体</li>}
                        </>
                      )}
                    </ul>
                  </section>
                );
              }
              const entries = section === 'favorite' ? favoriteEntries : recentEntries;
              const emptyText = section === 'favorite' ? '暂无收藏，点击字体右侧 ☆ 收藏' : '暂无最近使用';
              return (
                <section key={title}>
                  <h4 className={styles.pkFontSectionTitle}>{title}</h4>
                  <ul className={styles.pkFontList}>
                    {entries.length > 0
                      ? entries.map((entry) => renderRow(entry, section === 'favorite' || favorites.includes(entry.key)))
                      : <li className={styles.pkFontEmpty}>{emptyText}</li>}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}