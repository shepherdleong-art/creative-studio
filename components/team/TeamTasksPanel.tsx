'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import PageToolbar from '@/components/team/PageToolbar';
import { EmptyState, GroupList, GroupRow, Tag, ToolbarButton, type TagTone } from '@/components/ui/Appearance';
import { teamError, teamWrite } from './client';
import { TASK_STATUS_LABELS, taskWaitLabel } from '@/lib/team-task-labels';
import TeamTaskModel, { type TeamTaskModelCall } from './TeamTaskModel';
import { consoleTaskTone, taskIdFromQuery } from '@/lib/team-console-overview';
import s from './console.module.css';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

/**
 * 全员任务 / 我的任务（12 号票）。
 *
 * 详情 URL 形态：**`/team/tasks?taskId=<operationId>`**——运行总览的最近任务行、错误中心、
 * 用量明细都用这一条跳过来（`taskDetailHref()` 是唯一生成处）。`operationId` 是对外可见的
 * 执行记录编号（`execution_operations.id`），不是 `tasks` 表里的业务任务号。
 *
 * 关键行为：
 * - 搜索框是受控输入，但筛选在内存里做：**打字不重新请求、不丢焦点**；
 * - 发起人 / 状态筛选走服务端（与侧栏角标、权限同一口径）；
 * - 没有结果时显示说明和「清除筛选」；
 * - 详情写清错误编号、失败阶段、模型和调用记录；明确失败的图片 / 视频任务可以直接重试。
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
type Member = { id: string; employeeId: string; displayName: string };

export type TeamTaskDisplayGroup = {
  key: string;
  items: TeamTask[];
  representative: TeamTask;
};

/**
 * The task API is operation-level so errors/retries stay precise. The list
 * presents a unified work task once; its real channel operations remain
 * available through the detail counts and, for admins, usage drill-down.
 */
export function groupTeamTaskRows(items: TeamTask[]): TeamTaskDisplayGroup[] {
  const groups = new Map<string, TeamTask[]>();
  for (const item of items) {
    const key = item.unifiedTaskId ? `unified:${item.unifiedTaskId}` : `operation:${item.operationId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([key, groupedItems]) => ({
    key,
    items: groupedItems,
    representative: groupedItems[0],
  }));
}

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

const SEARCH_FIELDS = [
  'taskName', 'stepName', 'scopeName', 'inputFilename', 'taskId', 'operationId',
  'actorDisplayName', 'employeeId', 'model', 'providerName', 'errorId', 'errorCode',
] as const;

/** 搜索：项目名、步骤、模型、姓名、工号、任务编号、执行记录编号、错误编号。 */
export function matchesTaskQuery(item: TeamTask, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return SEARCH_FIELDS.some((key) => {
    const value = item[key];
    return typeof value === 'string' && value.toLowerCase().includes(needle);
  });
}

function formatTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '时间未记录';
  return new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function statusOf(item: TeamTask): TagTone {
  return consoleTaskTone(item.status) as TagTone;
}

export default function TeamTasksPanel({ role }: { role: WorkspaceRole }) {
  const admin = role === 'admin';
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [items, setItems] = useState<TeamTask[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [status, setStatus] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [search, setSearch] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedTaskId = taskIdFromQuery(searchParams.get('taskId'));
  const selected = useMemo(
    () => (selectedTaskId ? items.find((item) => item.operationId === selectedTaskId) ?? null : null),
    [items, selectedTaskId],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (actorUserId) params.set('actorUserId', actorUserId);
      const query = params.toString();
      const response = await fetch(`/api/team/tasks${query ? `?${query}` : ''}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(await teamError(response, '团队任务读取失败'));
      const body = await response.json() as { items: TeamTask[] };
      setItems(body.items);
      if (!actorUserId) {
        const seen = new Map<string, Member>();
        for (const item of body.items) seen.set(item.actorUserId, { id: item.actorUserId, employeeId: item.employeeId, displayName: item.actorDisplayName });
        setMembers([...seen.values()].sort((left, right) => left.employeeId.localeCompare(right.employeeId)));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '团队任务读取失败');
    } finally {
      setLoading(false);
    }
  }, [status, actorUserId]);

  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  // 管理员才有完整成员列表（员工拿不到 `/api/team/users`，只能看到自己）。
  useEffect(() => {
    if (!admin) return;
    void fetch('/api/team/users', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { users: Member[] };
        setMembers(body.users.map((user) => ({ id: user.id, employeeId: user.employeeId, displayName: user.displayName })));
      })
      .catch(() => undefined);
  }, [admin]);

  const visible = useMemo(() => items.filter((item) => matchesTaskQuery(item, search)), [items, search]);
  const displayGroups = useMemo(() => groupTeamTaskRows(visible), [visible]);
  const groups = useMemo(() => {
    const byActor = new Map<string, TeamTaskDisplayGroup[]>();
    for (const group of displayGroups) {
      const actorId = group.representative.actorUserId;
      byActor.set(actorId, [...(byActor.get(actorId) ?? []), group]);
    }
    return [...byActor.entries()];
  }, [displayGroups]);

  const openTask = useCallback((operationId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (operationId) params.set('taskId', operationId);
    else params.delete('taskId');
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setStatus('');
    setActorUserId('');
    setError('');
    searchRef.current?.focus();
  }, []);

  async function retry(item: TeamTask) {
    setBusy(true);
    setError('');
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
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试没有成功');
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
      setError('复制失败，请展开排查详情手动复制任务编号。');
    }
  }

  const hasFilters = Boolean(search.trim() || status || actorUserId);
  const retryable = selected ? selected.status === 'failed' && ['image', 'video'].includes(String(selected.module)) : false;

  function taskTable(rows: TeamTaskDisplayGroup[]) {
    return (
      <div className="overflow-x-auto">
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
                onClick={() => openTask(isSelected ? null : item.operationId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openTask(isSelected ? null : item.operationId);
                  }
                }}
              >
                <td><span className={s.taskName}>{item.taskName}</span><span className={s.taskStep}>{item.stepName}{group.items.length > 1 ? ` · 同一制作任务 ${group.items.length} 条执行记录` : ''}</span></td>
                <td className={`${s.secondary} truncate`}>{item.scopeName}</td>
                <td className={s.secondary}>{item.actorDisplayName}<span className={`${s.taskStep} block`}>工号 {item.employeeId}</span></td>
                <td className={`${s.secondary} ${s.mono} truncate`}>{item.model ?? '未记录'}</td>
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
            <ToolbarButton icon="retry" onClick={() => void refresh()} disabled={loading}>刷新</ToolbarButton>
          </>
        }
      />
      {error ? <p role="alert" className="text-[13px] text-fail">{error}</p> : null}
      {notice ? <p role="status" className="text-[13px] text-ok">{notice}</p> : null}

      <section className={s.panel} aria-label="筛选">
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="min-w-56 flex-1 text-xs text-ink-secondary">
            查找任务
            <input
              ref={searchRef}
              className="input-field mt-1 w-full"
              placeholder="项目名、步骤、模型、姓名、工号或任务编号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="查找任务"
            />
          </label>
          {admin ? (
            <label className="text-xs text-ink-secondary">发起人
              <select aria-label="发起人" className="input-field mt-1" value={actorUserId} onChange={(event) => setActorUserId(event.target.value)}>
                <option value="">全部成员</option>
                {members.map((member) => <option value={member.id} key={member.id}>{member.displayName}（{member.employeeId}）</option>)}
              </select>
            </label>
          ) : null}
          <label className="text-xs text-ink-secondary">状态
            <select aria-label="状态" className="input-field mt-1" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部状态</option>
              {Object.entries(TASK_STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          {hasFilters ? <button type="button" className="btn-secondary btn-sm" onClick={clearFilters}>清除筛选</button> : null}
        </div>
        <p className={s.panelNote} role="status">
          当前结果 {displayGroups.length} 个制作任务（{visible.length} 条执行记录）{items.length > visible.length ? `，从 ${items.length} 条里筛出` : ''}；服务端最多返回最近 500 条执行记录，不是全历史总数。发送尝试包含结果未确认的请求，不等于扣费次数。
        </p>
      </section>

      {loading && items.length === 0 ? <p className="text-center text-[13px] text-ink-tertiary" role="status">读取团队任务…</p> : null}

      <div className={s.columns} style={{ gridTemplateColumns: selected ? 'minmax(0, 1fr) minmax(320px, 400px)' : 'minmax(0, 1fr)' }}>
        <div className="grid gap-3" style={{ minWidth: 0 }}>
          {!loading || items.length > 0 ? (
            displayGroups.length === 0 && !loading ? (
              <section className={s.panel} aria-label="任务列表">
                <div className="p-6">
                  <EmptyState
                    icon="search"
                    title={hasFilters ? '没有符合条件的任务' : '当前没有团队任务'}
                    description={hasFilters
                      ? (
                        <>
                          <span>当前筛选没有团队任务。</span>
                          <span className="mt-1 block">{search.trim()
                            ? `「${search.trim()}」没有匹配到项目名、模型、姓名、工号或任务编号；换个词，或者清除筛选看全部。`
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
              groups.map(([memberId, groupItems]) => {
                const member = groupItems[0].representative;
                const isCollapsed = collapsed.has(memberId);
                return (
                  <section key={memberId} aria-label={`${member.actorDisplayName}（${member.employeeId}）的任务`} className={s.panel}>
                    <div className={s.panelHead}>
                      <h2>{member.actorDisplayName}<span className="ml-2 text-[11.5px] font-normal text-ink-tertiary">工号 {member.employeeId}</span></h2>
                      <button
                        type="button"
                        className="link"
                        aria-expanded={!isCollapsed}
                        onClick={() => setCollapsed((previous) => {
                          const next = new Set(previous);
                          if (next.has(memberId)) next.delete(memberId);
                          else next.add(memberId);
                          return next;
                        })}
                      >
                        {isCollapsed ? '展开' : '折叠'}
                      </button>
                    </div>
                    {isCollapsed ? null : taskTable(groupItems)}
                  </section>
                );
              })
            ) : (
              <section className={s.panel} aria-label="任务列表">{taskTable(displayGroups)}</section>
            )
          ) : null}
        </div>

        {selected ? (
          <aside className={s.panel} aria-label="任务详情" data-testid="task-detail">
            <div className={s.panelHead}>
              <h2>{selected.taskName} · {selected.stepName}</h2>
              <button type="button" className="link" onClick={() => openTask(null)}>关闭</button>
            </div>
            <div className={s.panelBody}>
              {selected.status === 'failed' ? (
                <p className="rounded-lg bg-fail-tint px-3 py-2 text-[12.5px] leading-5 text-fail">
                  这一步失败了{selected.errorId ? `，错误编号 ${selected.errorId}` : ''}
                  {selected.errorStage ? `，卡在「${STAGE_LABELS[selected.errorStage] ?? selected.errorStage}」阶段` : ''}。
                  重试只重新排队这一步，不会重复扣已完成的部分。
                </p>
              ) : null}
              {selected.status === 'unknown' || selected.status === 'maybe_sent' ? (
                <p className="rounded-lg bg-warn-tint px-3 py-2 text-[12.5px] leading-5 text-warn">
                  结果还没确认。先核对结果，再决定要不要重试，避免重复扣费。
                </p>
              ) : null}
              <GroupList>
                <GroupRow label="状态">
                  <span className="flex items-center gap-2 text-[12.5px]">
                    <Tag tone={statusOf(selected)}>{TASK_STATUS_LABELS[selected.status] ?? selected.status}</Tag>
                    {selected.waitLabel ? <span className="text-ink-secondary">{selected.waitLabel}</span> : null}
                  </span>
                </GroupRow>
                {/* 长值用 stacked：项目名、错误编号、错误说明都可能很长，横排会把左侧标签压成一字一行。 */}
                <GroupRow label="项目 / 画布" stacked>
                  {['project', 'canvas'].includes(selected.scope.resourceType)
                    ? <Link className="text-[12.5px] text-accent break-all" href={selected.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(selected.scope.resourceId)}` : `/canvas/${encodeURIComponent(selected.scope.resourceId)}`}>{selected.scopeName} →</Link>
                    : <span className="text-[12.5px] break-all">{selected.scopeName}</span>}
                </GroupRow>
                <GroupRow label="发起人">{selected.actorDisplayName}（工号 {selected.employeeId}）</GroupRow>
                <GroupRow label="供应商" stacked><span className="text-[12.5px] break-all">{selected.providerName}</span></GroupRow>
                <GroupRow label="实际模型" stacked><span className="text-[12.5px] break-all">{selected.model ?? '未记录'}</span></GroupRow>
                {selected.unifiedTaskId ? (
                  <GroupRow label="制作任务合计" stacked>
                    <span className="text-[12.5px]">
                      1 个制作任务 · {selected.unifiedTaskAttemptCount} 次通道调用 · {selected.unifiedTaskChannelCount} 条通道
                      {` · ${unifiedTaskCostLabel(selected)}`}
                    </span>
                    <span className={`${s.taskStep} block`}>同一制作任务的自动兜底不会增加作品份数。</span>
                  </GroupRow>
                ) : null}
                {selected.admissionPriority !== null ? (
                  <GroupRow label="调度优先级" stacked>
                    <span className="text-[12.5px]">
                      {selected.admissionTrace?.priorityClass === 'single_channel'
                        ? '单通道任务优先'
                        : selected.admissionTrace?.priorityClass === 'overflow'
                          ? `可溢出任务（候选 ${selected.admissionCandidateCount ?? 2} 条通道）`
                          : '普通调度'}
                      {selected.admissionTrace?.aged === true ? ' · 已按等待时长提升' : ''}
                    </span>
                    <span className={`${s.taskStep} block`}>
                      成员公平与预算/权限门禁先于该偏好；不会绕过共享池容量。
                    </span>
                  </GroupRow>
                ) : null}
                {selected.errorId ? (
                  <GroupRow label="错误编号" stacked>
                    <Link className="text-[12.5px] text-accent break-all" href={`/team/errors?errorId=${encodeURIComponent(selected.errorId)}`}>{selected.errorId} →</Link>
                  </GroupRow>
                ) : null}
                {selected.errorStage ? <GroupRow label="失败阶段">{STAGE_LABELS[selected.errorStage] ?? selected.errorStage}</GroupRow> : null}
                {selected.errorMessage ? <GroupRow label="错误说明" stacked><span className="text-[12.5px] leading-5 break-words">{selected.errorMessage}</span></GroupRow> : null}
                <GroupRow label="发送记录">
                  {selected.submissionCount === 0 ? '尚未发送' : `发送尝试 ${selected.submissionCount} 次`}
                  <span className={`${s.taskStep} block`}>第 {selected.businessAttemptNo} 轮任务 · 执行尝试 {selected.unifiedTaskAttemptCount || selected.attemptCount} 条</span>
                </GroupRow>
                <GroupRow label="更新时间">{formatTime(selected.updatedAt)}</GroupRow>
              </GroupList>
              {/* 完整编号沿用改版前的做法：默认收起，展开才看。列表与详情正文都不直接铺长 UUID。 */}
              <details className="text-[11.5px] text-ink-secondary">
                <summary className="cursor-pointer text-accent">编号与版本</summary>
                <div className="mt-2 grid gap-1.5 break-all">
                  <div>任务编号：<span className={s.mono}>{selected.taskId}</span></div>
                  <div>执行记录：<span className={s.mono}>{selected.operationId}</span></div>
                  <div>输入版本：{selected.inputRevision}</div>
                  <div>客户端：{selected.clientVersion ?? '未提供'}</div>
                  <div>服务端：{selected.serverReleaseId ?? '未记录'}</div>
                  <div>配置：{selected.configVersion ?? '未记录'}</div>
                </div>
              </details>
              {/* 供应商与模型已在上面「分组列表」里，这里只补调用记录（showSummary={false} 不再重复那两行）。 */}
              <TeamTaskModel providerName={selected.providerName} model={selected.model} modelStatus={selected.modelStatus} calls={selected.modelCalls} showSummary={false} />
              <p className="text-[11.5px] leading-5 text-ink-tertiary">调用记录不等于制作份数，也不等于扣费次数。</p>
              <div className="flex flex-wrap gap-2">
                {['project', 'canvas'].includes(selected.scope.resourceType) ? (
                  <Link className="btn-secondary btn-sm" href={selected.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(selected.scope.resourceId)}` : `/canvas/${encodeURIComponent(selected.scope.resourceId)}`}>打开项目</Link>
                ) : null}
                <button type="button" className="btn-secondary btn-sm" onClick={() => void copyDetails(selected)}>
                  {copied === selected.operationId ? '已复制排查信息' : '复制排查信息'}
                </button>
                {retryable ? (
                  <button type="button" className="btn-primary btn-sm" onClick={() => void retry(selected)} disabled={busy} data-testid="retry-task">
                    {busy ? '正在重试…' : '重试这一步'}
                  </button>
                ) : null}
              </div>
              {selected.status === 'failed' && !retryable ? (
                <p className="text-[11.5px] leading-5 text-ink-tertiary">
                  {['image', 'video'].includes(String(selected.module))
                    ? '这条任务缺少可重试的业务任务号，请到项目里重试。'
                    : `${selected.taskName}的重试入口在项目里：打开项目，在对应步骤上点重试。`}
                </p>
              ) : null}
              {selected.waitReason ? <p className="text-[11.5px] leading-5 text-ink-tertiary">等待原因：{taskWaitLabel(selected.waitReason, null)}</p> : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
