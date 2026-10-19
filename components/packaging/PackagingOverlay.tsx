'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PackagingPointLayout } from '@/lib/media-core/packaging-vars';

type PreviewWindow = Window & { __timelines?: { overlay?: { pause: () => void; seek: (time: number) => void } }; __editMode?: { active: boolean; only: null } };
export type PackagingTextEditTarget = { pointId: string; rect: { left: number; top: number; width: number; height: number }; frame: { left: number; top: number } };

export default function PackagingOverlay({ src, srcDoc, timeSec, editable = false, onLayout, onText }: {
  src?: string; srcDoc?: string; timeSec: number; editable?: boolean;
  onLayout?: (id: string, layout: PackagingPointLayout | null) => void;
  onText?: (target: PackagingTextEditTarget) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  const seek = useCallback(() => {
    const win = frame.current?.contentWindow as PreviewWindow | null;
    if (!win) return false;
    win.__editMode = { active: editable, only: null };
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
    <iframe ref={frame} src={src} srcDoc={srcDoc} title={editable ? '包装版式编辑' : '包装效果叠加层'} onLoad={() => { setError(''); seek(); }} className="absolute inset-0 h-full w-full border-0" style={{ pointerEvents: editable ? 'auto' : 'none' }} />
    {error && <p role="alert" className="absolute inset-x-0 bottom-0 bg-surface p-2 text-xs text-fail">{error}</p>}
  </>;
}
