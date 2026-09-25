'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { UnifiedFilmState } from './types';

export interface BatchUnifiedExportDialogProps {
  open: boolean;
  onClose: () => void;
  films: UnifiedFilmState[];
  projectId: string;
  batchId: string;
  onExportStarted: () => void;
}

export default function BatchUnifiedExportDialog({
  open,
  onClose,
  films,
  projectId,
  batchId,
  onExportStarted,
}: BatchUnifiedExportDialogProps) {
  // Pre-select approved films
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>(() =>
    films.filter((f) => f.approved).map((f) => f.planId)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开按最新审核状态重置预选(组件常驻挂载,useState 初始化只跑一次);
  // 渲染期随 open 变化调整状态,避免 effect 级联渲染。
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelectedPlanIds(films.filter((f) => f.approved).map((f) => f.planId));
      setError(null);
      setBusy(false);
    }
  }

  if (!open) return null;

  const handleToggle = (planId: string) => {
    setSelectedPlanIds((curr) =>
      curr.includes(planId) ? curr.filter((id) => id !== planId) : [...curr, planId]
    );
  };

  const handleSelectAll = () => {
    const approvable = films.filter((f) => f.approvable).map((f) => f.planId);
    if (selectedPlanIds.length === approvable.length) {
      setSelectedPlanIds([]);
    } else {
      setSelectedPlanIds(approvable);
    }
  };

  const handleStartExport = async () => {
    if (selectedPlanIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/batch-production/batches/${encodeURIComponent(batchId)}/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, planIds: selectedPlanIds }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || `导出失败 (${response.status})`);
      }
      onExportStarted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出启动失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-surface p-5 shadow-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline pb-3">
          <div>
            <h3 id="export-dialog-title" className="font-semibold text-ink">
              统一导出成片
            </h3>
            <p className="text-xs text-ink-secondary mt-0.5">
              将审核通过的成片渲染为最终 MP4 视频并发布到素材库
            </p>
          </div>
          <button type="button" className="btn-secondary h-7 w-7 p-0" onClick={onClose}>
            ×
          </button>
        </div>

        {error && (
          <div className="rounded-lg bg-fail/10 p-2.5 text-xs text-fail flex items-center justify-between">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>×</button>
          </div>
        )}

        <div className="flex items-center justify-between text-xs">
          <button type="button" className="btn-secondary h-7 px-2.5 text-xs" onClick={handleSelectAll}>
            {selectedPlanIds.length === films.filter((f) => f.approvable).length ? '全不选' : '全选可导出'}
          </button>
          <span className="text-ink-secondary">
            已选择 <strong className="text-accent">{selectedPlanIds.length}</strong> / {films.length} 条成片
          </span>
        </div>

        <div className="max-h-60 overflow-y-auto space-y-1.5 border border-hairline rounded-xl p-2 bg-surface-subtle">
          {films.map((film) => {
            const isChecked = selectedPlanIds.includes(film.planId);
            return (
              <label
                key={film.planId}
                className="flex items-center justify-between p-2 rounded-lg bg-surface hover:bg-surface-hover cursor-pointer"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleToggle(film.planId)}
                    disabled={!film.approvable}
                    className="rounded"
                  />
                  <span className="truncate text-xs font-medium text-ink">
                    成片 {String(film.seq).padStart(2, '0')} · {film.scriptTitle || '未命名脚本'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className={`rounded-full px-2 py-0.2 text-[10px] ${
                      film.approved
                        ? 'bg-ok/10 text-ok'
                        : film.approvable
                        ? 'bg-accent/10 text-accent'
                        : 'bg-warn/20 text-warn'
                    }`}
                  >
                    {film.approved ? '已通过' : film.approvable ? '待审核' : '未就绪'}
                  </span>
                  <span className="text-[10px] text-ink-tertiary">
                    {film.durationSec.toFixed(1)}s
                  </span>
                </div>
              </label>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline">
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary h-8 px-4 text-xs flex items-center gap-1.5"
            disabled={busy || selectedPlanIds.length === 0}
            onClick={handleStartExport}
          >
            {busy ? (
              <span>导出准备中…</span>
            ) : (
              <>
                <span>开始导出 ({selectedPlanIds.length})</span>
                <Icon name="chevron-right" size={12} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
