'use client';

import { useEffect, useRef, useState } from 'react';
import { coverFramingGeometry, panCoverFraming } from '@/lib/media-core/cover-framing';
import type { CoverFraming } from '@/lib/media-core/cover-types';
import styles from './one-click-film.module.css';

type CoverSource = { image: string; width: number; height: number };

export function FilmCoverFramingPreview({ url, input, size, framing, onChange, onError }: {
  url: string;
  input: string;
  size: { width: number; height: number };
  framing: CoverFraming;
  onChange: (framing: CoverFraming) => void;
  onError: (message: string) => void;
}) {
  const [source, setSource] = useState<CoverSource | null>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; width: number; height: number; framing: CoverFraming } | null>(null);
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input, signal: request.signal });
        const result = await response.json() as Partial<CoverSource> & { message?: string };
        if (!response.ok || !result.image || !result.width || !result.height) throw new Error(result.message || '封面底图无法加载');
        if (!request.signal.aborted) setSource({ image: result.image, width: result.width, height: result.height });
      } catch (error) {
        if (!request.signal.aborted) onError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => request.abort();
  }, [url, input, onError]);

  if (!source) return null;
  const outputWidth = size.width - size.width % 2;
  const outputHeight = size.height - size.height % 2;
  const inputGeometry = { sourceWidth: source.width, sourceHeight: source.height, outputWidth, outputHeight, framing };
  const geometry = coverFramingGeometry(inputGeometry);
  const move = (origin: CoverFraming, x: number, y: number) => {
    const next = panCoverFraming({ ...inputGeometry, framing: origin }, { x, y });
    if (next.offsetX !== framing.offsetX || next.offsetY !== framing.offsetY) onChange(next);
  };

  return <>
    {/* eslint-disable-next-line @next/next/no-img-element -- 源缩略图与服务器输出共用取景几何 */}
    <img className={styles.draftFramingImage} src={source.image} alt="" draggable={false} style={{
      left: `${-geometry.left / outputWidth * 100}%`, top: `${-geometry.top / outputHeight * 100}%`,
      width: `${geometry.resizedWidth / outputWidth * 100}%`, height: `${geometry.resizedHeight / outputHeight * 100}%`,
    }} />
    <div className={styles.draftFramingSurface} tabIndex={0} role="region" aria-label="拖动封面底图"
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        const { width, height } = event.currentTarget.getBoundingClientRect();
        if (!width || !height) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width, height, framing };
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || start.pointer !== event.pointerId) return;
        move(start.framing, (event.clientX - start.x) * outputWidth / start.width, (event.clientY - start.y) * outputHeight / start.height);
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!direction) return;
        event.preventDefault();
        move(framing, direction[0] * outputWidth * 0.05, direction[1] * outputHeight * 0.05);
      }} />
  </>;
}
