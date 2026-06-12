'use client';

import { useState, useCallback, useRef } from 'react';

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
 * Thumbnail image that shows a fixed-position zoom overlay on hover or focus.
 * Overlay follows cursor and auto-adjusts to stay within viewport.
 * Keyboard-accessible: Tab to focus, Enter/Space to toggle preview.
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
  const imgRef = useRef<HTMLImageElement>(null);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  // ── Mouse handlers (throttled to min 4px delta) ──
  const onMouseEnter = useCallback((e: React.MouseEvent) => {
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    setPos({ x: e.clientX, y: e.clientY });
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const dx = Math.abs(e.clientX - (lastPosRef.current?.x ?? -999));
    const dy = Math.abs(e.clientY - (lastPosRef.current?.y ?? -999));
    if (dx < 4 && dy < 4) return;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    setPos({ x: e.clientX, y: e.clientY });
  }, []);

  const onMouseLeave = useCallback(() => {
    lastPosRef.current = null;
    setPos(null);
  }, []);

  // ── Keyboard / focus handlers (accessibility) ──
  const showAtElement = useCallback(() => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({ x: rect.right + gap, y: rect.top + rect.height / 2 });
    }
  }, [gap]);

  const onFocus = useCallback(() => {
    showAtElement();
  }, [showAtElement]);

  const onBlur = useCallback(() => {
    setPos(null);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (pos) setPos(null); else showAtElement();
    }
    if (e.key === 'Escape') {
      setPos(null);
    }
  }, [pos, showAtElement]);

  const overlaySrc = zoomSrc || src;
  // Suppress overlay when src is empty (avoids broken-image icon)
  const showOverlay = pos && overlaySrc.length > 0;

  return (
    <>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className={className}
        tabIndex={0}
        role="button"
        aria-label={`预览: ${alt}`}
        onMouseEnter={onMouseEnter}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {showOverlay && (
        <div
          className="theme-preview-popover"
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
          <div className="theme-preview-caption max-w-[260px] text-[10px]">
            {alt}
          </div>
        </div>
      )}
    </>
  );
}
