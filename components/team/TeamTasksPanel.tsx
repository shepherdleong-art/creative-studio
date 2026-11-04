'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { teamError } from './client';
import { TASK_STATUS_LABELS } from '@/lib/team-task-labels';

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

const STATUS_LABELS = TASK_STATUS_LABELS;

export default function TeamTasksPanel() {
  const [items, setItems] = useState<TeamTask[]>([]);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = status ? `?status=${encodeURIComponent(status)}` : '';
      const response = await fetch(`/api/team/tasks${params}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(await teamError(response, '团队任务读取失败'));
      const body = await response.json() as { items: TeamTask[] };
      setItems(body.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '团队任务读取失败');
    } finally {
      setLoading(false);
    }
  }, [status]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  const visible = items.filter(item => [item.taskName, item.scopeName, item.inputFilename, item.taskId, item.operationId, item.actorDisplayName, item.employeeId].some(value => value?.toLowerCase().includes(search.trim().toLowerCase())));

  async function copyDetails(item: TeamTask) {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ task: item.taskName, project: item.scopeName, taskId: item.taskId, operationId: item.operationId, module: item.module, step: item.step, status: item.status, waitReason: item.waitReason, actor: item.employeeId, model: item.model, input: item.inputFilename, submissionCount: item.submissionCount, serverReleaseId: item.serverReleaseId, configVersion: item.configVersion, updatedAt: item.updatedAt }, null, 2));
      setCopied(item.operationId);
    } catch { setError('复制失败，请展开排查详情手动复制任务编号。'); }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-3xl font-semibold tracking-tight text-ink">团队任务</h1><p className="mt-2 text-sm text-ink-secondary">按项目、制作步骤和发起人定位任务。等待运行条件的任务尚未开始生成。</p></div>
        <div className="flex items-end gap-2"><label className="text-xs text-ink-secondary">状态<select className="input-field mt-1" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button className="btn-secondary btn-sm" onClick={() => void refresh()}>刷新</button></div>
      </div>
      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      <label className="block text-sm text-ink-secondary">查找任务<input className="input-field mt-2" placeholder="项目名、制作步骤、文件名、姓名、工号或任务编号" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <p className="text-xs text-ink-tertiary">显示最近 500 条记录中的 {visible.length} 条；“发送尝试”包含提交结果尚未确认的请求，不等于扣费次数。</p>
      <section className="card overflow-hidden"><div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="bg-surface-subtle text-xs text-ink-tertiary"><tr>{['制作任务', '项目 / 画布', '发起人', '状态与原因', '调用记录', '排查详情'].map(label => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-hairline">{visible.map(item => <tr key={item.operationId} className="align-top">
            <td className="max-w-64 px-4 py-4"><div className="font-medium text-ink">{item.taskName}</div><div className="mt-1 text-xs text-ink-secondary">{item.stepName}</div>{item.inputFilename && <div className="mt-2 break-all text-xs text-ink-secondary">素材：{item.inputFilename}</div>}<div className="mt-2 font-mono text-xs text-ink-tertiary">任务 {item.taskId.slice(0, 8)}</div></td>
            <td className="max-w-64 px-4 py-4 text-ink-secondary">{['project', 'canvas'].includes(item.scope.resourceType) ? <Link className="text-accent" href={item.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(item.scope.resourceId)}` : `/canvas/${encodeURIComponent(item.scope.resourceId)}`}>{item.scopeName}</Link> : item.scopeName}{item.model && <div className="mt-2 break-all text-xs text-ink-tertiary">模型：{item.model}</div>}</td>
            <td className="px-4 py-4 text-ink-secondary">{item.actorDisplayName}<div className="mt-1 text-xs text-ink-tertiary">工号 {item.employeeId}</div></td>
            <td className="max-w-64 px-4 py-4"><div className="text-ink">{STATUS_LABELS[item.status] ?? item.status}</div>{item.waitLabel && <p className="mt-2 text-xs leading-5 text-warn">{item.waitLabel}</p>}<div className="mt-2 text-xs text-ink-tertiary">{new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div></td>
            <td className="px-4 py-4 text-ink-secondary"><div>{item.submissionCount === 0 ? '尚未发送' : `发送尝试 ${item.submissionCount} 次`}</div><div className="mt-1 text-xs text-ink-tertiary">第 {item.businessAttemptNo} 轮任务</div></td>
            <td className="max-w-72 px-4 py-4"><button className="btn-secondary btn-sm" onClick={() => void copyDetails(item)}>{copied === item.operationId ? '已复制排查信息' : '复制排查信息'}</button><details className="mt-2 text-xs text-ink-secondary"><summary className="cursor-pointer">编号与版本</summary><div className="mt-2 space-y-2 break-all"><div>任务：{item.taskId}</div><div>执行记录：{item.operationId}</div><div>模块：{item.module} / {item.step}</div><div>输入版本：{item.inputRevision}</div><div>客户端：{item.clientVersion ?? '未提供'}</div><div>服务端：{item.serverReleaseId ?? '未记录'}</div><div>配置：{item.configVersion ?? '未记录'}</div></div></details>{item.errorId && <Link href={`/team/errors?errorId=${encodeURIComponent(item.errorId)}`} className="mt-2 inline-block text-xs text-accent">查看关联错误</Link>}</td>
          </tr>)}</tbody>
        </table>
        {!loading && visible.length === 0 && <p className="px-5 py-12 text-center text-sm text-ink-tertiary">当前筛选没有团队任务。</p>}
        {loading && <p className="px-5 py-12 text-center text-sm text-ink-tertiary">读取团队任务…</p>}
      </div></section>
    </div>
  );
}
