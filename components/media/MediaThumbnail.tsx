'use client';

import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';

// Native loading="lazy" can eagerly request an entire grid near the viewport.
// Leave connections for video/interactive requests, even while generation waits.
const MAX_THUMBNAIL_REQUESTS = 2;
const waiting: Array<() => void> = [];
let active = 0;
function drain() {
  while (active < MAX_THUMBNAIL_REQUESTS && waiting.length) waiting.shift()!();
}
function requestThumbnail(src: string, loaded: (blob: Blob) => void, failed: () => void): () => void {
  const controller = new AbortController();
  const start = () => {
    active++;
    void fetch(src, { signal: controller.signal, credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) throw new Error('Thumbnail unavailable');
        return response.blob();
      })
      .then(blob => { if (!controller.signal.aborted) loaded(blob); })
      .catch(() => { if (!controller.signal.aborted) failed(); })
      .finally(() => { active--; drain(); });
  };
  waiting.push(start);
  drain();
  return () => {
    const index = waiting.indexOf(start);
    if (index >= 0) waiting.splice(index, 1);
    controller.abort();
  };
}

type Props = Pick<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'className' | 'draggable'> & {
  src: string;
  onError?: () => void;
};

export default function MediaThumbnail({ src, onError, alt = '', ...props }: Props) {
  const imageRef = useRef<HTMLImageElement>(null);
  const errorRef = useRef(onError);
  const [loaded, setLoaded] = useState<{ src: string; url: string } | null>(null);
  useEffect(() => { errorRef.current = onError; }, [onError]);
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    let cancel: (() => void) | undefined, objectUrl: string | undefined;
    const start = () => {
      if (cancel) return;
      cancel = requestThumbnail(src, blob => {
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ src, url: objectUrl });
      }, () => errorRef.current?.());
    };
    // Use the actual visible area, including scroll containers, rather than the
    // browser's large lazy-load distance. Once loaded, scrolling keeps the image.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { start(); observer.disconnect(); }
    });
    observer.observe(image);
    return () => {
      observer.disconnect();
      cancel?.();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} ref={imageRef} alt={alt} src={loaded?.src === src ? loaded.url : undefined} onError={onError} />;
}
