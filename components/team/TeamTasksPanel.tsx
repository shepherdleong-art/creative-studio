'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { teamError } from './client';
import {
  usePersistedActor, usePersistedCollapsedGroups, usePersistedStatus, usePersistedView,
} from './persisted-state';
import { TASK_STATUS_LABELS } from '@/lib/team-task-labels';
import { groupTeamTasksByActor } from '@/lib/team-task-groups';

type TeamTask = {
  taskName: string;
  stepName: string;
  scopeName: string;
  inputFilename: string | null;
  model: string | null;
  waitLabel: string;
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
  actorAccountStatus: 'active' | 'disabled';
  scope: { resourceType: string; resourceId: string };
  status: string;
  waitReason: string | null;
  configVersion: string | null;
  clientVersion: string | null;
  serverReleaseId: string | null;
  currentAttemptId: string | null;
  attemptCount: number;
  errorId: string | null;
  createdAt: string;
  updatedAt: string;
};

type ActorOption = {
  actorUserId: string;
  employeeId: string;
  displayName: string;
  accountStatus: 'active' | 'disabled';
  role: 'employee' | 'admin';
};

type TasksResponse = {
  items: TeamTask[];
  actors: ActorOption[];
  limit: number;
  truncated: boolean;
  totalMatching: null;
};

type ViewMode = 'grouped' | 'flat';

const STATUS_LABELS = TASK_STATUS_LABELS;

export default function TeamTasksPanel() {
  const [items, setItems] = useState<TeamTask[]>([]);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [limit, setLimit] = useState(500);
  const [truncated, setTruncated] = useState(false);
  // 视图、状态、成员与折叠状态都跨整页刷新保留（同页刷新仍显示同一结果视图）。
  const [viewValue, setViewValue] = usePersistedView();
  const [status, setStatus] = usePersistedStatus();
  const [actorUserId, setActorUserId] = usePersistedActor();
  const [storedCollapsed, setStoredCollapsed] = usePersistedCollapsedGroups();
  const view: ViewMode = viewValue === 'flat' ? 'flat' : 'grouped';
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (actorUserId) params.set('actorUserId', actorUserId);
      const response = await fetch(`/api/team/tasks?${params}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(await teamError(response, '团队任务读取失败'));
      const body = await response.json() as TasksResponse;
      setItems(body.items);
      setActors(Array.isArray(body.actors) ? body.actors : []);
      setLimit(typeof body.limit === 'number' ? body.limit : 500);
      setTruncated(Boolean(body.truncated));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '团队任务读取失败');
    } finally {
      setLoading(false);
    }
  }, [actorUserId, status]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  function toggleGroup(actorId: string) {
    setStoredCollapsed(storedCollapsed.includes(actorId)
      ? storedCollapsed.filter((item) => item !== actorId)
      : [...storedCollapsed, actorId]);
  }

  const visible = useMemo(() => items.filter(item => (
    [item.taskName, item.scopeName, item.inputFilename, item.taskId, item.operationId,
      item.actorDisplayName, item.employeeId].some(value => value?.toLowerCase().includes(search.trim().toLowerCase()))
  )), [items, search]);
  const groups = useMemo(() => groupTeamTasksByActor(visible), [visible]);
  // 筛选后已消失的组的折叠状态不参与判定，但保留在存储里，方便清空搜索后恢复。
  const collapsedSet = new Set(storedCollapsed);
  const selectedActor = actors.find((actor) => actor.actorUserId === actorUserId) ?? null;

  async function copyDetails(item: TeamTask) {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ task: item.taskName, project: item.scopeName, taskId: item.taskId, operationId: item.operationId, module: item.module, step: item.step, status: item.status, waitReason: item.waitReason, actor: item.employeeId, model: item.model, input: item.inputFilename, submissionCount: item.submissionCount, serverReleaseId: item.serverReleaseId, configVersion: item.configVersion, updatedAt: item.updatedAt }, null, 2));
      setCopied(item.operationId);
    } catch { setError('复制失败，请展开排查详情手动复制任务编号。'); }
  }

  function row(item: TeamTask) {
    return <tr key={item.operationId} className="align-top">
      <td className="max-w-64 px-4 py-4"><div className="font-medium text-ink">{item.taskName}</div><div className="mt-1 text-xs text-ink-secondary">{item.stepName}</div>{item.inputFilename && <div className="mt-2 break-all text-xs text-ink-secondary">素材：{item.inputFilename}</div>}<div className="mt-2 font-mono text-xs text-ink-tertiary">任务 {item.taskId.slice(0, 8)}</div></td>
      <td className="max-w-64 px-4 py-4 text-ink-secondary">{['project', 'canvas'].includes(item.scope.resourceType) ? <Link className="text-accent" href={item.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(item.scope.resourceId)}` : `/canvas/${encodeURIComponent(item.scope.resourceId)}`}>{item.scopeName}</Link> : item.scopeName}{item.model && <div className="mt-2 break-all text-xs text-ink-tertiary">模型：{item.model}</div>}</td>
      <td className="px-4 py-4 text-ink-secondary">{item.actorDisplayName}<div className="mt-1 text-xs text-ink-tertiary">工号 {item.employeeId}</div>{item.actorAccountStatus === 'disabled' && <div className="mt-1 text-xs text-warn">账号已停用</div>}</td>
      <td className="max-w-64 px-4 py-4"><div className="text-ink">{STATUS_LABELS[item.status] ?? item.status}</div>{item.waitLabel && <p className="mt-2 text-xs leading-5 text-warn">{item.waitLabel}</p>}<div className="mt-2 text-xs text-ink-tertiary">{new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div></td>
      <td className="px-4 py-4 text-ink-secondary"><div>{item.submissionCount === 0 ? '尚未发送' : `发送尝试 ${item.submissionCount} 次`}</div><div className="mt-1 text-xs text-ink-tertiary">第 {item.businessAttemptNo} 轮任务</div></td>
      <td className="max-w-72 px-4 py-4"><button className="btn-secondary btn-sm" onClick={() => void copyDetails(item)}>{copied === item.operationId ? '已复制排查信息' : '复制排查信息'}</button><details className="mt-2 text-xs text-ink-secondary"><summary className="cursor-pointer">编号与版本</summary><div className="mt-2 space-y-2 break-all"><div>任务：{item.taskId}</div><div>执行记录：{item.operationId}</div><div>模块：{item.module} / {item.step}</div><div>输入版本：{item.inputRevision}</div><div>客户端：{item.clientVersion ?? '未提供'}</div><div>服务端：{item.serverReleaseId ?? '未记录'}</div><div>配置：{item.configVersion ?? '未记录'}</div></div></details>{item.errorId && <Link href={`/team/errors?errorId=${encodeURIComponent(item.errorId)}`} className="mt-2 inline-block text-xs text-accent">查看关联错误</Link>}</td>
    </tr>;
  }

  const headers = ['制作任务', '项目 / 画布', '发起人', '状态与原因', '调用记录', '排查详情'];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-3xl font-semibold tracking-tight text-ink">团队任务</h1><p className="mt-2 text-sm text-ink-secondary">按项目、制作步骤和发起人定位任务。等待运行条件的任务尚未开始生成。</p></div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-secondary">成员<select aria-label="成员" className="input-field mt-1" value={actorUserId} onChange={(event) => setActorUserId(event.target.value)}><option value="">全部成员</option>{actors.map((actor) => <option key={actor.actorUserId} value={actor.actorUserId}>{actor.displayName}（工号 {actor.employeeId}）{actor.accountStatus === 'disabled' ? ' · 已停用' : ''}</option>)}</select></label>
          <label className="text-xs text-ink-secondary">状态<select aria-label="状态" className="input-field mt-1" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button className="btn-secondary btn-sm" onClick={() => void refresh()}>刷新</button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="segmented" role="group" aria-label="任务视图">
          <button type="button" aria-pressed={view === 'grouped'} onClick={() => setViewValue('grouped')}>按发起人分组</button>
          <button type="button" aria-pressed={view === 'flat'} onClick={() => setViewValue('flat')}>平铺</button>
        </div>
        <p className="text-xs text-ink-tertiary" data-testid="task-result-summary">
          {selectedActor
            ? `显示 ${selectedActor.displayName}（工号 ${selectedActor.employeeId}）当前结果 ${visible.length} 条`
            : `显示当前结果 ${visible.length} 条`}
          。按最近更新时间降序，最多返回最近 {limit} 条记录{truncated ? '（已到上限，更早的记录未显示）' : ''}。
          {view === 'grouped' && '组内数字是当前结果条数，不是该成员全部历史任务数。'}
          “发送尝试”包含提交结果尚未确认的请求，不等于扣费次数。
        </p>
      </div>
      <label className="block text-sm text-ink-secondary">查找任务<input className="input-field mt-2" placeholder="项目名、制作步骤、文件名、姓名、工号或任务编号" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <section className="card overflow-hidden">
        {view === 'grouped' ? (
          <div className="divide-y divide-hairline">
            {groups.map((group) => {
              const isCollapsed = collapsedSet.has(group.actorUserId);
              return <div key={group.actorUserId} data-testid="task-actor-group" data-actor-user-id={group.actorUserId}>
                <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-subtle px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn-secondary btn-sm" aria-expanded={!isCollapsed} onClick={() => toggleGroup(group.actorUserId)}>
                      {isCollapsed ? '展开' : '折叠'}该发起人
                    </button>
                    <span className="font-medium text-ink">{group.displayName}</span>
                    <span className="text-xs text-ink-tertiary">工号 {group.employeeId}</span>
                    {selectedActor?.actorUserId === group.actorUserId && selectedActor.accountStatus === 'disabled' && <span className="text-xs text-warn">账号已停用</span>}
                    <span className="text-xs text-ink-secondary">当前结果 {group.count} 条</span>
                  </div>
                  <span className="text-xs text-ink-tertiary">最近更新 {new Date(group.latestUpdatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span>
                </div>
                {!isCollapsed && <div className="overflow-x-auto">
                  <table className="w-full min-w-[960px] text-left text-sm">
                    <thead className="text-xs text-ink-tertiary"><tr>{headers.map(label => <th key={label} className="px-4 py-2">{label}</th>)}</tr></thead>
                    <tbody className="divide-y divide-hairline">{group.items.map(row)}</tbody>
                  </table>
                </div>}
              </div>;
            })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="bg-surface-subtle text-xs text-ink-tertiary"><tr>{headers.map(label => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead>
              <tbody className="divide-y divide-hairline">{visible.map(row)}</tbody>
            </table>
          </div>
        )}
        {!loading && visible.length === 0 && <p className="px-5 py-12 text-center text-sm text-ink-tertiary">当前筛选没有团队任务。</p>}
        {loading && <p className="px-5 py-12 text-center text-sm text-ink-tertiary">读取团队任务…</p>}
        {!loading && visible.length > 0 && !actors.some((actor) => actor.actorUserId === actorUserId) && actorUserId && (
          <p className="px-5 py-4 text-center text-xs text-warn">所选成员已不在成员列表中，任务结果仍按该成员 ID 显示。</p>
        )}
      </section>
    </div>
  );
}
