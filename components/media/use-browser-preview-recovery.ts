'use client';

import { useEffect, useState, type RefObject } from 'react';

/** A 202 JSON response puts <video> into a terminal error state until load() is called. */
export function useBrowserPreviewRecovery(ref: RefObject<HTMLVideoElement | null>, src: string | undefined, active = true) {
  const [status, setStatus] = useState<{ src: string | undefined; state: 'ready' | 'pending' | 'failed' }>({ src, state: 'ready' });
  const [retryId, setRetryId] = useState(0);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src || !active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let probing = false;
    let failed = false;
    const controller = new AbortController();
    const setState = (state: 'ready' | 'pending' | 'failed') => {
      if (!disposed) setStatus({ src, state });
    };
    const fail = () => {
      failed = true;
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      controller.abort();
      setState('failed');
    };
    const schedule = (delay: number) => {
      if (disposed || failed) return;
      // 包括成功探测后的第二次 video 请求：若它无响应，也不能无限“加载中”。
      deadlineTimer ??= setTimeout(fail, 120_000);
      setState('pending');
      clearTimeout(timer);
      timer = setTimeout(() => { void probe(); }, delay);
    };
    const probe = async () => {
      if (disposed || failed || probing) return;
      probing = true;
      try {
        // Probe only the first byte; cancel the body even if the server ignores Range.
        const response = await fetch(src, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (response.status === 202) {
          const body = await response.json();
          if (disposed || failed) return;
          if (body.error !== 'preview_pending') { fail(); return; }
          schedule(Math.min(5000, Math.max(250, Number(body.retryAfterMs) || 1000)));
        } else {
          await response.body?.cancel();
          if (disposed || failed) return;
          if (response.ok) { video.load(); schedule(10_000); }
          else fail();
        }
      } catch {
        if (!disposed) schedule(1000);
      } finally { probing = false; }
    };
    const onError = () => schedule(1000);
    const onWaiting = () => schedule(10_000);
    const onLoaded = () => {
      if (failed || video.readyState < 2 || video.seeking) return;
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      setState('ready');
    };
    video.addEventListener('error', onError);
    const waitingEvents = ['loadstart', 'waiting', 'stalled', 'seeking'];
    const loadedEvents = ['loadeddata', 'canplay', 'seeked', 'playing'];
    waitingEvents.forEach(event => video.addEventListener(event, onWaiting));
    loadedEvents.forEach(event => video.addEventListener(event, onLoaded));
    if (video.error || retryId > 0) schedule(0);
    else if (video.readyState < 2) schedule(10_000);
    else onLoaded();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      controller.abort();
      video.removeEventListener('error', onError);
      waitingEvents.forEach(event => video.removeEventListener(event, onWaiting));
      loadedEvents.forEach(event => video.removeEventListener(event, onLoaded));
    };
  }, [active, ref, retryId, src]);

  return { state: status.src === src ? status.state : 'ready' as const, retry: () => setRetryId(value => value + 1) };
}
