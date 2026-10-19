'use client';

import { useEffect, useRef, useState } from 'react';
import type { BatchOutputSubtitleCueView } from '@/lib/batch-production/output-arrangement';
import { FINAL_EDIT_FPS } from '@/lib/media-core/render-contract';
import { subtitleSplitEdit, subtitleTrimRange } from './subtitle-edit';
import type { TimelineTool } from './types';
import styles from './batch-unified-review.module.css';

type Range = { startUs: number; endUs: number };

export default function BatchReviewSubtitleChip({ cue, cues, bodyDurationUs, revision, zoom, selected, disabled, tool, onSelect, onEdit, findSnap, onSnap }: {
  cue: BatchOutputSubtitleCueView;
  cues: BatchOutputSubtitleCueView[];
  bodyDurationUs: number;
  revision: number;
  zoom: number;
  selected: boolean;
  disabled: boolean;
  tool: TimelineTool;
  onSelect: () => void;
  onEdit: (edit: Record<string, unknown>) => Promise<boolean>;
  findSnap: (sec: number, alt: boolean) => { sec: number; label: string } | null;
  onSnap: (snap: { sec: number; label: string } | null) => void;
}) {
  const [draft, setDraft] = useState<Range | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  // 切版本、保存刷新或卸载时，旧手势不得继续写入。
  useEffect(() => () => cancelRef.current?.(), [revision, cue]);
  const range = draft ?? cue;

  const beginTrim = (event: React.PointerEvent, edge: 'start' | 'end') => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled || tool !== 'select') return;
    onSelect();
    const originX = event.clientX;
    const originUs = edge === 'start' ? cue.startUs : cue.endUs;
    let latest: Range = cue;
    let moved = false;
    const move = (pointer: PointerEvent) => {
      if (Math.abs(pointer.clientX - originX) < 2 && !moved) return;
      moved = true;
      const rawSec = originUs / 1e6 + (pointer.clientX - originX) / zoom;
      const snap = findSnap(rawSec, pointer.altKey);
      latest = subtitleTrimRange(cue, cues, edge, (snap?.sec ?? rawSec) * 1e6, bodyDurationUs);
      const actualSec = (edge === 'start' ? latest.startUs : latest.endUs) / 1e6;
      onSnap(snap && Math.abs(actualSec - snap.sec) < 1 / FINAL_EDIT_FPS ? { sec: actualSec, label: `${actualSec.toFixed(2)}s` } : null);
      setDraft(latest);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      cancelRef.current = null;
      onSnap(null);
    };
    const cancel = () => { cleanup(); setDraft(null); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    };
    const up = async (pointer: PointerEvent) => {
      move(pointer);
      cleanup();
      if (moved && (latest.startUs !== cue.startUs || latest.endUs !== cue.endUs)) {
        await onEdit({ type: 'trim_subtitle_cue', cueId: cue.id, ...latest });
      }
      setDraft(null);
    };
    cancelRef.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
    window.addEventListener('blur', cancel, { once: true });
    window.addEventListener('keydown', key, true);
  };

  return (
    <div
      data-subtitle-cue-id={cue.id}
      data-selected={selected ? 'true' : undefined}
      className={`${styles.subtitleChip} ${selected ? styles.subtitleChipSelected : ''}`}
      style={{ left: range.startUs / 1e6 * zoom, width: Math.max(4, (range.endUs - range.startUs) / 1e6 * zoom) }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect();
        if (tool !== 'split' || disabled) return;
        const atUs = cue.startUs + (event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom * 1e6;
        const edit = subtitleSplitEdit(cue, atUs);
        if (edit) void onEdit(edit);
      }}
      onClick={event => event.stopPropagation()}
      title={`字幕：${cue.text}（拖动两端调整时长，B 分割）`}
    >
      {cue.text}
      {tool === 'select' && !disabled && <>
        <span className={`${styles.trimHandle} ${styles.trimHandleLeft}`} aria-label="调整字幕开始时间" onPointerDown={event => beginTrim(event, 'start')} />
        <span className={`${styles.trimHandle} ${styles.trimHandleRight}`} aria-label="调整字幕结束时间" onPointerDown={event => beginTrim(event, 'end')} />
      </>}
    </div>
  );
}
