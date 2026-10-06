'use client';

/**
 * 画布撤销／重做历史栈（从 editor-store 拆出）。
 * 栈上限 100；同一 coalesceKey 在 1.2s 内的连续编辑合并为一条
 * （打字不刷屏历史）；快照由调用方提供／恢复，本模块不碰图内容。
 */

import { useCallback, useRef, useState } from 'react';
import type { Edge } from '@xyflow/react';
import type { CanvasFlowNode } from '../editor-store';
import { cloneEdges, cloneNodes } from './graph-mapping';

const HISTORY_LIMIT = 100;
const COALESCE_WINDOW_MS = 1_200;

export interface CanvasHistorySnapshot {
  nodes: CanvasFlowNode[];
  edges: Edge[];
}

export interface CanvasHistory {
  canUndo: boolean;
  canRedo: boolean;
  historyDepth: { past: number; future: number };
  pushHistory: (coalesceKey?: string) => void;
  pushHistorySnapshot: (snapshot: CanvasHistorySnapshot) => void;
  undo: () => void;
  redo: () => void;
}

export function useCanvasHistory(options: {
  currentSnapshot: () => CanvasHistorySnapshot;
  restore: (snapshot: CanvasHistorySnapshot) => void;
}): CanvasHistory {
  const { currentSnapshot, restore } = options;
  const [past, setPast] = useState<CanvasHistorySnapshot[]>([]);
  const [future, setFuture] = useState<CanvasHistorySnapshot[]>([]);
  const lastCoalesceRef = useRef<{ key: string; at: number } | null>(null);

  const pushHistorySnapshot = useCallback((snapshot: CanvasHistorySnapshot) => {
    setPast((entries) => [...entries.slice(-(HISTORY_LIMIT - 1)), snapshot]);
    setFuture([]);
  }, []);

  const pushHistory = useCallback((coalesceKey?: string) => {
    const now = Date.now();
    const last = lastCoalesceRef.current;
    if (coalesceKey && last && last.key === coalesceKey && now - last.at < COALESCE_WINDOW_MS) {
      lastCoalesceRef.current = { key: coalesceKey, at: now };
      return;
    }
    lastCoalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    pushHistorySnapshot({ nodes: cloneNodes(options.currentSnapshot().nodes), edges: cloneEdges(options.currentSnapshot().edges) });
  }, [options, pushHistorySnapshot]);

  const undo = useCallback(() => {
    const entry = past.at(-1);
    if (!entry) return;
    // 快照必须在调用 setState 之前取：updater 是延迟执行的，
    // 在 updater 里取会拿到 restore 之后的状态。
    const snapshot = currentSnapshot();
    setPast((entries) => entries.slice(0, -1));
    setFuture((pending) => [...pending, snapshot]);
    restore(entry);
  }, [currentSnapshot, past, restore]);

  const redo = useCallback(() => {
    const entry = future.at(-1);
    if (!entry) return;
    const snapshot = currentSnapshot();
    setFuture((entries) => entries.slice(0, -1));
    setPast((pending) => [...pending.slice(-(HISTORY_LIMIT - 1)), snapshot]);
    restore(entry);
  }, [currentSnapshot, future, restore]);

  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    historyDepth: { past: past.length, future: future.length },
    pushHistory,
    pushHistorySnapshot,
    undo,
    redo,
  };
}
