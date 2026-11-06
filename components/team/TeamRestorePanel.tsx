'use client';

import { useState } from 'react';
import { teamError, teamWrite } from './client';

export type RestoreJob = {
  id: string; action: string; status: 'queued' | 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'needs_review';
  stage: string; requestedBy: { displayName: string }; createdAt: string;
  result?: {
    preRestoreBackupId?: string; restorePoint?: string; awaitingConfirmation?: boolean;
    reconciliation?: { status: string; evidenceStatus: string; unknownAttemptIds: string[]; scheduling: boolean; automaticRetries: number };
    activity?: { state: string; recovery?: { preRestoreBackupId?: string; protectedOldRoot?: string; message?: string } };
  } | null;
  error?: { message?: string } | null; reviewReason?: string | null; message?: string;
};
export type RestoreBackup = {
  id: string; type: string; createdAt: string; restorable: boolean; compatible: boolean; releaseId: string | null;
  scope: string; newerDataPolicy: string;
};
export type RestoreActivity = {
  state: string; activeLabel: string; protectedCopies: number;
  recovery?: { preRestoreBackupId: string; path: string; message: string } | null;
};
const time = (value: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

export default function TeamRestorePanel({ backups, jobs, activity, busy, onRefresh }: {
  backups: RestoreBackup[]; jobs: RestoreJob[]; activity: RestoreActivity; busy: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [idempotency, setIdempotency] = useState<string | null>(null);
  const waiting = jobs.find((job) => job.action === 'restore.execute' && job.status === 'awaiting_confirmation');
  const active = jobs.some((job) => ['queued', 'running', 'awaiting_confirmation'].includes(job.status));
  const backup = backups.find((item) => `${item.type}/${item.id}` === selected);

  async function start() {
    if (!backup || busy || pending || !acknowledged) return;
    setPending(true); setError('');
    const key = idempotency ?? globalThis.crypto.randomUUID(); setIdempotency(key);
    try {
      const response = await teamWrite('/api/team/maintenance/restores', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: key, target: { kind: 'restore', backupType: backup.type, backupId: backup.id } }),
      });
      if (!response.ok) throw new Error(await teamError(response, '无法提交整套还原'));
      await onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败，正在重连原作业'); }
    finally { setPending(false); }
  }
  async function confirm() {
    if (!waiting || !password || pending) return;
    setPending(true); setError('');
    try {
      const response = await teamWrite(`/api/team/maintenance/restores/${waiting.id}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      if (!response.ok) throw new Error(await teamError(response, '重新认证或切换确认失败'));
      setPassword(''); await onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '确认失败，活动数据尚未切换'); }
    finally { setPending(false); }
  }
  return <section className="card p-6" aria-label="整套业务还原">
    <h2 className="text-lg font-semibold text-ink">整套业务还原</h2>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-secondary">将项目、资源、任务、文件与执行引用恢复至同一备份时间点。单项目找回请使用回收站；此操作不自动合并新旧数据，也不还原操作系统、证书、系统服务账号或部署密钥。</p>
    <div className="mt-4 rounded-xl border border-hairline bg-surface-subtle p-4 text-sm" aria-live="polite">
      <strong className="text-ink">当前实际状态：{activity.activeLabel}</strong>
      <p className="mt-1 text-ink-secondary">受保护旧数据副本：{activity.protectedCopies} 份。所有还原均先保留当前状态的已验证备份。</p>
      {activity.recovery && <p className="mt-1 text-ink-secondary">恢复路径：{activity.recovery.path}；还原前备份 {activity.recovery.preRestoreBackupId}。{activity.recovery.message}</p>}
    </div>
    <label className="mt-5 block text-sm font-medium text-ink" htmlFor="restore-backup">选择成功且与当前版本兼容的备份</label>
    <select id="restore-backup" className="input mt-2 w-full" value={selected} disabled={active || busy}
      onChange={(event) => { setSelected(event.target.value); setAcknowledged(false); setIdempotency(null); }}>
      <option value="">请选择还原点</option>
      {backups.filter((item) => item.restorable).map((item) => <option key={`${item.type}/${item.id}`} value={`${item.type}/${item.id}`}>
        {time(item.createdAt)} · {item.type} · {item.id}
      </option>)}
    </select>
    {backup && <div className="mt-3 rounded-xl border border-hairline p-4 text-sm leading-6 text-ink-secondary">
      <p>还原点：<strong className="text-ink">{time(backup.createdAt)}</strong> · 兼容版本：{backup.releaseId}</p>
      <p>业务范围：{backup.scope}</p>
      <p className="text-warn">还原点之后新增／修改的数据{backup.newerDataPolicy}。</p>
    </div>}
    <label className="mt-4 flex items-start gap-2 text-sm text-ink-secondary">
      <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={!backup || active} />
      <span>我已了解：还原不是合并，也不是无影响的单项目恢复；执行前必须先保存并验证当前状态。</span>
    </label>
    <button className="btn-secondary mt-4" disabled={!backup || !acknowledged || active || busy || pending} onClick={() => void start()}>
      {pending ? '正在提交…' : '保存当前状态并准备隔离还原'}
    </button>
    {waiting && <div className="mt-5 rounded-xl border border-warn p-4">
      <h3 className="font-medium text-ink">隔离还原已校验，等待管理员确认切换</h3>
      <p className="mt-2 text-sm text-ink-secondary">还原前备份：{waiting.result?.preRestoreBackupId}。确认后才会切换活动数据根，旧根保留为受保护副本。</p>
      {waiting.result?.reconciliation && <p className="mt-2 text-sm text-warn">核查状态：{waiting.result.reconciliation.status === 'reconciled' ? '证据已核清' : '仍须核查'}；未知受理 {waiting.result.reconciliation.unknownAttemptIds.length} 项。核查完成前保持禁调度、禁止自动重试，不恢复付费生产。</p>}
      <label className="mt-3 block text-sm text-ink" htmlFor="restore-password">输入当前管理员密码以重新认证并确认切换</label>
      <div className="mt-2 flex flex-wrap gap-3">
        <input id="restore-password" type="password" autoComplete="current-password" className="input min-w-56 flex-1" value={password} onChange={(event) => setPassword(event.target.value)} />
        <button className="btn-primary" disabled={!password || pending} onClick={() => void confirm()}>重新认证并确认切换</button>
      </div>
    </div>}
    {error && <p role="alert" className="mt-4 text-sm text-fail">{error}</p>}
    <div className="mt-5 space-y-3">
      {jobs.filter((job) => job.action === 'restore.execute').slice(0, 4).map((job) => <article key={job.id} className="rounded-xl border border-hairline p-4 text-sm">
        <h3 className="font-medium text-ink">{job.status === 'awaiting_confirmation' ? '待确认切换' : job.status === 'succeeded' ? '已切换，保持还原核查保护' : job.status === 'failed' ? '还原失败' : job.status === 'needs_review' ? '执行结果待核查' : '正在准备还原'}</h3>
        <p className="mt-1 text-xs text-ink-secondary">真实发起人：{job.requestedBy.displayName} · {time(job.createdAt)} · 作业 {job.id}</p>
        {job.error && <p className="mt-2 text-fail">{job.error.message}</p>}
        {job.result?.activity && <p className="mt-2 text-ink-secondary">活动状态：{job.result.activity.state === 'switched' ? '选定还原点' : '原业务根'}。{job.result.activity.recovery?.message}</p>}
        {job.status === 'failed' && <p className="mt-2 text-ink-secondary">未确认成功切换前，原业务数据保持不变。请依据实际活动状态、还原前备份和受保护旧根继续恢复，勿重复并行执行。</p>}
      </article>)}
    </div>
  </section>;
}
