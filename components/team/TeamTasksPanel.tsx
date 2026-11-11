'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import PageToolbar from '@/components/team/PageToolbar';
import { EmptyState, GroupList, GroupRow, Tag, ToolbarButton, type TagTone } from '@/components/ui/Appearance';
import { Pagination, type PaginationChange } from '@/components/ui/Pagination';
import { DEFAULT_TEAM_PAGE_SIZE, type TeamPagination, type TeamPageSize } from '@/lib/team-service/pagination';
import { teamWrite } from './client';
import { TASK_STATUS_LABELS, taskWaitLabel } from '@/lib/team-task-labels';
import TeamTaskModel, { type TeamTaskModelCall } from './TeamTaskModel';
import { consoleTaskTone, taskIdFromQuery } from '@/lib/team-console-overview';
import {
  TASK_SEARCH_DEBOUNCE_MS,
  groupPageByActor,
  groupTeamTaskRows,
  memberOptionsFromUsers,
  readTaskListResponse,
  taskListRequestPath,
  taskPageAfterChange,
  taskTotalSummary,
  type TaskMemberOption,
} from './task-panel-state';
import s from './console.module.css';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

/**
 * 全员任务 / 我的任务（06 号票：服务端分页与独立详情）。
 *
 * 详情 URL 形态：**`/team/tasks?taskId=<operationId>`**——运行总览的最近任务行、错误中心、
 * 用量明细都用这一条跳过来（`taskDetailHref()` 是唯一生成处）。`operationId` 是对外可见的
 * 执行记录编号（`execution_operations.id`），不是 `tasks` 表里的业务任务号。
 *
 * 本票之后的请求口径（合同见 `notes/03-pagination-contract.md` 与 `notes/05-pagination-component.md`）：
 * - 列表一次只请求一页制作任务：`GET /api/team/tasks?q=&page=&pageSize=`（保留 status/actorUserId）；
 *   总数读响应 `pagination.total`（制作任务）/ `totalRecords`（执行记录），**不用当前页数组长度**；
 * - 搜索走服务端 `q`（约 300ms 防抖、保持焦点、Enter 立即），覆盖完整可见历史，不在前端过滤；
 * - 先分页、再对当前页按发起人分组（组标题「本页 N 项」）；平铺/分组只改展示；
 * - 详情按 `taskId` 独立加载，不受当前页/筛选限制；翻页不关详情，关闭详情保留页与筛选；
 * - 列表/详情错误各自保留、各自重试；旧筛选/旧页的晚到响应由 AbortController + active 丢弃；
 * - 失败任务重试仍走原接口，成功后刷新详情与当前页。
 */

type TeamTask = {
  taskName: string;
  stepName: string;
  scopeName: string;
  inputFilename: string | null;
  model: string | null;
  providerName: string;
  modelStatus: string;
  unifiedModel: string | null;
  unifiedTaskId: string | null;
  unifiedTaskCostMinor: number;
  unifiedTaskCostStatus: string | null;
  unifiedTaskAttemptCount: number;
  unifiedTaskChannelCount: number;
  admissionPriority: number | null;
  admissionCandidateCount: number | null;
  admissionTrace: Record<string, unknown> | null;
  modelCalls: TeamTaskModelCall[];
  waitLabel: string;
  waitReason: string | null;
  submissionCount: number;
  operationId: string;
  module: string;
  taskId: string;
  step: string;
  inputRevision: string;
  businessAttemptNo: number;
  actorUserId: string;
  employeeId: string;
  actorDisplayName: string;
  scope: { resourceType: string; resourceId: string };
  status: string;
  configVersion: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  currentAttemptId: string | null;
  attemptCount: number;
  errorId: string | null;
  errorStage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 一页列表响应 + 它对应的筛选快照（筛选变了就先把旧数据藏起来，不冒充新条件）。 */
type TaskListState = {
  items: TeamTask[];
  pagination: TeamPagination;
  totalRecords: number;
  filterKey: string;
};

// 任务页只复用本页的分组/展示逻辑；`groupTeamTaskRows` 的实现在 `task-panel-state.ts`
// （纯函数，Node 测试可直接断言）。
function unifiedTaskCostLabel(item: TeamTask): string {
  if (item.unifiedTaskCostStatus === 'released') return '已释放';
  if (item.unifiedTaskCostStatus === 'unpriced') return '未定价';
  if (item.unifiedTaskCostStatus === 'uncertain') return `待核账${item.unifiedTaskCostMinor ? ` · ¥${(item.unifiedTaskCostMinor / 100).toFixed(2)}` : ''}`;
  if (item.unifiedTaskCostStatus === 'estimated') return `估算 ¥${(item.unifiedTaskCostMinor / 100).toFixed(2)}`;
  if (item.unifiedTaskCostStatus === 'mixed') return `混合 ¥${(item.unifiedTaskCostMinor / 100).toFixed(2)}`;
  if (item.unifiedTaskCostStatus === 'settled') return `已记录 ¥${(item.unifiedTaskCostMinor / 100).toFixed(2)}`;
  return item.unifiedTaskCostMinor ? `¥${(item.unifiedTaskCostMinor / 100).toFixed(2)}` : '费用待确认';
}

const STAGE_LABELS: Record<string, string> = {
  upload: '上传', remote_submit: '生成提交', remote_poll: '远端结果查询', download: '结果下载',
  local_media: '媒体处理', storage: '结果保存', server_api: '业务接口',
  client_update: '客户端更新', client_ui: '客户端界面', server_release: '服务端发布', server_config: '服务端配置',
};

function formatTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '时间未记录';
  return new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function statusOf(item: TeamTask): TagTone {
  return consoleTaskTone(item.status) as TagTone;
}

/** 中止的请求不算错误（切换筛选/翻页时旧请求会被主动取消）。 */
function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException && cause.name === 'AbortError')
    || (cause instanceof Error && cause.name === 'AbortError');
}

export default function TeamTasksPanel({ role }: { role: WorkspaceRole }) {
  const admin = role === 'admin';
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<TeamPageSize>(DEFAULT_TEAM_PAGE_SIZE);
  const [status, setStatus] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  // `searchInput` 是输入框即时值；`query` 是已提交给服务端的 q（防抖后写入）。
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<TaskMemberOption[]>([]);

  const [list, setList] = useState<TaskListState | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listNonce, setListNonce] = useState(0);

  const [detail, setDetail] = useState<TeamTask | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailMissing, setDetailMissing] = useState(false);
  const [detailNonce, setDetailNonce] = useState(0);

  // 重试/复制这类操作自己的错误：与列表错误、详情错误互不影响，也不把列表清空。
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);

  const selectedTaskId = taskIdFromQuery(searchParams.get('taskId'));
  const filterKey = `${query}\u0000${status}\u0000${actorUserId}`;

  // ── 列表：一次只请求当前页；旧响应由 AbortController + active 丢弃 ────────────────
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setListLoading(true);
      setListError('');
    });
    const requestedPage = page;
    fetch(taskListRequestPath({ q: query, status, actorUserId, page, pageSize }), {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        if (!response.ok) throw new Error(body?.message ?? '团队任务读取失败');
        if (!active) return;
        const parsed = readTaskListResponse<TeamTask>(body);
        setList({ ...parsed, filterKey });
        // 越界页由服务端归到有效末页并返回实际 page；这里只同步一次状态，不循环重请求。
        if (parsed.pagination.page !== requestedPage) setPage(parsed.pagination.page);
      })
      .catch((cause: unknown) => {
        if (!active || isAbortError(cause)) return;
        setListError(cause instanceof Error ? cause.message : '团队任务读取失败');
      })
      .finally(() => { if (active) setListLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [query, status, actorUserId, page, pageSize, listNonce, filterKey]);

  // ── 详情：按 taskId 独立请求，不受当前页/筛选影响 ────────────────────────────────
  useEffect(() => {
    if (!selectedTaskId) return;
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setDetailLoading(true);
      setDetailError('');
      setDetailMissing(false);
      // 切换到另一条任务时先撤掉上一条的内容，避免详情区短暂显示错任务。
      setDetail((current) => (current && current.operationId === selectedTaskId ? current : null));
    });
    fetch(`/api/team/tasks/detail?taskId=${encodeURIComponent(selectedTaskId)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { item?: TeamTask; message?: string } | null;
        if (!active) return;
        if (response.status === 404) {
          setDetail(null);
          setDetailMissing(true);
          setDetailError(body?.message ?? '没有找到这条任务，可能已被清理或不属于你。');
          return;
        }
        if (!response.ok) throw new Error(body?.message ?? '任务详情读取失败');
        if (!body?.item) throw new Error('任务详情响应格式无效');
        setDetail(body.item);
      })
      .catch((cause: unknown) => {
        if (!active || isAbortError(cause)) return;
        setDetailError(cause instanceof Error ? cause.message : '任务详情读取失败');
      })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [selectedTaskId, detailNonce]);

  // 管理员才有完整成员列表（员工拿不到 `/api/team/users`，也不请求它）。
  useEffect(() => {
    if (!admin) return;
    let active = true;
    fetch('/api/team/users', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { users?: unknown };
        if (!active) return;
        setMembers(memberOptionsFromUsers(Array.isArray(body.users) ? body.users : []));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [admin]);

  // 搜索防抖：打字约 300ms 后才发服务端请求；输入框不重挂，焦点不会丢。
  const changeSearchNow = useCallback((value: string) => {
    setQuery(value.trim());
    setPage((current) => taskPageAfterChange(current, { kind: 'filter' }));
  }, []);

  useEffect(() => {
    const next = searchInput.trim();
    if (next === query) return;
    const timer = window.setTimeout(() => changeSearchNow(next), TASK_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput, query, changeSearchNow]);

  const openTask = useCallback((operationId: string | null, trigger?: HTMLElement | null) => {
    if (operationId && trigger) detailTriggerRef.current = trigger;
    const params = new URLSearchParams(searchParams.toString());
    if (operationId) params.set('taskId', operationId);
    else params.delete('taskId');
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  const closeDetail = useCallback(() => {
    setDetail(null);
    setDetailError('');
    setDetailMissing(false);
    setDetailLoading(false);
    openTask(null);
    const trigger = detailTriggerRef.current;
    detailTriggerRef.current = null;
    // 归还焦点：把焦点放回打开详情的那一行（深链打开的没有触发按钮，就不强行挪焦点）。
    if (trigger) requestAnimationFrame(() => trigger.focus());
  }, [openTask]);

  const refresh = useCallback(() => {
    // 手动刷新保留当前页；越界时由响应 pagination.page 收敛。
    setPage((current) => taskPageAfterChange(current, { kind: 'refresh' }));
    setListNonce((value) => value + 1);
    setDetailNonce((value) => value + 1);
  }, []);

  const changePage = useCallback((next: PaginationChange) => {
    if (next.pageSize !== pageSize) {
      setPageSize(next.pageSize);
      setPage((current) => taskPageAfterChange(current, { kind: 'pageSize' }));
      return;
    }
    setPage((current) => taskPageAfterChange(current, { kind: 'page', page: next.page }));
  }, [pageSize]);

  const changeStatus = useCallback((next: string) => {
    setStatus(next);
    setPage((current) => taskPageAfterChange(current, { kind: 'filter' }));
  }, []);

  const changeActor = useCallback((next: string) => {
    setActorUserId(next);
    setPage((current) => taskPageAfterChange(current, { kind: 'filter' }));
  }, []);

  const clearFilters = useCallback(() => {
    setSearchInput('');
    setQuery('');
    setStatus('');
    setActorUserId('');
    setPage((current) => taskPageAfterChange(current, { kind: 'filter' }));
    setActionError('');
    searchRef.current?.focus();
  }, []);

  async function retry(item: TeamTask) {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      const response = await teamWrite('/api/team/tasks/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: item.operationId }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '重试没有成功');
      setNotice(body.message ?? '已重新加入队列。');
      // 重试后同步刷新详情与当前页（各自 effect 重新取），不再提交任何模型调用。
      setListNonce((value) => value + 1);
      setDetailNonce((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '重试没有成功');
    } finally {
      setBusy(false);
    }
  }

  async function copyDetails(item: TeamTask) {
    try {
      await navigator.clipboard.writeText(JSON.stringify({
        task: item.taskName, step: item.stepName, rawStep: item.step, project: item.scopeName,
        taskId: item.taskId, operationId: item.operationId, module: item.module, status: item.status,
        waitReason: item.waitReason, actor: item.employeeId, providerName: item.providerName,
        model: item.model, modelCalls: item.modelCalls, input: item.inputFilename,
        inputRevision: item.inputRevision, submissionCount: item.submissionCount,
        attemptCount: item.unifiedTaskAttemptCount || item.attemptCount,
        channelAttemptCount: item.unifiedTaskChannelCount, taskCostMinor: item.unifiedTaskCostMinor,
        admissionPriority: item.admissionPriority, admissionCandidateCount: item.admissionCandidateCount,
        admissionTrace: item.admissionTrace,
        unifiedTaskId: item.unifiedTaskId, businessAttemptNo: item.businessAttemptNo,
        errorId: item.errorId, errorStage: item.errorStage, errorCode: item.errorCode,
        clientVersion: item.clientVersion, serverReleaseId: item.serverReleaseId,
        configVersion: item.configVersion, updatedAt: item.updatedAt,
      }, null, 2));
      setNotice('已复制排查信息。');
      setCopied(item.operationId);
    } catch {
      setNotice('');
      setCopied('');
      setActionError('复制失败，请展开排查详情手动复制任务编号。');
    }
  }

  const hasFilters = Boolean(query || searchInput.trim() || status || actorUserId);
  const readyList = list && list.filterKey === filterKey ? list : null;
  const displayGroups = useMemo(() => groupTeamTaskRows(readyList?.items ?? []), [readyList]);
  const groups = useMemo(() => groupPageByActor(displayGroups), [displayGroups]);
  const onCurrentPage = Boolean(readyList?.items.some((item) => item.operationId === selectedTaskId));
  const retryable = detail ? detail.status === 'failed' && ['image', 'video'].includes(String(detail.module)) : false;

  function taskTable(rows: typeof displayGroups) {
    return (
      <div className={`overflow-x-auto ${s.tableWrap}`}>
        <table className={s.table}>
          <thead>
            <tr>{['任务', '项目', '发起人', '模型', '状态', '时间'].map((label) => <th key={label}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((group) => {
              const item = group.representative;
              const isSelected = group.items.some((candidate) => candidate.operationId === selectedTaskId);
              return (
                <tr
                  key={group.key}
                  tabIndex={0}
                  data-testid="task-row"
                  data-operation-id={item.operationId}
                  data-unified-task-id={item.unifiedTaskId ?? undefined}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={(event) => openTask(isSelected ? null : item.operationId, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openTask(isSelected ? null : item.operationId, event.currentTarget);
                    }
                  }}
                >
                  <td>
                    <span className={s.taskName} title={item.taskName}>{item.taskName}</span>
                    <span className={s.taskStep}>{item.stepName}{group.items.length > 1 ? ` · 同一制作任务 ${group.items.length} 条执行记录` : ''}</span>
                  </td>
                  <td className={`${s.secondary} ${s.truncate}`} title={item.scopeName}>{item.scopeName}</td>
                  <td className={s.secondary}>{item.actorDisplayName}<span className={`${s.taskStep} block`}>工号 {item.employeeId}</span></td>
                  <td className={`${s.secondary} ${s.mono} ${s.truncate}`} title={item.model ?? '未记录'}>{item.model ?? '未记录'}</td>
                  <td>
                    <Tag tone={statusOf(item)}>{TASK_STATUS_LABELS[item.status] ?? item.status}</Tag>
                    {item.waitLabel ? <span className={`${s.taskStep} block`}>{item.waitLabel}</span> : null}
                    {item.unifiedTaskId ? <span className={`${s.taskStep} block`}>任务合计 {unifiedTaskCostLabel(item)} · 通道 {item.unifiedTaskChannelCount}</span> : null}
                  </td>
                  <td className={`${s.secondary} ${s.nowrap} ${s.mono}`}>{formatTime(item.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function paginationRow(position: 'top' | 'bottom') {
    if (!readyList || listError) return null;
    return (
      <div className={`${s.paginationRow} ${position === 'top' ? s.paginationRowTop : ''}`} data-testid={`task-pagination-${position}`}>
        <Pagination
          label="制作任务"
          unit="个制作任务"
          page={readyList.pagination.page}
          pageSize={pageSize}
          total={readyList.pagination.total}
          totalPages={readyList.pagination.totalPages}
          loading={listLoading}
          onChange={changePage}
        />
      </div>
    );
  }

  function detailBody() {
    if (detail) {
      return (
        <div className={s.panelBody} data-testid="task-detail-content">
          {readyList && !onCurrentPage ? (
            <p className={s.detailNote} data-testid="task-detail-off-page" role="status">
              这条任务不在当前列表页；翻页或更改筛选不会关掉这条详情。
            </p>
          ) : null}
          {detail.status === 'failed' ? (
            <p className="rounded-lg bg-fail-tint px-3 py-2 text-[12.5px] leading-5 text-fail">
              这一步失败了{detail.errorId ? `，错误编号 ${detail.errorId}` : ''}
              {detail.errorStage ? `，卡在「${STAGE_LABELS[detail.errorStage] ?? detail.errorStage}」阶段` : ''}。
              重试只重新排队这一步，不会重复扣已完成的部分。
            </p>
          ) : null}
          {detail.status === 'unknown' || detail.status === 'maybe_sent' ? (
            <p className="rounded-lg bg-warn-tint px-3 py-2 text-[12.5px] leading-5 text-warn">
              结果还没确认。先核对结果，再决定要不要重试，避免重复扣费。
            </p>
          ) : null}
          <GroupList>
            <GroupRow label="状态">
              <span className="flex items-center gap-2 text-[12.5px]">
                <Tag tone={statusOf(detail)}>{TASK_STATUS_LABELS[detail.status] ?? detail.status}</Tag>
                {detail.waitLabel ? <span className="text-ink-secondary">{detail.waitLabel}</span> : null}
              </span>
            </GroupRow>
            {/* 长值用 stacked：项目名、错误编号、错误说明都可能很长，横排会把左侧标签压成一字一行。 */}
            <GroupRow label="项目 / 画布" stacked>
              {['project', 'canvas'].includes(detail.scope.resourceType)
                ? <Link className="text-[12.5px] text-accent break-all" href={detail.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(detail.scope.resourceId)}` : `/canvas/${encodeURIComponent(detail.scope.resourceId)}`}>{detail.scopeName} →</Link>
                : <span className="text-[12.5px] break-all">{detail.scopeName}</span>}
            </GroupRow>
            <GroupRow label="发起人">{detail.actorDisplayName}（工号 {detail.employeeId}）</GroupRow>
            <GroupRow label="供应商" stacked><span className="text-[12.5px] break-all">{detail.providerName}</span></GroupRow>
            <GroupRow label="实际模型" stacked><span className="text-[12.5px] break-all">{detail.model ?? '未记录'}</span></GroupRow>
            {detail.unifiedTaskId ? (
              <GroupRow label="制作任务合计" stacked>
                <span className="text-[12.5px]">
                  1 个制作任务 · {detail.unifiedTaskAttemptCount} 次通道调用 · {detail.unifiedTaskChannelCount} 条通道
                  {` · ${unifiedTaskCostLabel(detail)}`}
                </span>
                <span className={`${s.taskStep} block`}>同一制作任务的自动兜底不会增加作品份数。</span>
              </GroupRow>
            ) : null}
            {detail.admissionPriority !== null ? (
              <GroupRow label="调度优先级" stacked>
                <span className="text-[12.5px]">
                  {detail.admissionTrace?.priorityClass === 'single_channel'
                    ? '单通道任务优先'
                    : detail.admissionTrace?.priorityClass === 'overflow'
                      ? `可溢出任务（候选 ${detail.admissionCandidateCount ?? 2} 条通道）`
                      : '普通调度'}
                  {detail.admissionTrace?.aged === true ? ' · 已按等待时长提升' : ''}
                </span>
                <span className={`${s.taskStep} block`}>
                  成员公平与预算/权限门禁先于该偏好；不会绕过共享池容量。
                </span>
              </GroupRow>
            ) : null}
            {detail.errorId ? (
              <GroupRow label="错误编号" stacked>
                <Link className="text-[12.5px] text-accent break-all" href={`/team/errors?errorId=${encodeURIComponent(detail.errorId)}`}>{detail.errorId} →</Link>
              </GroupRow>
            ) : null}
            {detail.errorStage ? <GroupRow label="失败阶段">{STAGE_LABELS[detail.errorStage] ?? detail.errorStage}</GroupRow> : null}
            {detail.errorMessage ? <GroupRow label="错误说明" stacked><span className="text-[12.5px] leading-5 break-words">{detail.errorMessage}</span></GroupRow> : null}
            <GroupRow label="发送记录">
              {detail.submissionCount === 0 ? '尚未发送' : `发送尝试 ${detail.submissionCount} 次`}
              <span className={`${s.taskStep} block`}>第 {detail.businessAttemptNo} 轮任务 · 执行尝试 {detail.unifiedTaskAttemptCount || detail.attemptCount} 条</span>
            </GroupRow>
            <GroupRow label="更新时间">{formatTime(detail.updatedAt)}</GroupRow>
          </GroupList>
          {/* 完整编号沿用改版前的做法：默认收起，展开才看。列表与详情正文都不直接铺长 UUID。 */}
          <details className="text-[11.5px] text-ink-secondary">
            <summary className="cursor-pointer text-accent">编号与版本</summary>
            <div className="mt-2 grid gap-1.5 break-all">
              <div>任务编号：<span className={s.mono}>{detail.taskId}</span></div>
              <div>执行记录：<span className={s.mono}>{detail.operationId}</span></div>
              <div>输入版本：{detail.inputRevision}</div>
              <div>客户端：{detail.clientVersion ?? '未提供'}</div>
              <div>服务端：{detail.serverReleaseId ?? '未记录'}</div>
              <div>配置：{detail.configVersion ?? '未记录'}</div>
            </div>
          </details>
          {/* 供应商与模型已在上面「分组列表」里，这里只补调用记录（showSummary={false} 不再重复那两行）。 */}
          <TeamTaskModel providerName={detail.providerName} model={detail.model} modelStatus={detail.modelStatus} calls={detail.modelCalls} showSummary={false} />
          <p className="text-[11.5px] leading-5 text-ink-tertiary">调用记录不等于制作份数，也不等于扣费次数。</p>
          <div className="flex flex-wrap gap-2">
            {['project', 'canvas'].includes(detail.scope.resourceType) ? (
              <Link className="btn-secondary btn-sm" href={detail.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(detail.scope.resourceId)}` : `/canvas/${encodeURIComponent(detail.scope.resourceId)}`}>打开项目</Link>
            ) : null}
            <button type="button" className="btn-secondary btn-sm" onClick={() => void copyDetails(detail)}>
              {copied === detail.operationId ? '已复制排查信息' : '复制排查信息'}
            </button>
            {retryable ? (
              <button type="button" className="btn-primary btn-sm" onClick={() => void retry(detail)} disabled={busy} data-testid="retry-task">
                {busy ? '正在重试…' : '重试这一步'}
              </button>
            ) : null}
          </div>
          {detail.status === 'failed' && !retryable ? (
            <p className="text-[11.5px] leading-5 text-ink-tertiary">
              {['image', 'video'].includes(String(detail.module))
                ? '这条任务缺少可重试的业务任务号，请到项目里重试。'
                : `${detail.taskName}的重试入口在项目里：打开项目，在对应步骤上点重试。`}
            </p>
          ) : null}
          {detail.waitReason ? <p className="text-[11.5px] leading-5 text-ink-tertiary">等待原因：{taskWaitLabel(detail.waitReason, null)}</p> : null}
        </div>
      );
    }
    if (detailMissing) {
      return (
        <div className={s.panelBody}>
          <p role="alert" className="rounded-lg bg-warn-tint px-3 py-2 text-[12.5px] leading-5 text-warn" data-testid="task-detail-missing">
            {detailError || '没有找到这条任务，可能已被清理或不属于你。'}
          </p>
          <p className="text-[11.5px] leading-5 text-ink-tertiary">
            员工只能查看自己的任务；如果任务确实存在，请刷新列表后重试，或联系管理员确认。
          </p>
        </div>
      );
    }
    if (detailError) {
      return (
        <div className={s.panelBody}>
          <p role="alert" className="text-[13px] text-fail" data-testid="task-detail-error">{detailError}</p>
          <button type="button" className="cap justify-self-start" onClick={() => setDetailNonce((value) => value + 1)}>重新读取详情</button>
        </div>
      );
    }
    return (
      <div className={s.panelBody}>
        <p className="text-[13px] text-ink-tertiary" role="status" data-testid="task-detail-loading">读取任务详情…</p>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <PageToolbar
        role={role}
        subtitle={admin
          ? '按项目、步骤和发起人找任务；点一行看这一步的详情，出错能直接重试。'
          : '任务在服务器上跑，关掉窗口也不会停；这里只有你自己的任务。'}
        actions={
          <>
            <ToolbarButton onClick={() => setGrouped((value) => !value)}>{grouped ? '平铺' : '按发起人分组'}</ToolbarButton>
            <ToolbarButton icon="retry" onClick={refresh} disabled={listLoading}>刷新</ToolbarButton>
          </>
        }
      />

      {actionError ? <p role="alert" className="text-[13px] text-fail">{actionError}</p> : null}
      {notice ? <p role="status" className="text-[13px] text-ok">{notice}</p> : null}

      <section className={s.panel} aria-label="筛选">
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="min-w-56 flex-1 text-xs text-ink-secondary">
            查找任务
            <input
              ref={searchRef}
              className="input-field mt-1 w-full"
              placeholder="项目名、步骤、模型、姓名、工号或任务编号"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  // 读输入框当前值：回车可能在同一次输入事件尚未重渲染时到达。
                  changeSearchNow(event.currentTarget.value);
                }
              }}
              aria-label="查找任务"
            />
          </label>
          {admin ? (
            <label className="text-xs text-ink-secondary">发起人
              <select aria-label="发起人" className="input-field mt-1" value={actorUserId} onChange={(event) => changeActor(event.target.value)}>
                <option value="">全部成员</option>
                {members.map((member) => <option value={member.id} key={member.id}>{member.displayName}（{member.employeeId}）</option>)}
              </select>
            </label>
          ) : null}
          <label className="text-xs text-ink-secondary">状态
            <select aria-label="状态" className="input-field mt-1" value={status} onChange={(event) => changeStatus(event.target.value)}>
              <option value="">全部状态</option>
              {Object.entries(TASK_STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          {hasFilters ? <button type="button" className="btn-secondary btn-sm" onClick={clearFilters}>清除筛选</button> : null}
        </div>
        <p className={s.panelNote} role="status" data-testid="task-list-summary">
          {listError
            ? '任务总数读取失败；请重试，不显示为 0 条。'
            : readyList
              ? `${taskTotalSummary(readyList.pagination.total, readyList.totalRecords)}；第 ${readyList.pagination.page} / ${readyList.pagination.totalPages} 页。`
              : '正在读取任务总数…'}
          {' '}搜索和筛选覆盖全部可见历史；发送尝试包含结果未确认的请求，不等于扣费次数。
        </p>
      </section>

      <div className={s.columns} style={{ gridTemplateColumns: selectedTaskId ? 'minmax(0, 1fr) minmax(320px, 400px)' : 'minmax(0, 1fr)' }}>
        <div className="grid gap-3" style={{ minWidth: 0 }}>
          {paginationRow('top')}
          {listError ? (
            <section className={s.panel} aria-label="任务列表" data-testid="task-list-error">
              <div className="p-6" role="alert">
                <p className="text-[13px] text-fail">{listError}</p>
                <p className="mt-1 text-[11.5px] leading-5 text-ink-tertiary">
                  列表没有读取成功，所以不显示为「0 条」；重试即可重新读取当前条件的这一页。
                </p>
                <button type="button" className="cap mt-3" onClick={() => setListNonce((value) => value + 1)}>重试读取列表</button>
              </div>
            </section>
          ) : !readyList ? (
            <p className="py-8 text-center text-[13px] text-ink-tertiary" role="status">读取团队任务…</p>
          ) : readyList.items.length === 0 ? (
            <section className={s.panel} aria-label="任务列表">
              <div className="p-6">
                <EmptyState
                  icon="search"
                  title={hasFilters ? '没有符合条件的任务' : '当前没有团队任务'}
                  description={hasFilters
                    ? (
                      <>
                        <span>当前筛选没有团队任务。</span>
                        <span className="mt-1 block">{query
                          ? `「${query}」没有匹配到项目名、模型、姓名、工号或任务编号；换个词，或者清除筛选看全部。`
                          : '换一个发起人或状态，或者清除筛选看全部。'}</span>
                      </>
                    )
                    : '服务器上还没有登记任何任务；成员提交生成后会自动出现在这里。'}
                  action={hasFilters
                    ? <button type="button" className="cap" onClick={clearFilters}>清除筛选</button>
                    : <Link className="cap" href="/">回运行总览</Link>}
                />
              </div>
            </section>
          ) : grouped ? (
            groups.map((member) => {
              const isCollapsed = collapsed.has(member.actorUserId);
              return (
                <section key={member.actorUserId} aria-label={`${member.displayName}（${member.employeeId}）的任务`} className={s.panel} data-testid="actor-group">
                  <div className={s.panelHead}>
                    <h2>
                      {member.displayName}
                      <span className={`ml-2 ${s.groupMeta}`}>工号 {member.employeeId}</span>
                      <span className={`ml-2 ${s.groupMeta}`} data-testid="actor-group-count">本页 {member.groups.length} 项</span>
                    </h2>
                    <button
                      type="button"
                      className="link"
                      aria-expanded={!isCollapsed}
                      onClick={() => setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(member.actorUserId)) next.delete(member.actorUserId);
                        else next.add(member.actorUserId);
                        return next;
                      })}
                    >
                      {isCollapsed ? '展开' : '折叠'}
                    </button>
                  </div>
                  {isCollapsed ? null : taskTable(member.groups)}
                </section>
              );
            })
          ) : (
            <section className={s.panel} aria-label="任务列表" data-testid="task-flat-list">{taskTable(displayGroups)}</section>
          )}
          {paginationRow('bottom')}
        </div>

        {selectedTaskId ? (
          <aside className={s.panel} aria-label="任务详情" data-testid="task-detail" aria-busy={detailLoading || undefined}>
            <div className={s.panelHead}>
              <h2>{detail ? `${detail.taskName} · ${detail.stepName}` : '任务详情'}</h2>
              <button type="button" className="link" onClick={closeDetail}>关闭</button>
            </div>
            {detailBody()}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
