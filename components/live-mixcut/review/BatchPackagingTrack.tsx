'use client';

import { useEffect, useRef, useState } from 'react';
import type { BatchOutputClipEditView } from '@/lib/live-mixcut/output-arrangement';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_DURATION_US } from '@/lib/media-core/render-contract';
import styles from './batch-unified-review.module.css';

type Cue = NonNullable<NonNullable<BatchOutputClipEditView['packaging']>['pointCues']>[number];
const COVER = FINAL_EDIT_INTRO_DURATION_US / 1e6;
const FRAME = 1 / FINAL_EDIT_FPS;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export default function BatchPackagingTrack({ view, zoom, playheadSec, onSelect, onEdit, onSeek }: {
  view: BatchOutputClipEditView; zoom: number; playheadSec: number;
  onSelect: () => void; onSeek: (time: number) => void;
  onEdit: (edit: Record<string, unknown>) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Cue | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const config = view.packaging!;
  const cues = config.pointCues ?? [];
  const total = Math.max(view.visualDurationUs, view.narration.durationUs ?? 0) / 1e6 + COVER;
  useEffect(() => () => cancelRef.current?.(), [view]);
  const save = async (points: Cue[]) => {
    if (busyRef.current || !view.editable) return;
    busyRef.current = true; setBusy(true);
    try { await onEdit({ type: 'set_packaging', expectedEditRevision: view.editRevision, expectedOutputVersionId: view.outputVersionId,
      config: { ...config, pointCues: points, pointCuesEdited: true, pointCuesMode: points.length ? 'timed' : 'none' } }); }
    finally { busyRef.current = false; setBusy(false); setDraft(null); }
  };
  const remove = (id: string) => { setSelected(null); void save(cues.filter(cue => cue.id !== id)); };
  const commitText = () => {
    if (!editing) return;
    const id = editing; setEditing(null);
    if (text.trim() && text.trim() !== cues.find(cue => cue.id === id)?.text) void save(cues.map(cue => cue.id === id ? { ...cue, text: text.trim() } : cue));
  };
  const begin = (event: React.PointerEvent, cue: Cue, mode: 'move' | 'start' | 'end') => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.preventDefault();
    if (busyRef.current || !view.editable || editing) return;
    onSelect(); setSelected(cue.id); event.currentTarget.closest<HTMLElement>('[data-point-cue]')?.focus();
    const x = event.clientX; let latest = cue; let moved = false;
    const move = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientX - x) < 3) return;
      moved = true;
      const delta = Math.round((e.clientX - x) / zoom * FINAL_EDIT_FPS) / FINAL_EDIT_FPS;
      if (mode === 'move') {
        const length = cue.endSec - cue.startSec;
        const startSec = clamp(cue.startSec + delta, COVER, total - length);
        latest = { ...cue, startSec, endSec: startSec + length };
      } else if (mode === 'start') latest = { ...cue, startSec: clamp(cue.startSec + delta, COVER, cue.endSec - FRAME) };
      else latest = { ...cue, endSec: clamp(cue.endSec + delta, cue.startSec + FRAME, total) };
      setDraft(latest);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true); cancelRef.current = null;
    };
    const cancel = () => { cleanup(); setDraft(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
    const up = (e: PointerEvent) => {
      move(e); cleanup();
      if (moved && (latest.startSec !== cue.startSec || latest.endSec !== cue.endSec)) void save(cues.map(item => item.id === cue.id ? latest : item));
      else setDraft(null);
    };
    cancelRef.current = cancel;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); window.addEventListener('keydown', key, true);
  };
  return <div className={styles.trackPackaging} aria-label="卖点包装轨道" data-track="point" aria-busy={busy} onClick={event => event.stopPropagation()}>
    <button type="button" className={styles.addPoint} style={{ left: Math.max(0, ...cues.map(cue => cue.endSec - COVER)) * zoom + 8 }} disabled={busy || !view.editable || cues.length >= 24 || total - COVER < FRAME} onPointerDown={event => event.stopPropagation()} onClick={() => {
      onSelect(); const startSec = clamp(playheadSec + COVER, COVER, total - FRAME);
      const cue = { id: `p_${crypto.randomUUID().slice(0, 8)}`, text: '新卖点', startSec, endSec: Math.min(total, startSec + 2) };
      setSelected(cue.id); void save([...cues, cue]);
    }}>＋卖点</button>
    {cues.map(cue => {
      const current = draft?.id === cue.id ? draft : cue;
      return <div key={cue.id} tabIndex={0} data-point-cue={cue.id} className={`${styles.pointChip} ${selected === cue.id ? styles.pointChipSelected : ''}`}
        style={{ left: (current.startSec - COVER) * zoom, width: Math.max(6, (current.endSec - current.startSec) * zoom) }}
        title={`${cue.text} · 拖动移动/两端修剪 · 双击改字 · Delete 删除`}
        onPointerDown={event => begin(event, cue, 'move')}
        onDoubleClick={event => { event.stopPropagation(); if (!busy && view.editable) { setEditing(cue.id); setText(cue.text); onSeek(cue.startSec - COVER); } }}
        onKeyDown={event => {
          if (event.target instanceof HTMLInputElement) return;
          if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); if (!busy) remove(cue.id); }
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); setEditing(cue.id); setText(cue.text); }
        }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setSelected(cue.id); }}>
        <span className={styles.pointHandleLeft} aria-label="修剪卖点开始" onPointerDown={event => begin(event, cue, 'start')} />
        <span className={styles.pointText}>{cue.text}</span>
        <span className={styles.pointHandleRight} aria-label="修剪卖点结束" onPointerDown={event => begin(event, cue, 'end')} />
        {selected === cue.id && !editing && <button className={styles.pointDelete} aria-label="删除卖点" disabled={busy || !view.editable} onPointerDown={e => e.stopPropagation()} onClick={() => remove(cue.id)}>×</button>}
        {editing === cue.id && <input autoFocus aria-label="卖点文字" className={styles.pointTextInput} value={text} maxLength={100}
          onPointerDown={e => e.stopPropagation()} onChange={e => setText(e.target.value)} onBlur={commitText}
          onKeyDown={e => { e.stopPropagation(); if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); commitText(); } if (e.key === 'Escape') setEditing(null); }} />}
      </div>;
    })}
  </div>;
}
