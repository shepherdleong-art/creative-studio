'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { teamError } from './client';
import { TASK_STATUS_LABELS } from '@/lib/team-task-labels';
import TeamTaskModel, { type TeamTaskModelCall } from './TeamTaskModel';

type TeamTask = {
  taskName: string;
  stepName: string;
  scopeName: string;
  inputFilename: string | null;
  model: string | null;
  providerName: string;
  modelStatus: string;
  modelCalls: TeamTaskModelCall[];
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
type Member = { id: string; employeeId: string; displayName: string };

function TaskTable({ items, copied, onCopy }: { items: TeamTask[]; copied: string; onCopy: (item: TeamTask) => void }) {
  return <table className="w-full min-w-[1100px] text-left text-sm">
    <thead className="bg-surface-subtle text-xs text-ink-tertiary"><tr>{['制作任务与步骤', '项目 / 画布', '发起人', '状态与原因', '本次供应商与实际模型', '发送记录', '排查详情'].map(label => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead>
    <tbody className="divide-y divide-hairline">{items.map(item => <tr key={item.operationId} className="align-top">
      <td className="max-w-56 px-4 py-4"><div className="font-medium text-ink">{item.taskName}</div><div className="mt-1 text-xs text-ink-secondary">{item.stepName}</div>{item.inputFilename && <div className="mt-2 break-all text-xs text-ink-secondary">素材：{item.inputFilename}</div>}</td>
      <td className="max-w-56 px-4 py-4 text-ink-secondary">{['project', 'canvas'].includes(item.scope.resourceType) ? <Link className="text-accent" href={item.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(item.scope.resourceId)}` : `/canvas/${encodeURIComponent(item.scope.resourceId)}`}>{item.scopeName}</Link> : item.scopeName}</td>
      <td className="px-4 py-4 text-ink-secondary">{item.actorDisplayName}<div className="mt-1 text-xs text-ink-tertiary">工号 {item.employeeId}</div></td>
      <td className="max-w-48 px-4 py-4"><div className="text-ink">{TASK_STATUS_LABELS[item.status] ?? item.status}</div>{item.waitLabel && <p className="mt-2 text-xs leading-5 text-warn">{item.waitLabel}</p>}<div className="mt-2 text-xs text-ink-tertiary">{new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div></td>
      <td className="max-w-72 px-4 py-4"><TeamTaskModel providerName={item.providerName} model={item.model} modelStatus={item.modelStatus} calls={item.modelCalls} /></td>
      <td className="px-4 py-4 text-ink-secondary"><div>{item.submissionCount === 0 ? '尚未发送' : `发送尝试 ${item.submissionCount} 次`}</div><div className="mt-1 text-xs text-ink-tertiary">第 {item.businessAttemptNo} 轮任务</div><div className="mt-1 text-xs text-ink-tertiary">执行尝试 {item.attemptCount} 条，不等于制作份数</div></td>
      <td className="max-w-72 px-4 py-4"><button className="btn-secondary btn-sm" onClick={() => onCopy(item)}>{copied === item.operationId ? '已复制排查信息' : '复制排查信息'}</button><details className="mt-2 text-xs text-ink-secondary"><summary className="cursor-pointer">编号与版本</summary><div className="mt-2 space-y-2 break-all"><div>任务：{item.taskId}</div><div>执行记录：{item.operationId}</div><div>模块：{item.module} / {item.step}</div><div>输入版本：{item.inputRevision}</div><div>客户端：{item.clientVersion ?? '未提供'}</div><div>服务端：{item.serverReleaseId ?? '未记录'}</div><div>配置：{item.configVersion ?? '未记录'}</div></div></details>{item.errorId && <Link href={`/team/errors?errorId=${encodeURIComponent(item.errorId)}`} className="mt-2 inline-block text-xs text-accent">查看关联错误</Link>}</td>
    </tr>)}</tbody>
  </table>;
}

export default function TeamTasksPanel() {
  const [items, setItems] = useState<TeamTask[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [status, setStatus] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
      const body = await response.json() as { items: TeamTask[] };
      setItems(body.items);
      if (!actorUserId) {
        const seen = new Map<string, Member>();
        for (const item of body.items) seen.set(item.actorUserId, { id: item.actorUserId, employeeId: item.employeeId, displayName: item.actorDisplayName });
        setMembers([...seen.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId)));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '团队任务读取失败');
    } finally {
      setLoading(false);
    }
  }, [status, actorUserId]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);
  useEffect(() => {
    void fetch('/api/team/users', { credentials: 'same-origin', cache: 'no-store' }).then(async response => {
      if (!response.ok) return; // Employees only receive their own task query.
      const body = await response.json() as { users: Member[] };
      setMembers(body.users);
    }).catch(() => undefined);
  }, []);

  const visible = items.filter(item => [item.taskName, item.stepName, item.scopeName, item.inputFilename, item.taskId, item.operationId, item.actorDisplayName, item.employeeId, item.model, item.providerName].some(value => value?.toLowerCase().includes(search.trim().toLowerCase())));
  const groups = new Map<string, TeamTask[]>();
  for (const item of visible) groups.set(item.actorUserId, [...(groups.get(item.actorUserId) ?? []), item]);

  async function copyDetails(item: TeamTask) {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ task: item.taskName, step: item.stepName, rawStep: item.step, project: item.scopeName, taskId: item.taskId, operationId: item.operationId, module: item.module, status: item.status, waitReason: item.waitReason, actor: item.employeeId, providerName: item.providerName, model: item.model, modelCalls: item.modelCalls, input: item.inputFilename, inputRevision: item.inputRevision, submissionCount: item.submissionCount, attemptCount: item.attemptCount, businessAttemptNo: item.businessAttemptNo, clientVersion: item.clientVersion, serverReleaseId: item.serverReleaseId, configVersion: item.configVersion, updatedAt: item.updatedAt }, null, 2));
      setCopied(item.operationId);
    } catch { setError('复制失败，请展开排查详情手动复制任务编号。'); }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-3xl font-semibold tracking-tight text-ink">团队任务</h1><p className="mt-2 text-sm text-ink-secondary">按项目、制作步骤和发起人定位任务。实际模型来自执行快照；等待中的配置不标为已调用。</p></div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-secondary">发起人<select aria-label="发起人" className="input-field mt-1" value={actorUserId} onChange={event => setActorUserId(event.target.value)}><option value="">全部成员</option>{members.map(member => <option value={member.id} key={member.id}>{member.displayName}（{member.employeeId}）</option>)}</select></label>
          <label className="text-xs text-ink-secondary">状态<select className="input-field mt-1" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(TASK_STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button className="btn-secondary btn-sm" onClick={() => setGrouped(value => !value)}>{grouped ? '平铺' : '按发起人分组'}</button><button className="btn-secondary btn-sm" onClick={() => void refresh()}>刷新</button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      <label className="block text-sm text-ink-secondary">查找任务<input className="input-field mt-2" placeholder="项目名、中文步骤、模型、姓名、工号或任务编号" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <p className="text-xs text-ink-tertiary">当前结果 {visible.length} 条（服务端最多返回最近 500 条，不是全历史总数）；搜索只作用于当前结果。发送尝试包含结果未确认的请求，不等于扣费次数。</p>
      {!loading && visible.length === 0 && <p className="card px-5 py-12 text-center text-sm text-ink-tertiary">当前筛选没有团队任务。</p>}
      {loading && <p className="card px-5 py-12 text-center text-sm text-ink-tertiary">读取团队任务…</p>}
      {visible.length > 0 && (grouped ? <div className="space-y-4">{[...groups.entries()].map(([memberId, groupItems]) => {
        const member = groupItems[0];
        const isCollapsed = collapsed.has(memberId);
        return <section key={memberId} aria-label={`${member.actorDisplayName}（${member.employeeId}）的任务`} className="card overflow-hidden">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3"><div><h2 className="font-medium text-ink">{member.actorDisplayName}<span className="ml-2 text-xs font-normal text-ink-tertiary">工号 {member.employeeId}</span></h2><p className="mt-1 text-xs text-ink-tertiary">当前结果 {groupItems.length} 条，不是该成员全历史总数</p></div><button className="btn-secondary btn-sm" aria-expanded={!isCollapsed} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(memberId)) next.delete(memberId); else next.add(memberId); return next; })}>{isCollapsed ? '展开' : '折叠'}</button></header>
          {!isCollapsed && <div className="overflow-x-auto"><TaskTable items={groupItems} copied={copied} onCopy={item => void copyDetails(item)} /></div>}
        </section>;
      })}</div> : <section className="card overflow-hidden"><div className="overflow-x-auto"><TaskTable items={visible} copied={copied} onCopy={item => void copyDetails(item)} /></div></section>)}
    </div>
  );
}
