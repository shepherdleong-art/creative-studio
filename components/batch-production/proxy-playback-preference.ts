'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * 代理播放偏好（浏览器侧，B1 总开关）。key 固定为 creative-studio-proxy-playback，
 * 值为 '1'/'0'，默认开（true=所有播放位优先代理解析，关=全局播原片用于核对画质）。
 * 跨项目/批次/播放位共用，纯 UI 状态：不触发任何生成/清理请求，不进批次冻结快照、
 * 成片版本或导出包。
 *
 * 用 useSyncExternalStore 暴露快照：同页写入主动通知订阅者，跨标签页/窗口通过
 * storage 事件同步，避免多个播放位各持一份会漂移的 state。
 * localStorage 不可读/损坏/不可写时当场仍生效（内存快照），只是不跨刷新保留。
 */

const STORAGE_KEY = 'creative-studio-proxy-playback';
const DEFAULT_VALUE = true;

const listeners = new Set<() => void>();
/** 内存快照：localStorage 不可用时作为兜底；storage 事件到达时刷新。 */
let memoryValue: boolean | null = null;
let initialized = false;

function readStoredValue(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VALUE;
    if (raw === '1') return true;
    if (raw === '0') return false;
    return DEFAULT_VALUE;
  } catch {
    // 不可读（隐私模式等）：安全回落默认开，不阻塞预览。
    return DEFAULT_VALUE;
  }
}

function getSnapshot(): boolean {
  if (!initialized) {
    initialized = true;
    memoryValue = readStoredValue();
  }
  return memoryValue ?? DEFAULT_VALUE;
}

function persistValue(next: boolean): void {
  memoryValue = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // localStorage 不可写：保留内存快照，开关当场有效，只是不跨刷新保留。
  }
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY || event.key === null) {
      memoryValue = readStoredValue();
      callback();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('storage', onStorage);
  };
}

export function useProxyPlaybackPreference(): {
  proxyPlayback: boolean;
  setProxyPlayback: (value: boolean) => void;
} {
  const proxyPlayback = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_VALUE);
  const setProxyPlayback = useCallback((value: boolean) => persistValue(value), []);
  return { proxyPlayback, setProxyPlayback };
}
