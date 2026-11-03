'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { teamError } from './client';

type TeamTask = {
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

const STATUS_LABELS: Record<string, string> = {
  pending: '等待登记', deferred: '可恢复等待', admitted: '已受理', maybe_sent: '提交中',
  accepted: '上游已受理', reconciling: '核查中', succeeded: '成功', failed: '失败', unknown: '状态不确定',
};

export default function TeamTasksPanel() {
  const [items, setItems] = useState<TeamTask[]>([]);
  const [status, setStatus] = useState('');
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-3xl font-semibold tracking-tight text-ink">团队任务</h1><p className="mt-2 text-sm text-ink-secondary">按实际发起人查看已登记操作、业务任务、调用尝试和可恢复等待原因。本地 Agent 不计入。</p></div>
        <div className="flex items-end gap-2"><label className="text-xs text-ink-secondary">状态<select className="input-field mt-1" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(STATUS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button className="btn-secondary btn-sm" onClick={() => void refresh()}>刷新</button></div>
      </div>
      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      <section className="card overflow-hidden"><div className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-sm"><thead className="bg-surface-subtle text-xs text-ink-tertiary"><tr><th className="px-4 py-3">任务 / 模块</th><th className="px-4 py-3">实际发起人</th><th className="px-4 py-3">项目或画布</th><th className="px-4 py-3">状态 / 等待原因</th><th className="px-4 py-3">尝试</th><th className="px-4 py-3">版本</th><th className="px-4 py-3">更新时间</th></tr></thead><tbody className="divide-y divide-hairline">{items.map((item) => <tr key={item.operationId} className="align-top"><td className="px-4 py-4"><div className="font-mono text-xs text-ink">{item.taskId}</div><div className="mt-1 text-ink-secondary">{item.module} / {item.step}</div><div className="mt-1 text-xs text-ink-tertiary">输入版本 {item.inputRevision}</div>{item.errorId && <Link href={`/team/errors?errorId=${item.errorId}`} className="mt-1 inline-block text-xs text-accent">查看关联错误</Link>}</td><td className="px-4 py-4 text-ink-secondary">{item.actorDisplayName}<div className="font-mono text-xs text-ink-tertiary">{item.employeeId}</div></td><td className="px-4 py-4 text-ink-secondary"><div>{item.scope.resourceType}</div><div className="font-mono text-xs text-ink-tertiary">{item.scope.resourceId}</div></td><td className="px-4 py-4 text-ink-secondary"><div>{STATUS_LABELS[item.status] ?? item.status}</div>{item.waitReason && <div className="mt-1 text-xs text-warn">等待原因：{item.waitReason}</div>}</td><td className="px-4 py-4 text-ink-secondary">业务第 {item.businessAttemptNo} 次<div className="text-xs text-ink-tertiary">实际传输 {item.attemptCount} 次</div></td><td className="px-4 py-4 text-xs text-ink-tertiary"><div>客户端 {item.clientVersion ?? '—'}</div><div>服务端 {item.serverReleaseId ?? '—'}</div><div>配置 {item.configVersion ?? '—'}</div></td><td className="px-4 py-4 text-xs text-ink-secondary">{new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td></tr>)}</tbody></table>{!loading && items.length === 0 && <p className="px-5 py-12 text-center text-sm text-ink-tertiary">当前筛选没有团队任务。</p>}{loading && <p className="px-5 py-12 text-center text-sm text-ink-tertiary">读取团队任务…</p>}</div></section>
    </div>
  );
}
