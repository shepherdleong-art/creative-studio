'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Keep the visible playhead (or viewport center) stationary while changing scale. */
export function useTimelineZoom({ scrollRef, playheadSec, leadingWidth = 0, minimum, maximum, step, shortcutsEnabled = true }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  playheadSec: number;
  leadingWidth?: number;
  minimum: number;
  maximum: number;
  step: number;
  shortcutsEnabled?: boolean;
}) {
  const [zoom, setZoom] = useState(60);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const changeZoom = useCallback((requested: number) => {
    const next = Math.max(minimum, Math.min(maximum, requested));
    if (next === zoom) return;
    const scroll = scrollRef.current;
    if (scroll) {
      const visibleWidth = Math.max(0, scroll.clientWidth - leadingWidth);
      const playheadOffset = playheadSec * zoom - scroll.scrollLeft;
      const anchorOffset = playheadOffset >= 0 && playheadOffset <= visibleWidth
        ? playheadOffset : visibleWidth / 2;
      const anchorSec = (scroll.scrollLeft + anchorOffset) / zoom;
      pendingScroll.current = Math.max(0, anchorSec * next - anchorOffset);
    }
    setZoom(next);
  }, [zoom, minimum, maximum, scrollRef, leadingWidth, playheadSec]);

  // Apply only after the new content width exists; the browser clamps at track ends.
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [zoom, scrollRef]);

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      // The zoom slider keeps focus after dragging, but text fields retain +/- input.
      if (target !== inputRef.current && target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      const direction = event.key === '+' || event.key === '=' || event.code === 'NumpadAdd' ? 1
        : event.key === '-' || event.code === 'NumpadSubtract' ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      changeZoom(zoom + direction * step);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [shortcutsEnabled, zoom, step, changeZoom]);

  return { zoom, changeZoom, inputRef };
}
