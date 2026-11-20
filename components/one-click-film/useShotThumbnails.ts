'use client';

import { useEffect, useRef, useState } from 'react';

function waitForVideo(video: HTMLVideoElement, event: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      video.removeEventListener(event, success);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', failed);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const success = () => finish();
    const failed = () => finish(new Error('无法读取缩略图帧'));
    const timer = setTimeout(failed, 8_000);
    video.addEventListener(event, success, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted) failed();
  });
}

/** 从当前预览的实际画面取帧。独立解码器不影响播放头。 */
export function useShotThumbnails(url: string | null | undefined, times: string) {
  const cache = useRef(new Map<string, string>());
  const [images, setImages] = useState<{ source: string; frames: Record<string, string> } | null>(null);

  useEffect(() => {
    if (!url || !times) return;
    const source = url;
    const abort = new AbortController();
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;

    async function extract() {
      const points = times.split(',');
      const loaded = waitForVideo(video, 'loadeddata', abort.signal);
      video.src = source;
      await loaded;
      canvas.width = Math.min(video.videoWidth, Math.round(128 * video.videoWidth / video.videoHeight));
      canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
      if (!canvas.width || !canvas.height) return;
      const frames: Record<string, string> = {};
      for (const point of new Set(points)) {
        if (abort.signal.aborted) break;
        const key = `${source}#${point}`;
        let image = cache.current.get(key);
        if (!image) {
          const time = Math.max(0, Math.min(Number(point) / 1e6, video.duration - 0.001));
          if (time !== video.currentTime) {
            const seeked = waitForVideo(video, 'seeked', abort.signal);
            video.currentTime = time;
            await seeked;
          }
          context!.drawImage(video, 0, 0, canvas.width, canvas.height);
          image = canvas.toDataURL('image/jpeg', 0.8);
          if (cache.current.size >= 96) cache.current.delete(cache.current.keys().next().value!);
          cache.current.set(key, image);
        }
        frames[point] = image;
        setImages({ source, frames: { ...frames } });
      }
    }

    void extract().catch(() => {});
    return () => {
      abort.abort();
      video.removeAttribute('src');
      video.load();
    };
  }, [url, times]);

  return (us: number) => images?.source === url ? images?.frames[us] : undefined;
}
