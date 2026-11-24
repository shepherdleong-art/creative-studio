'use client';

/**
 * 画布 toast 反馈栈：替代原单条 statusMessage banner。
 * 临时消息最多 3 条。新生成的结果另行累加，保留到用户关闭。
 * 最新一条挂 data-testid="status-message"（Playwright 锚点兼容）。
 * 必须包在 useCanvasEditor 之外层（EditorInner 的祖先）。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from '@/components/ui/Icon';
import { formatTaskElapsed, TaskResultThumbnail } from './TaskResultThumbnail';
import type { CanvasNodeCandidateDto } from './api';

export type ToastTone = 'error' | 'success' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

export interface CanvasResultNotice extends Pick<CanvasNodeCandidateDto, 'taskId' | 'assetId' | 'createdAt' | 'completedAt' | 'variantIndex'> {
  title: string;
  mediaKind: 'image' | 'video';
}

export interface CanvasToasts {
  push: (tone: ToastTone, message: string) => void;
  notifyResults: (results: CanvasResultNotice[]) => void;
  /** 兼容旧 showStatus 语义：null 清空全部，非空按 info 显示。 */
  showStatus: (message: string | null) => void;
}

const ToastContext = createContext<CanvasToasts | null>(null);

const TONE_LIFETIME: Record<ToastTone, number> = { error: 6000, success: 3000, info: 4000 };
const MAX_VISIBLE = 3;

export function CanvasToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [newResults, setNewResults] = useState<CanvasResultNotice[]>([]);
  const seqRef = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((tone: ToastTone, message: string) => {
    if (!message) return;
    const id = ++seqRef.current;
    // 只保留最近 MAX_VISIBLE 条，超出的立即移除
    setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), { id, tone, message }]);
    timersRef.current.set(id, setTimeout(() => dismiss(id), TONE_LIFETIME[tone]));
  }, [dismiss]);

  const notifyResults = useCallback((results: CanvasResultNotice[]) => {
    setNewResults((current) => {
      const byTask = new Map(current.map((item) => [item.taskId, item]));
      for (const item of results) byTask.set(item.taskId, item);
      return Array.from(byTask.values()).sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt));
    });
  }, []);

  const showStatus = useCallback((message: string | null) => {
    if (message === null) {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
      setToasts([]);
      setNewResults([]);
      return;
    }
    push('info', message);
  }, [push]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const value = useMemo(() => ({ push, notifyResults, showStatus }), [push, notifyResults, showStatus]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sc-canvas-toasts">
        {toasts.map((toast, index) => (
          <div
            key={toast.id}
            className={`sc-canvas-toast sc-canvas-toast-${toast.tone}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            data-testid={index === toasts.length - 1 ? 'status-message' : undefined}
            onClick={() => dismiss(toast.id)}
          >
            {toast.message}
          </div>
        ))}
        {newResults.length > 0 && (
          <section aria-label="已完成任务" className="sc-canvas-toast w-[min(360px,calc(100vw-32px))] cursor-default p-0">
            <header className="flex items-center gap-2 border-b border-hairline-soft px-3 py-2">
              <div role="status" className="flex flex-1 items-center gap-2">
                <Icon name="check-circle" size={17} className="text-ok" />
                <strong className="text-body">生成成功</strong>
                <span className="tnum ml-auto text-label text-ink-secondary">{newResults.length} 项任务</span>
              </div>
              <button type="button" aria-label="关闭生成成功提醒" className="grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-surface-hover" onClick={() => setNewResults([])}>
                <Icon name="close" size={14} />
              </button>
            </header>
            <ul className="max-h-[min(32dvh,260px)] divide-y divide-hairline-soft overflow-y-auto overscroll-contain">
              {newResults.map(item => {
                const elapsed = formatTaskElapsed(item.createdAt, item.completedAt);
                return (
                  <li key={item.taskId} className="flex items-center gap-3 px-3 py-2.5">
                    <TaskResultThumbnail assetId={item.assetId} mediaKind={item.mediaKind} label={`预览：${item.title}`} className="h-12 w-[72px]" />
                    <div className="min-w-0">
                      <div className="truncate text-body font-medium" title={item.title}>{item.title}</div>
                      <div className="tnum mt-1 text-label text-ink-secondary">
                        {item.mediaKind === 'image' ? '图片' : '视频'}
                        {item.variantIndex > 0 && ` · 方案 ${item.variantIndex + 1}`}
                        {elapsed && ` · 耗时 ${elapsed}`}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useCanvasToasts(): CanvasToasts {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useCanvasToasts 必须在 CanvasToastProvider 内使用');
  return context;
}
