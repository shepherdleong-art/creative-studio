'use client';

import { useState, useCallback } from 'react';

interface HoverZoomImageProps {
  src: string;
  alt: string;
  /** Tailwind classes for the thumbnail img element */
  className?: string;
  /** Use a different (usually higher-res) URL for the zoomed image */
  zoomSrc?: string;
  /** Max width/height of the zoom overlay (default 280x220) */
  zoomMaxWidth?: number;
  zoomMaxHeight?: number;
  /** Gap in px from cursor to overlay (default 14) */
  gap?: number;
}

/**
 * Thumbnail image that shows a fixed-position zoom overlay on hover.
 * Overlay follows cursor and auto-adjusts to stay within viewport.
 */
export default function HoverZoomImage({
  src,
  alt,
  className,
  zoomSrc,
  zoomMaxWidth = 280,
  zoomMaxHeight = 220,
  gap = 14,
}: HoverZoomImageProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const onMouseEnter = useCallback((e: React.MouseEvent) => {
    setPos({ x: e.clientX, y: e.clientY });
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    setPos({ x: e.clientX, y: e.clientY });
  }, []);

  const onMouseLeave = useCallback(() => {
    setPos(null);
  }, []);

  const overlaySrc = zoomSrc || src;

  return (
    <>
      <img
        src={src}
        alt={alt}
        className={className}
        onMouseEnter={onMouseEnter}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      />
      {pos && (
        <div
          className="fixed z-[80] pointer-events-none rounded-lg border border-gray-700 bg-gray-900/95 p-2 shadow-2xl"
          style={{
            left: Math.min(pos.x + gap, window.innerWidth - zoomMaxWidth - 12),
            top: Math.min(pos.y + gap, window.innerHeight - zoomMaxHeight - 12),
            maxWidth: zoomMaxWidth,
          }}
        >
          <img
            src={overlaySrc}
            alt={alt}
            className="block rounded object-contain"
            style={{ maxHeight: zoomMaxHeight, maxWidth: zoomMaxWidth }}
          />
          <div className="mt-1 max-w-[260px] truncate text-[10px] text-gray-200">
            {alt}
          </div>
        </div>
      )}
    </>
  );
}
