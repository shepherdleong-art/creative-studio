'use client';

import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { BatchProductionStatus } from '@/lib/batch-production/versions';
import styles from './batch-sidebar.module.css';

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

const STATUS_DOT: Record<BatchProductionStatus, string> = {
  draft: 'status-dot-idle',
  running: 'status-dot-run',
  partially_completed: 'status-dot-warn',
  completed: 'status-dot-ok',
  failed: 'status-dot-fail',
};

/**
 * 侧栏:批次概览 + 批次列表(参照单条模式的「最近会话」)。
 * 列表支持关键词即时过滤与「显示已归档」开关;归档/恢复不删除任何数据。
 * 外观（10 号票）对齐原型批次菜单：分组底行、小状态点、右上小号归档入口。
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
      <div className={styles.panel}>
        <h3 className={styles.panelHead}><Icon name="monitor" size={14} />批次概览</h3>
        <div className={styles.statGrid}>
          {overview.map((item) => (
            <div key={item.label} className={`${styles.stat} ${item.accent ? styles.statAccent : ''}`}>
              <b>{item.value}</b>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={`${styles.panel} ${styles.panelGrow}`}>
        <h3 className={styles.panelHead}><Icon name="users" size={14} />批次列表</h3>
        <input
          type="text"
          aria-label="搜索批次"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索批次…"
          className={styles.search}
        />
        <div className={styles.list}>
          {visibleBatches.length === 0 && (
            <p className={styles.hint}>
              {!showArchived && !query.trim() && batches.some((batch) => batch.archivedAt)
                ? '批次已归档，勾选下方「显示已归档」即可查看和恢复。'
                : `没有匹配的批次${batches.length === 0 ? '，点击顶栏「新建批次」开始' : ''}。`}
            </p>
          )}
          {visibleBatches.map((batch) => (
            <div key={batch.id} className={`${styles.row} group ${batch.id === selectedBatchId ? styles.rowOn : ''}`}>
              <button
                type="button"
                className={`${styles.rowPick} pr-8`}
                disabled={busy}
                onClick={() => onSelect(batch.id)}
              >
                <span className={styles.rowName}>
                  <i className={STATUS_DOT[batch.status] ?? 'status-dot-idle'} />
                  <span className={styles.rowNameText}>{batch.name}</span>
                </span>
                <span className={styles.rowMeta}>
                  {STATUS_LABELS[batch.status] ?? batch.status}
                  {batch.currentVersionId ? ' · 已锁定' : ''}
                  {batch.archivedAt ? ' · 已归档' : ''}
                </span>
              </button>
              <button
                type="button"
                className={`${styles.rowAction} absolute right-2 top-1/2 -translate-y-1/2 transition ${batch.archivedAt ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                title={batch.archivedAt ? '恢复批次' : '归档批次（不删除成片与导出文件）'}
                disabled={busy}
                onClick={() => onArchive(batch.id, !batch.archivedAt)}
              >
                {batch.archivedAt ? '恢复' : '归档'}
              </button>
            </div>
          ))}
        </div>
        <label className={styles.archivedToggle}>
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
