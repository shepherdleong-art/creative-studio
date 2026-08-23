'use client';

import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { BatchProductionStatus } from '@/lib/batch-production/versions';
import shellStyles from '@/components/mixcut/mixcut-shell.module.css';

export interface BatchSidebarItem {
  id: string;
  name: string;
  status: BatchProductionStatus;
  currentVersionId: string | null;
  archivedAt: string | null;
}

export interface BatchSidebarProps {
  batches: BatchSidebarItem[];
  selectedBatchId: string;
  onSelect: (batchId: string) => void;
  onArchive: (batchId: string, archived: boolean) => void;
  busy?: boolean;
  overview: Array<{ label: string; value: string | number; accent?: boolean }>;
}

const STATUS_LABELS: Record<BatchProductionStatus, string> = {
  draft: '待确认',
  running: '生产中',
  partially_completed: '部分完成',
  completed: '已完成',
  failed: '失败',
};

/**
 * 侧栏:批次概览 + 批次列表(参照单条模式的「最近会话」)。
 * 列表支持关键词即时过滤与「显示已归档」开关;归档/恢复不删除任何数据。
 */
export default function BatchProductionSidebar({
  batches,
  selectedBatchId,
  onSelect,
  onArchive,
  busy = false,
  overview,
}: BatchSidebarProps) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const visibleBatches = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return batches.filter((batch) => {
      if (!showArchived && batch.archivedAt) return false;
      if (keyword && !batch.name.toLocaleLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [batches, query, showArchived]);

  return (
    <>
      <div className={shellStyles.panel}>
        <h3><Icon name="monitor" size={15} />批次概览</h3>
        <div className={shellStyles.statGrid}>
          {overview.map((item) => (
            <div key={item.label} className={`${shellStyles.stat} ${item.accent ? shellStyles.statAccent : ''}`}>
              <b>{item.value}</b>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={`${shellStyles.panel} ${shellStyles.panelGrow}`}>
        <h3><Icon name="users" size={15} />批次列表</h3>
        <input
          type="text"
          aria-label="搜索批次"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索批次…"
          className="h-9 w-full rounded-xl border border-hairline bg-surface px-3 text-sm text-ink"
        />
        <div className={`${shellStyles.panelList} mt-2 space-y-1`}>
          {visibleBatches.length === 0 && (
            <p className={shellStyles.hintLine}>没有匹配的批次{batches.length === 0 ? '，点击顶栏「新建批次」开始' : ''}。</p>
          )}
          {visibleBatches.map((batch) => (
            <div key={batch.id} className="group relative">
              <button
                type="button"
                className={`${shellStyles.session} ${batch.id === selectedBatchId ? shellStyles.sessionActive : ''} w-full pr-9`}
                disabled={busy}
                onClick={() => onSelect(batch.id)}
              >
                <span className={shellStyles.sessionT}>
                  {batch.name}
                  {batch.archivedAt && <span>已归档</span>}
                </span>
                <span className={shellStyles.sessionM}>
                  {STATUS_LABELS[batch.status] ?? batch.status}
                  {batch.currentVersionId ? ' · 已锁定' : ''}
                </span>
              </button>
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] text-ink-tertiary opacity-0 transition group-hover:opacity-100 hover:text-ink"
                title={batch.archivedAt ? '恢复批次' : '归档批次（不删除成片与导出文件）'}
                onClick={() => onArchive(batch.id, !batch.archivedAt)}
              >
                {batch.archivedAt ? '恢复' : '归档'}
              </button>
            </div>
          ))}
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-ink-secondary">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          显示已归档
        </label>
      </div>
    </>
  );
}
