'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { fontIdentity, normalizeFavorites } from '@/lib/media-core/font-identity';

/**
 * 字体收藏偏好（浏览器侧）。key 固定为 creative-studio-font-favorites-v1，
 * 值为去重后的 family 字符串数组（最近收藏在前）。跨项目/批次/字幕与封面共用，
 * 不进批次冻结快照、成片版本或导出包。
 *
 * 用 useSyncExternalStore 暴露快照：同页写入主动通知订阅者，跨标签页/窗口通过
 * storage 事件同步，避免多个字体面板各持一份会漂移的 state。
 * localStorage 不可读/损坏/不可写时收藏当场仍生效（内存快照），只是不跨刷新保留。
 */

const STORAGE_KEY = 'creative-studio-font-favorites-v1';
const EMPTY: string[] = [];

const listeners = new Set<() => void>();
/** 内存快照：localStorage 不可用时作为兜底；storage 事件到达时刷新。 */
let memoryFavorites: string[] | null = null;
let initialized = false;

function readStoredFavorites(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeFavorites(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    // 损坏/不可读：安全回落空收藏，不阻塞字体选择。
    return [];
  }
}

function getSnapshot(): string[] {
  if (!initialized) {
    initialized = true;
    memoryFavorites = readStoredFavorites();
  }
  return memoryFavorites ?? EMPTY;
}

function persistFavorites(next: string[]): void {
  memoryFavorites = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage 不可写：保留内存快照，收藏按钮当场有效，只是不跨刷新保留。
  }
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY || event.key === null) {
      memoryFavorites = readStoredFavorites();
      callback();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('storage', onStorage);
  };
}

export function useFontFavorites(): {
  favorites: string[];
  toggleFavorite: (family: string) => void;
} {
  const favorites = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  const toggleFavorite = useCallback((family: string) => {
    const id = fontIdentity(family);
    const current = memoryFavorites ?? [];
    const next = current.some((item) => fontIdentity(item) === id)
      ? current.filter((item) => fontIdentity(item) !== id)
      : normalizeFavorites([family, ...current]);
    persistFavorites(next);
  }, []);
  return { favorites, toggleFavorite };
}
