'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PackagingPointLayout } from '@/lib/media-core/packaging-vars';
import type { PackagingStickerEditPatch, PackagingStickerInstance } from '@/lib/media-core/packaging-stickers';

type PreviewWindow = Window & {
  __timelines?: { overlay?: { pause: () => void; seek: (time: number) => void } };
  __editMode?: { active: boolean; only: string | null };
  __stickerEditMode?: { active: boolean; only: string | null; snapEnabled: boolean };
  __packagingStickerEditBridge?: { sync?: () => void };
  compositionVariables?: { stickers?: PackagingStickerInstance[] };
};
export type PackagingTextEditTarget = { pointId: string; rect: { left: number; top: number; width: number; height: number }; frame: { left: number; top: number } };

type StickerHandlers = {
  onStickerSelect?: (stickerId: string) => void;
  onStickerCommit?: (stickerId: string, patch: PackagingStickerEditPatch) => void;
  onStickerDelete?: (stickerId: string) => void;
  onStickerExit?: () => void;
};

export default function PackagingOverlay({
  src,
  srcDoc,
  timeSec,
  editable = false,
  stickerEditId = '',
  stickerSnapEnabled = true,
  onLayout,
  onText,
  onFrame,
  onStickerSelect,
  onStickerCommit,
  onStickerDelete,
  onStickerExit,
}: {
  src?: string;
  srcDoc?: string;
  timeSec: number;
  editable?: boolean;
  stickerEditId?: string;
  stickerSnapEnabled?: boolean;
  onLayout?: (id: string, layout: PackagingPointLayout | null) => void;
  onText?: (target: PackagingTextEditTarget) => void;
  onFrame?: (frame: HTMLIFrameElement | null) => void;
} & StickerHandlers) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  const attachFrame = useCallback((element: HTMLIFrameElement | null) => {
    frame.current = element;
    onFrame?.(element);
  }, [onFrame]);
  const seek = useCallback(() => {
    const win = frame.current?.contentWindow as PreviewWindow | null;
    if (!win) return false;
    Object.assign(win, { __editMode: { active: editable, only: null } });
    const timeline = win.__timelines?.overlay;
    if (!timeline) return false;
    timeline.pause();
    timeline.seek(Math.max(0, timeSec));
    return true;
  }, [editable, timeSec]);
  useEffect(() => { seek(); }, [seek]);
  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      if (seek()) { window.clearInterval(timer); return; }
      if (++tries > 100) { setError('包装预览加载失败，请重新打开'); window.clearInterval(timer); }
    }, 100);
    return () => window.clearInterval(timer);
  }, [src, srcDoc, seek]);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    const apply = () => {
      try {
        const win = iframe.contentWindow as PreviewWindow | null;
        if (!win) return;
        Object.assign(win, { __stickerEditMode: { active: Boolean(stickerEditId), only: stickerEditId || null, snapEnabled: stickerSnapEnabled } });
        win.__packagingStickerEditBridge?.sync?.();
      } catch { /* 文档切换期间等待下一次 load 或状态同步 */ }
    };
    apply();
    iframe.addEventListener('load', apply);
    return () => iframe.removeEventListener('load', apply);
  }, [src, srcDoc, stickerEditId, stickerSnapEnabled]);

  const stickerHandlersRef = useRef<StickerHandlers>({});
  useEffect(() => {
    stickerHandlersRef.current = { onStickerSelect, onStickerCommit, onStickerDelete, onStickerExit };
  });
  const stickerCallbacksEnabled = Boolean(onStickerSelect || onStickerCommit || onStickerDelete || onStickerExit);
  useEffect(() => {
    if (!stickerCallbacksEnabled) return;
    const target = window as Window & {
      __packagingStickerEditSelect?: (stickerId: string) => void;
      __packagingStickerEditCommit?: (stickerId: string, patch: PackagingStickerEditPatch) => void;
      __packagingStickerEditDelete?: (stickerId: string) => void;
      __packagingStickerEditExit?: () => void;
    };
    const select = (stickerId: string) => stickerHandlersRef.current.onStickerSelect?.(stickerId);
    const commit = (stickerId: string, patch: PackagingStickerEditPatch) => stickerHandlersRef.current.onStickerCommit?.(stickerId, patch);
    const remove = (stickerId: string) => stickerHandlersRef.current.onStickerDelete?.(stickerId);
    const exit = () => stickerHandlersRef.current.onStickerExit?.();
    target.__packagingStickerEditSelect = select;
    target.__packagingStickerEditCommit = commit;
    target.__packagingStickerEditDelete = remove;
    target.__packagingStickerEditExit = exit;
    return () => {
      if (target.__packagingStickerEditSelect === select) delete target.__packagingStickerEditSelect;
      if (target.__packagingStickerEditCommit === commit) delete target.__packagingStickerEditCommit;
      if (target.__packagingStickerEditDelete === remove) delete target.__packagingStickerEditDelete;
      if (target.__packagingStickerEditExit === exit) delete target.__packagingStickerEditExit;
    };
  }, [stickerCallbacksEnabled]);

  // 未选中贴纸时桥处于 only=null 的关闭态；在 iframe 捕获阶段只接管贴纸命中，
  // 其余文字编辑事件继续交给既有包装桥。选中后由贴纸桥全权处理空间编辑。
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe || !stickerCallbacksEnabled) return;
    let detachDocument: (() => void) | null = null;
    const attach = () => {
      detachDocument?.();
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow as PreviewWindow | null;
      if (!doc || !win) return;
      const probe = (event: PointerEvent) => {
        if (event.button !== 0 || (win.__stickerEditMode?.active && win.__stickerEditMode.only)) return;
        const stack = doc.elementsFromPoint(event.clientX, event.clientY);
        for (const node of stack) {
          const element = node as Element;
          const sticker = element.closest?.('.packaging-sticker[data-sticker-id]');
          if (!sticker) continue;
          const style = win.getComputedStyle(sticker);
          const opacity = Number.parseFloat(style.opacity);
          if (style.display === 'none' || style.visibility === 'hidden' || (Number.isFinite(opacity) && opacity < 0.05)) continue;
          const stickerId = sticker.getAttribute('data-sticker-id');
          if (!stickerId) continue;
          event.preventDefault();
          event.stopImmediatePropagation();
          stickerHandlersRef.current.onStickerSelect?.(stickerId);
          return;
        }
      };
      win.addEventListener('pointerdown', probe, true);
      detachDocument = () => win.removeEventListener('pointerdown', probe, true);
    };
    attach();
    iframe.addEventListener('load', attach);
    return () => {
      iframe.removeEventListener('load', attach);
      detachDocument?.();
    };
  }, [src, srcDoc, stickerCallbacksEnabled]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!editable || event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data.id !== 'string' || !/^(cover:|cue:)/.test(data.id)) return;
      if (data.type === 'packaging:layout') onLayout?.(data.id, data.layout);
      if (data.type === 'packaging:text' && data.rect && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(data.rect[key]))) {
        const bounds = frame.current?.getBoundingClientRect();
        if (bounds) onText?.({ pointId: data.id, rect: data.rect, frame: { left: bounds.left, top: bounds.top } });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [editable, onLayout, onText]);
  return <>
    <iframe ref={attachFrame} src={src} srcDoc={srcDoc} title={editable || stickerEditId ? '包装版式编辑' : '包装效果叠加层'} onLoad={() => { setError(''); seek(); }} className="absolute inset-0 h-full w-full border-0" style={{ pointerEvents: editable || stickerEditId ? 'auto' : 'none' }} />
    {error && <p role="alert" className="absolute inset-x-0 bottom-0 bg-surface p-2 text-xs text-fail">{error}</p>}
  </>;
}
