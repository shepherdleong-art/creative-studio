'use client';

import { useEffect, useState } from 'react';
import { FINAL_EDIT_FPS } from '@/lib/media-core/render-contract';
import { assertPackagingStickerVariantTarget } from '@/lib/media-core/packaging-sticker-variants';
import type { UnifiedFilmState } from './types';
import { Icon } from '@/components/ui/Icon';

export interface BatchStickerCopyDialogTarget {
  planId: string;
  expectedOutputVersionId: string;
  expectedEditRevision: number;
}

function bodyFrames(film: UnifiedFilmState): number {
  const arrangement = film.arrangement;
  if (!arrangement) return 0;
  const durationUs = Math.max(arrangement.visualDurationUs, arrangement.narration.durationUs ?? 0);
  return Math.floor(durationUs / 1e6 * FINAL_EDIT_FPS + 1e-6);
}

export default function BatchStickerCopyDialog({ source, films, initialSelectedPlanIds, onClose, onConfirm }: {
  source: UnifiedFilmState;
  films: UnifiedFilmState[];
  initialSelectedPlanIds: string[];
  onClose: () => void;
  onConfirm: (targets: BatchStickerCopyDialogTarget[]) => Promise<void>;
}) {
  const sourceArrangement = source.arrangement;
  const sourceStickers = sourceArrangement?.packaging?.stickers ?? [];
  const sourceBodyFrames = bodyFrames(source);
  const rows = films.filter((film) => film.planId !== source.planId).map((film) => {
    const arrangement = film.arrangement;
    let issue = '';
    if (!arrangement) issue = '成片安排尚未载入';
    else if (!arrangement.editable || !arrangement.outputVersionId) issue = '当前版本不可编辑';
    else if (!arrangement.packaging?.enabled) issue = '请先开启该成片的视频包装';
    else {
      try {
        assertPackagingStickerVariantTarget({ sourceBodyFrames, targetBodyFrames: bodyFrames(film), sourceStickers });
      } catch (error) {
        issue = error instanceof Error ? error.message : '正文时长无法容纳来源贴纸';
      }
    }
    return {
      film,
      issue,
      existingCount: arrangement?.packaging?.stickers?.length ?? 0,
      outputVersionId: arrangement?.outputVersionId ?? '',
      editRevision: arrangement?.editRevision ?? 0,
    };
  });
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedPlanIds.filter((planId) => (
    rows.some((row) => row.film.planId === planId && !row.issue)
  ))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validRows = rows.filter((row) => !row.issue && row.outputVersionId);
  const selectedRows = validRows.filter((row) => selected.has(row.film.planId));
  const replaceCount = selectedRows.filter((row) => row.existingCount > 0).length;
  const reviewCount = selectedRows.filter((row) => row.film.approved).length;

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [busy, onClose]);

  const toggle = (planId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(planId);
      else next.delete(planId);
      return next;
    });
  };

  const confirm = async () => {
    if (busy || selectedRows.length === 0) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(selectedRows.map((row) => ({
        planId: row.film.planId,
        expectedOutputVersionId: row.outputVersionId,
        expectedEditRevision: row.editRevision,
      })));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '复制失败，请刷新后重试');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="batch-sticker-copy-title" className="flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-hairline bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div>
            <h2 id="batch-sticker-copy-title" className="text-sm font-semibold text-ink">复制贴纸到其他成片</h2>
            <p className="mt-1 text-xs text-ink-tertiary">来源：成片 {String(source.seq).padStart(2, '0')} · {source.scriptTitle} · {sourceStickers.length} 张贴纸</p>
          </div>
          <button type="button" aria-label="关闭复制弹窗" className="btn-secondary h-7 w-7 p-0" disabled={busy} onClick={onClose}><Icon name="close" size={14} /></button>
        </header>

        <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-2.5 text-xs">
          <span className="text-ink-secondary">已选 {selectedRows.length} / {validRows.length} 条可复制成片</span>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary h-7 px-2.5" disabled={busy || validRows.length === 0} onClick={() => setSelected(new Set(validRows.map((row) => row.film.planId)))}>全选有效</button>
            <button type="button" className="btn-secondary h-7 px-2.5" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>清空</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.map((row) => {
            const id = `batch-sticker-target-${row.film.planId}`;
            return (
              <label key={row.film.planId} htmlFor={id} data-plan-id={row.film.planId} className={`flex gap-3 rounded-xl px-3 py-3 text-xs ${row.issue ? 'opacity-55' : 'cursor-pointer hover:bg-surface-subtle'}`}>
                <input
                  id={id}
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={selected.has(row.film.planId)}
                  disabled={busy || Boolean(row.issue)}
                  onChange={(event) => toggle(row.film.planId, event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-3">
                    <strong className="truncate font-medium text-ink">成片 {String(row.film.seq).padStart(2, '0')} · {row.film.scriptTitle}</strong>
                    <span className="shrink-0 text-ink-tertiary">{row.existingCount} 张已有</span>
                  </span>
                  <span className="mt-1 block text-ink-tertiary">
                    {row.issue || `${row.film.approved ? '已审核，复制后需重新审核 · ' : ''}${row.existingCount ? '复制后替换全部现有贴纸' : '将生成并保存随机变体'}`}
                  </span>
                </span>
              </label>
            );
          })}
          {rows.length === 0 && <p className="p-8 text-center text-xs text-ink-tertiary">当前批次没有其他成片</p>}
        </div>

        <footer className="border-t border-hairline px-5 py-4">
          {replaceCount > 0 && <p className="mb-2 text-xs text-warn">将替换 {replaceCount} 条目标成片的全部现有贴纸，可通过一次整体撤销恢复。</p>}
          {reviewCount > 0 && <p className="mb-2 text-xs text-warn">{reviewCount} 条已审核目标在复制后需要重新审核。</p>}
          {error && <p role="alert" className="mb-2 text-xs text-fail">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-ink-tertiary">只复制贴纸方案，保留目标模板、字体、文案与其他编辑</span>
            <button type="button" className="btn-primary h-8 shrink-0 px-3 text-xs" disabled={busy || selectedRows.length === 0} onClick={() => void confirm()}>
              {busy ? '正在生成…' : `复制并生成变体${selectedRows.length ? `（${selectedRows.length}）` : ''}`}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
