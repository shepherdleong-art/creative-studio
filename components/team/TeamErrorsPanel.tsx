'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { teamError, teamWrite } from './client';

type ErrorItem = {
  errorId: string;
  actorUserId: string;
  employeeId?: string;
  actorDisplayName?: string;
  module: string;
  taskId: string | null;
  operationId: string | null;
  attemptId: string | null;
  transferId: string | null;
  phase: string | null;
  scope: { resourceType: string; resourceId: string } | null;
  stage: string;
  code: string;
  statusCode: number | null;
  safeMessage: string;
  clientVersion: string | null;
  serverReleaseId: string | null;
  configVersion: string | null;
  createdAt: string;
};

const STAGE_LABELS: Record<string, string> = {
  upload: '上传', remote_submit: '上游提交', remote_poll: '上游查询', download: '下载',
  local_media: '本地媒体', client_update: '客户端更新', client_ui: '客户端界面', server_release: '服务端发布', server_config: '服务端配置',
};

export default function TeamErrorsPanel() {
  const searchParams = useSearchParams();
  const [items, setItems] = useState<ErrorItem[]>([]);
  const [errorId, setErrorId] = useState(() => searchParams.get('errorId') ?? '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stage, setStage] = useState('upload');
  const [code, setCode] = useState('');
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const params = errorId.trim() ? `?errorId=${encodeURIComponent(errorId.trim())}` : '';
      const response = await fetch(`/api/team/errors${params}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(await teamError(response, '错误中心读取失败'));
      const body = await response.json() as { items: ErrorItem[] };
      setItems(body.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '错误中心读取失败');
    }
  }, [errorId]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  async function report(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await teamWrite('/api/team/errors/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientEventId: crypto.randomUUID(), stage, code: code.trim(), taskId: taskId.trim() || undefined,
        }),
      });
      if (!response.ok) throw new Error(await teamError(response, '错误上报失败'));
      const body = await response.json() as ErrorItem;
      setNotice(`已生成错误编号 ${body.errorId}，可下载脱敏诊断包提供给管理员。`);
      setCode('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '错误上报失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div><h1 className="text-3xl font-semibold tracking-tight text-ink">错误中心</h1><p className="mt-2 text-sm text-ink-secondary">用错误编号关联实际人员、项目或画布、任务、阶段和版本。界面、传输与更新失败会自动生成记录；断网事件脱敏暂存并在原账号恢复连接后补报。员工只看本人，管理员可按编号查全量。</p></div>
      <section className="card p-5"><form onSubmit={report} className="grid gap-3 md:grid-cols-[160px_1fr_1fr_auto] md:items-end"><label className="text-xs text-ink-secondary">阶段<select className="input-field mt-1" value={stage} onChange={(event) => setStage(event.target.value)}><option value="upload">上传</option><option value="download">下载</option><option value="client_update">客户端更新</option><option value="local_media">本地媒体</option></select></label><label className="text-xs text-ink-secondary">安全错误码<input className="input-field mt-1" value={code} onChange={(event) => setCode(event.target.value)} pattern="[A-Za-z][A-Za-z0-9_.\-]*" maxLength={80} placeholder="例如 bad_signature" required /></label><label className="text-xs text-ink-secondary">关联任务（可选）<input className="input-field mt-1" value={taskId} onChange={(event) => setTaskId(event.target.value)} placeholder="服务端会重新核验归属" /></label><button className="btn-primary" disabled={busy} type="submit">上报并生成编号</button></form><p className="mt-3 text-xs text-ink-tertiary">无需提交素材原文、请求正文、密钥或 URL；通知只在当前客户端内展示。</p></section>
      <section className="card p-4"><form onSubmit={(event) => { event.preventDefault(); void refresh(); }} className="flex flex-wrap items-end gap-2"><label className="text-xs text-ink-secondary">按错误编号查找<input className="input-field mt-1 w-80" value={errorId} onChange={(event) => setErrorId(event.target.value)} placeholder="输入完整错误编号" /></label><button className="btn-secondary btn-sm" type="submit">查找</button><button className="btn-secondary btn-sm" type="button" onClick={() => setErrorId('')}>清除筛选</button></form></section>
      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      {notice && <p role="status" className="card border-ok p-4 text-sm text-ok">{notice}</p>}
      <section className="space-y-3">{items.map((item) => <article key={item.errorId} className="card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{STAGE_LABELS[item.stage] ?? item.stage}</span><code className="rounded bg-surface-subtle px-2 py-1 text-xs text-ink-secondary">{item.code}</code></div><p className="mt-2 text-sm text-ink-secondary">{item.safeMessage}</p><p className="mt-2 font-mono text-xs text-ink-tertiary">{item.errorId}</p></div><a className="btn-secondary btn-sm" href={`/api/team/errors/${item.errorId}/diagnostics`}>下载诊断包</a></div><dl className="mt-4 grid gap-x-5 gap-y-2 text-xs text-ink-secondary sm:grid-cols-2 lg:grid-cols-3"><div><dt className="inline text-ink-tertiary">成员：</dt><dd className="inline">{item.actorDisplayName ?? item.actorUserId}{item.employeeId ? `（${item.employeeId}）` : ''}</dd></div><div><dt className="inline text-ink-tertiary">模块：</dt><dd className="inline">{item.module}</dd></div><div><dt className="inline text-ink-tertiary">任务：</dt><dd className="inline font-mono">{item.taskId ?? '—'}</dd></div><div><dt className="inline text-ink-tertiary">项目 / 画布：</dt><dd className="inline font-mono">{item.scope ? `${item.scope.resourceType}/${item.scope.resourceId}` : '—'}</dd></div><div><dt className="inline text-ink-tertiary">客户端：</dt><dd className="inline">{item.clientVersion ?? '—'}</dd></div><div><dt className="inline text-ink-tertiary">服务端：</dt><dd className="inline">{item.serverReleaseId ?? '—'}</dd></div><div><dt className="inline text-ink-tertiary">配置：</dt><dd className="inline">{item.configVersion ?? '—'}</dd></div><div><dt className="inline text-ink-tertiary">状态码：</dt><dd className="inline">{item.statusCode ?? '—'}</dd></div><div><dt className="inline text-ink-tertiary">失败阶段：</dt><dd className="inline">{item.phase ?? '—'}</dd></div><div><dt className="inline text-ink-tertiary">传输：</dt><dd className="inline font-mono">{item.transferId ?? '—'}</dd></div><div><dt className="inline text-ink-tertiary">时间：</dt><dd className="inline">{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</dd></div></dl></article>)}{items.length === 0 && <div className="card px-5 py-12 text-center text-sm text-ink-tertiary">没有符合条件的错误记录。</div>}</section>
    </div>
  );
}
