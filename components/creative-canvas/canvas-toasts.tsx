'use client';

/**
 * 画布 toast 反馈栈：替代原单条 statusMessage banner。
 * error 6s / success 3s / info 4s 自动消失，同屏最多 3 条，点击可提前关闭。
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

export type ToastTone = 'error' | 'success' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

export interface CanvasToasts {
  push: (tone: ToastTone, message: string) => void;
  /** 兼容旧 showStatus 语义：null 清空全部，非空按 info 显示。 */
  showStatus: (message: string | null) => void;
}

const ToastContext = createContext<CanvasToasts | null>(null);

const TONE_LIFETIME: Record<ToastTone, number> = { error: 6000, success: 3000, info: 4000 };
const MAX_VISIBLE = 3;

export function CanvasToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
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

  const showStatus = useCallback((message: string | null) => {
    if (message === null) {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
      setToasts([]);
      return;
    }
    push('info', message);
  }, [push]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const value = useMemo(() => ({ push, showStatus }), [push, showStatus]);

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
      </div>
    </ToastContext.Provider>
  );
}

export function useCanvasToasts(): CanvasToasts {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useCanvasToasts 必须在 CanvasToastProvider 内使用');
  return context;
}
