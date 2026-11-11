/**
 * 团队列表（全员任务 / 团队用量明细）的服务端分页公共合同（03 号票）。
 *
 * 这里是分页参数的**唯一**解析处：路线函数只负责把原始查询串交进来，越界归位和
 * 元数据都从这里出。纯数据 + 纯函数，不 import SQLite / React，浏览器端也可以
 * 只 `import type` 拿类型（04/05/06 共用，见 `notes/03-pagination-contract.md`）。
 *
 * 合同（功能方案第 5 节）：
 * - `page` 从 1 开始，缺省 1；`pageSize` 缺省 25，只接受 25/50。
 * - 非整数、负数、0、超安全整数、不支持的 pageSize 一律 400。
 * - 响应 `pagination: { page, pageSize, total, totalPages }`，total 是当前筛选范围的
 *   分页单位总数（任务页里是「制作任务」个数，不是执行记录条数）。
 * - 空结果 total=0、totalPages=1、page=1；超出末页归到有效末页并返回实际 page。
 *
 * 错误对象与 `TeamUsageError` 同形（`status`/`code`/`message`）：路线统一走
 * `teamServiceError()`，因此 400 的响应形状与既有团队接口一致。这里不复用
 * `TeamUsageError` 是为了保持本模块零依赖——`usage.ts` 会反过来 import 它（04 号票）。
 */

/** 允许的每页条数。界面分页控件（05 号票）也只展示这两档。 */
export const TEAM_PAGE_SIZE_OPTIONS = [25, 50] as const;
export type TeamPageSize = (typeof TEAM_PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_TEAM_PAGE = 1;
export const DEFAULT_TEAM_PAGE_SIZE: TeamPageSize = 25;

/** 响应里的分页元数据；`total` 是分页单位总数（不随当前页变化）。 */
export interface TeamPagination {
  page: number;
  pageSize: TeamPageSize;
  total: number;
  totalPages: number;
}

/** 解析后的请求：调用方用它算条数，不直接用页码算 offset。 */
export interface TeamPageRequest {
  page: number;
  pageSize: TeamPageSize;
}

/** 路线查询串里的原始值：可能缺失、可能是字符串，也可能是内部调用传的数字。 */
export interface TeamPageParamInput {
  page?: string | number | null;
  pageSize?: string | number | null;
}

export type TeamPaginationErrorCode = 'page_invalid' | 'page_size_invalid';

export class TeamPaginationError extends Error {
  readonly status = 400;
  readonly code: TeamPaginationErrorCode;

  constructor(code: TeamPaginationErrorCode, message: string) {
    super(message);
    this.name = 'TeamPaginationError';
    this.code = code;
  }
}

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

/**
 * 正整数解析：只认十进制非负整数文本或安全整数。
 * `+2`、`1e3`、`2.5`、`0x10` 都算非法——避免 SQL OFFSET 收到意外数值。
 */
function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** 解析并校验 `page`/`pageSize`；非法值抛 400（`TeamPaginationError`）。 */
export function parseTeamPage(input: TeamPageParamInput = {}): TeamPageRequest {
  let page = DEFAULT_TEAM_PAGE;
  if (!isMissing(input.page)) {
    const parsed = parsePositiveInteger(input.page);
    if (parsed === null) throw new TeamPaginationError('page_invalid', '页码必须是 1 以上的整数。');
    page = parsed;
  }

  let pageSize: TeamPageSize = DEFAULT_TEAM_PAGE_SIZE;
  if (!isMissing(input.pageSize)) {
    const parsed = parsePositiveInteger(input.pageSize);
    if (parsed === null || !TEAM_PAGE_SIZE_OPTIONS.includes(parsed as TeamPageSize)) {
      throw new TeamPaginationError('page_size_invalid', '每页条数只支持 25 或 50。');
    }
    pageSize = parsed as TeamPageSize;
  }

  return { page, pageSize };
}

/** 总页数：空结果是 1 页（界面显示「共 0 条」并禁用翻页，不是 0 页）。 */
export function teamTotalPages(total: number, pageSize: TeamPageSize): number {
  const safeTotal = typeof total === 'number' && Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (safeTotal === 0) return 1;
  return Math.ceil(safeTotal / pageSize);
}

function safeTotal(total: number): number {
  return typeof total === 'number' && Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
}

/**
 * 把请求页码收敛到有效范围并产出元数据。
 *
 * 超出末页时**归到有效末页**（响应里的 `page` 是实际页码，前端据此同步），
 * 空结果固定为第 1 页；只做一次查询，不需要前端循环重请求。
 */
export function resolveTeamPage(
  request: TeamPageRequest,
  total: number,
): { pagination: TeamPagination; offset: number } {
  const boundedTotal = safeTotal(total);
  const totalPages = teamTotalPages(boundedTotal, request.pageSize);
  const page = Math.min(Math.max(request.page, DEFAULT_TEAM_PAGE), totalPages);
  return {
    pagination: { page, pageSize: request.pageSize, total: boundedTotal, totalPages },
    offset: (page - 1) * request.pageSize,
  };
}
