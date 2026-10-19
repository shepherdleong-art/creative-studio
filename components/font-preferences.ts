'use client';

import { useSyncExternalStore } from 'react';
import { normalizeFavorites } from '@/lib/media-core/font-identity';
import { createFontFavoritesStore, EMPTY_FONT_FAVORITES } from './font-favorites-store';

// 保留旧 key 用于迁移与显示缓存；权威收藏存本机数据库，不受地址/端口隔离。
const STORAGE_KEY = 'creative-studio-font-favorites-v1';
const store = createFontFavoritesStore({
  readCache() {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? normalizeFavorites(parsed.filter((item): item is string => typeof item === 'string')) : [];
    } catch { return []; }
  },
  writeCache(favorites) {
    try {
      const serialized = JSON.stringify(favorites);
      if (localStorage.getItem(STORAGE_KEY) !== serialized) localStorage.setItem(STORAGE_KEY, serialized);
    } catch { /* Database persistence still works. */ }
  },
  async request(body) {
    const response = await fetch('/api/font-favorites', {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('字体收藏请求失败');
    const data = await response.json() as { favorites?: unknown };
    if (!Array.isArray(data.favorites) || !data.favorites.every((item) => typeof item === 'string')) throw new Error('字体收藏响应无效');
    return data.favorites;
  },
});

let subscribers = 0;
let stopSync: (() => void) | undefined;
function subscribe(callback: () => void): () => void {
  const unsubscribe = store.subscribe(callback);
  if (subscribers++ === 0) {
    const refresh = () => { if (document.visibilityState !== 'hidden') void store.refresh(); };
    const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 15_000);
    stopSync = () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', refresh);
    };
    refresh();
  }
  return () => {
    unsubscribe();
    if (--subscribers === 0) stopSync?.();
  };
}

export function useFontFavorites() {
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, () => EMPTY_FONT_FAVORITES);
  return { ...snapshot, toggleFavorite: store.toggleFavorite, refreshFavorites: store.refresh };
}
