'use client';

import { useEffect, useState, type RefObject } from 'react';

/** A 202 JSON response puts <video> into a terminal error state until load() is called. */
export function useBrowserPreviewRecovery(ref: RefObject<HTMLVideoElement | null>, src: string | undefined, active = true) {
  const [state, setState] = useState<'ready' | 'pending' | 'failed'>('ready');
  const [retryId, setRetryId] = useState(0);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src || !active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probing = false;
    const controller = new AbortController();
    const deadline = Date.now() + 120_000;
    const schedule = (delay: number) => {
      if (disposed) return;
      if (Date.now() >= deadline) { setState('failed'); return; }
      setState('pending');
      clearTimeout(timer);
      timer = setTimeout(() => { void probe(); }, delay);
    };
    const probe = async () => {
      if (disposed || probing) return;
      probing = true;
      try {
        // Probe only the first byte; cancel the body even if the server ignores Range.
        const response = await fetch(src, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (response.status === 202) {
          const body = await response.json();
          if (disposed) return;
          if (body.error !== 'preview_pending') { setState('failed'); return; }
          schedule(Math.min(5000, Math.max(250, Number(body.retryAfterMs) || 1000)));
        } else {
          await response.body?.cancel();
          if (disposed) return;
          if (response.ok) video.load();
          else setState('failed');
        }
      } catch {
        if (!disposed) schedule(1000);
      } finally { probing = false; }
    };
    const onError = () => { if (!probing) schedule(1000); };
    const onLoaded = () => { clearTimeout(timer); if (!disposed) setState('ready'); };
    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoaded);
    if (video.error || retryId > 0) schedule(0);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoaded);
    };
  }, [active, ref, retryId, src]);

  return { state, retry: () => setRetryId(value => value + 1) };
}
