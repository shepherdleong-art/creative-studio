'use client';

import { useId, useState, type FormEvent } from 'react';
import { TEAM_PAGE_SIZE_OPTIONS, type TeamPageSize } from '@/lib/team-service/pagination';

/**
 * 服务端分页控件（05 号票）——团队用量明细与全员任务共用。
 *
 * **完全受控**：自己不保存页码/每页条数，只把用户的选择回传；页码以服务端响应里的
 * `pagination.page` 为准（越界时服务端归位，见 `lib/team-service/pagination.ts`）。
 * 零依赖：`pageSize` 取值与类型来自 03 号票的公共分页模块，这里**不重写**一套规则。
 *
 * 合同（`outputs/2026-11-11-工作台版本标记与团队列表易用性/notes/05-pagination-component.md`）：
 * - `onChange({ page, pageSize })`：翻页只改 `page`；改每页条数时固定回第 1 页
 *   （`{ page: 1, pageSize: next }`），调用方不必再判断。
 * - 页码超过 7 页收起中间页码；可输入页码跳转；空结果与首页/末页的禁用状态由这里负责。
 * - `loading` 只做视觉与 `aria-busy` 提示，**不禁用**翻页：连续快速翻页的旧响应由调用方
 *   取消/丢弃（否则用户点一下就得等一整轮网络）。
 */
export type PaginationToken = number | 'gap';

/** 页码窗口：超过 7 页时收起中间页码，最多 7 项（含省略号）。纯函数，便于直接断言。 */
export function paginationPages(page: number, totalPages: number): PaginationToken[] {
  const total = Number.isFinite(totalPages) ? Math.max(1, Math.floor(totalPages)) : 1;
  const current = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), total) : 1;
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, 'gap', total];
  if (current >= total - 3) return [1, 'gap', total - 4, total - 3, total - 2, total - 1, total];
  return [1, 'gap', current - 1, current, current + 1, 'gap', total];
}

export interface PaginationChange {
  page: number;
  pageSize: TeamPageSize;
}

export interface PaginationProps {
  /** 当前页（1 起），调用方应传服务端响应里的 `pagination.page`。 */
  page: number;
  pageSize: TeamPageSize;
  /** 当前筛选范围的记录总数（不是当前页条数）。 */
  total: number;
  totalPages: number;
  loading?: boolean;
  onChange: (next: PaginationChange) => void;
  /** 可选：本组列表的刷新入口（用量页把刷新放在业务筛选行，不传）。 */
  onRefresh?: () => void;
  /** 这组分页在翻什么，用于无障碍名，例如「制作任务」。 */
  label?: string;
  /** 计数单位，例如「条」「个制作任务」。 */
  unit?: string;
  className?: string;
}

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  loading = false,
  onChange,
  onRefresh,
  label = '明细',
  unit = '条',
  className,
}: PaginationProps) {
  const jumpId = useId();
  const sizeId = useId();
  const [jump, setJump] = useState('');

  const lastPage = Number.isFinite(totalPages) ? Math.max(1, Math.floor(totalPages)) : 1;
  const currentPage = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), lastPage) : 1;
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const atFirst = currentPage <= 1;
  const atLast = currentPage >= lastPage;
  const tokens = paginationPages(currentPage, lastPage);

  const go = (next: number) => {
    const target = Math.min(Math.max(1, Math.floor(next)), lastPage);
    if (!Number.isFinite(target) || target === currentPage) return;
    onChange({ page: target, pageSize });
  };

  const submitJump = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = Number.parseInt(jump.trim(), 10);
    if (!Number.isFinite(parsed)) {
      setJump('');
      return;
    }
    setJump('');
    go(parsed);
  };

  return (
    <nav
      aria-label={`${label}分页`}
      aria-busy={loading || undefined}
      data-testid="pagination"
      data-page={currentPage}
      data-total-pages={lastPage}
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[var(--radius-control)] ${className ?? ''}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-tertiary">
        <span className="tnum" data-testid="pagination-total">共 {safeTotal} {unit}</span>
        <span className="tnum" data-testid="pagination-status">第 {currentPage} / {lastPage} 页</span>
        {loading ? <span role="status" className="text-ink-tertiary">读取中…</span> : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="cap"
          data-testid="pagination-prev"
          aria-label="上一页"
          disabled={atFirst}
          onClick={() => go(currentPage - 1)}
        >
          上一页
        </button>
        {tokens.map((token, index) => token === 'gap'
          ? <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-[12px] text-ink-tertiary">…</span>
          : <button
            key={token}
            type="button"
            className={`cap tnum${token === currentPage ? ' cap-primary' : ''}`}
            data-testid="pagination-page"
            data-page={token}
            aria-label={`第 ${token} 页`}
            aria-current={token === currentPage ? 'page' : undefined}
            onClick={() => go(token)}
          >
            {token}
          </button>)}
        <button
          type="button"
          className="cap"
          data-testid="pagination-next"
          aria-label="下一页"
          disabled={atLast}
          onClick={() => go(currentPage + 1)}
        >
          下一页
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
        <label htmlFor={sizeId}>每页</label>
        <select
          id={sizeId}
          data-testid="pagination-size"
          aria-label="每页条数"
          className="input-field w-auto"
          value={String(pageSize)}
          onChange={(event) => {
            const next = Number(event.target.value) as TeamPageSize;
            if (!TEAM_PAGE_SIZE_OPTIONS.includes(next) || next === pageSize) return;
            // 每页条数变化固定回第 1 页：调用方不需要再判断一次。
            onChange({ page: 1, pageSize: next });
          }}
        >
          {TEAM_PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={String(option)}>{option} 条</option>)}
        </select>
        <form className="flex items-center gap-1.5" onSubmit={submitJump}>
          <input
            id={jumpId}
            data-testid="pagination-jump"
            aria-label="跳转页码"
            className="input-field tnum w-16"
            inputMode="numeric"
            placeholder="页码"
            value={jump}
            onChange={(event) => setJump(event.target.value.replace(/[^\d]/g, ''))}
          />
          <button type="submit" className="cap" data-testid="pagination-jump-submit">跳转</button>
        </form>
        {onRefresh ? <button type="button" className="cap" onClick={onRefresh}>刷新</button> : null}
      </div>
    </nav>
  );
}
