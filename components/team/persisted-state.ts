'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * localStorage 支撑的稳定快照 store。
 *
 * 团队任务页要求「同页刷新保留当前视图、筛选与尚存在组的折叠状态」，所以状态要跨整页刷新存活。
 * 用 useSyncExternalStore 而不是 useEffect+setState：服务端/水合阶段返回回退值，
 * 水合后立刻切到真实值，既没有水合不匹配也不会触发级联渲染。
 */
function createStore<T>(key: string, fallback: T, parse: (raw: string) => T, serialize: (value: T) => string) {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null | undefined;
  let cachedValue: T = fallback;

  function readRaw(): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }

  function getSnapshot(): T {
    const raw = readRaw();
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      try { cachedValue = raw === null ? fallback : parse(raw); } catch { cachedValue = fallback; }
    }
    return cachedValue;
  }

  function getServerSnapshot(): T {
    return fallback;
  }

  function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    window.addEventListener('storage', onChange);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener('storage', onChange);
    };
  }

  function write(value: T): void {
    try {
      if (serialize(value) === serialize(fallback)) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, serialize(value));
    } catch { /* 隐私模式或配额不足时退回内存态 */ }
    cachedRaw = undefined;
    // 本页写自己也要通知，storage 事件不会在同页触发。
    for (const listener of listeners) listener();
  }

  return { getSnapshot, getServerSnapshot, subscribe, write };
}

function stringStore(key: string, fallback: string) {
  return createStore<string>(key, fallback, (raw) => raw, (value) => value);
}

function stringListStore(key: string) {
  const empty: readonly string[] = [];
  return createStore<readonly string[]>(
    key, empty,
    (raw) => {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : empty;
    },
    (value) => JSON.stringify(value),
  );
}

// 三个筛选/视图状态的 store 在模块级创建，才能让快照引用稳定。
const viewStore = stringStore('team-tasks-view', 'grouped');
const statusStore = stringStore('team-tasks-status', '');
const actorStore = stringStore('team-tasks-actor', '');
const collapsedStore = stringListStore('team-tasks-collapsed-actors');

export function usePersistedView(): [string, (value: string) => void] {
  const value = useSyncExternalStore(viewStore.subscribe, viewStore.getSnapshot, viewStore.getServerSnapshot);
  return [value, useCallback((next: string) => viewStore.write(next), [])];
}

export function usePersistedStatus(): [string, (value: string) => void] {
  const value = useSyncExternalStore(statusStore.subscribe, statusStore.getSnapshot, statusStore.getServerSnapshot);
  return [value, useCallback((next: string) => statusStore.write(next), [])];
}

export function usePersistedActor(): [string, (value: string) => void] {
  const value = useSyncExternalStore(actorStore.subscribe, actorStore.getSnapshot, actorStore.getServerSnapshot);
  return [value, useCallback((next: string) => actorStore.write(next), [])];
}

export function usePersistedCollapsedGroups(): [readonly string[], (next: readonly string[]) => void] {
  const value = useSyncExternalStore(collapsedStore.subscribe, collapsedStore.getSnapshot, collapsedStore.getServerSnapshot);
  return [value, useCallback((next: readonly string[]) => collapsedStore.write(next), [])];
}
