'use client';

/**
 * 画布保存管线（从 editor-store 拆出）。
 *
 * 职责：600ms 防抖保存、乐观并发（expectedGraphRevision → 409 冲突标记）、
 * 保存期间的并发编辑串行补保存、页面卸载时 keepalive 兜底与脏状态提醒。
 * 冲突的持续性提示由界面的冲突 banner 承担（saveState='conflict'），
 * 瞬时错误走 toast。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Edge } from '@xyflow/react';
import { CanvasApiError, canvasApi } from '../api';
import { useCanvasToasts } from '../canvas-toasts';
import { canvasErrorText } from '../error-copy';
import type { CanvasFlowNode, SaveState } from '../editor-store';
import { buildCanvasGraph } from './graph-mapping';

const SAVE_DEBOUNCE_MS = 600;

type SaveOutcome = 'clean' | 'saved' | 'changed' | 'conflict' | 'error';

export interface CanvasSavePipeline {
  saveState: SaveState;
  setSaveState: React.Dispatch<React.SetStateAction<SaveState>>;
  revisionRef: React.MutableRefObject<number>;
  markDirty: () => void;
  scheduleSave: () => void;
  saveWithCoalescing: () => Promise<boolean>;
  /** load 成功后复位保存基准（revision／dirty／conflict／待存定时器）。 */
  resetBaseline: (revision: number) => void;
}

export function useCanvasSavePipeline(options: {
  canvasId: string;
  nodesRef: React.MutableRefObject<CanvasFlowNode[]>;
  edgesRef: React.MutableRefObject<Edge[]>;
}): CanvasSavePipeline {
  const { canvasId, nodesRef, edgesRef } = options;
  const toasts = useCanvasToasts();
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const savePromiseRef = useRef<Promise<SaveOutcome> | null>(null);
  const editVersionRef = useRef(0);
  const saveConflictRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markDirty = useCallback(() => {
    editVersionRef.current += 1;
    dirtyRef.current = true;
  }, []);

  const performSave = useCallback(async (): Promise<SaveOutcome> => {
    if (!dirtyRef.current) return 'clean';
    if (savingRef.current) return savePromiseRef.current ?? 'error';
    savingRef.current = true;
    saveConflictRef.current = false;
    const versionAtStart = editVersionRef.current;
    setSaveState('saving');
    const graph = buildCanvasGraph(nodesRef.current, edgesRef.current);
    try {
      const result = await canvasApi.saveGraph(canvasId, {
        expectedGraphRevision: revisionRef.current,
        graph,
      });
      revisionRef.current = result.canvas.graphRevision;
      // 请求期间若有新编辑，旧响应不能清掉 dirty；补保存由这里串行触发。
      const changedDuringSave = editVersionRef.current !== versionAtStart;
      dirtyRef.current = changedDuringSave;
      setSaveState(changedDuringSave ? 'saving' : 'saved');
      // 服务端会对账参考槽位；本地无需回写，保持用户正在编辑的内容不动。
      return changedDuringSave ? 'changed' : 'saved';
    } catch (error) {
      if (error instanceof CanvasApiError && error.status === 409) {
        saveConflictRef.current = true;
        // 冲突是持续性状态，由界面顶部的冲突 banner 承担，不用 toast
        setSaveState('conflict');
        return 'conflict';
      }
      setSaveState('error');
      toasts.push('error', `保存失败：${canvasErrorText(error)}`);
      return 'error';
    } finally {
      savingRef.current = false;
      savePromiseRef.current = null;
    }
  }, [canvasId, nodesRef, edgesRef, toasts]);

  const saveWithCoalescing = useCallback(async (): Promise<boolean> => {
    while (dirtyRef.current && !saveConflictRef.current) {
      const outcome = await (savePromiseRef.current ?? (savePromiseRef.current = performSave()));
      if (outcome === 'changed') continue;
      if (outcome === 'saved' || outcome === 'clean') return !dirtyRef.current;
      // 冲突或网络／校验失败已由 performSave 展示错误；保留 dirty，等待新的用户动作。
      return false;
    }
    return !dirtyRef.current && !saveConflictRef.current;
  }, [performSave]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveWithCoalescing();
    }, SAVE_DEBOUNCE_MS);
  }, [saveWithCoalescing]);

  const resetBaseline = useCallback((revision: number) => {
    revisionRef.current = revision;
    dirtyRef.current = false;
    saveConflictRef.current = false;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }, []);

  // 离开页面时尽力保存未落盘的编辑；有未保存草稿时先提醒用户
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // 冲突态草稿已保留且不可保存，不拦截；正常脏草稿才提醒
      if (!dirtyRef.current || saveConflictRef.current) return;
      event.preventDefault();
    };
    const onPageHide = () => {
      if (!dirtyRef.current) return;
      const graph = buildCanvasGraph(nodesRef.current, edgesRef.current);
      void fetch(`/api/canvas/${canvasId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedGraphRevision: revisionRef.current, graph }),
        keepalive: true,
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [canvasId, nodesRef, edgesRef]);

  return {
    saveState,
    setSaveState,
    revisionRef,
    markDirty,
    scheduleSave,
    saveWithCoalescing,
    resetBaseline,
  };
}
