'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { teamError, teamWrite } from './client';
import TeamRestorePanel, { type RestoreActivity, type RestoreJob } from './TeamRestorePanel';
import TeamCleanupPanel from './TeamCleanupPanel';

export type Job = RestoreJob & {
  stage: string; progress: number | null;
  startedAt: string | null; finishedAt: string | null;
  target: { kind: string; previewId?: string };
  result?: (RestoreJob['result'] & { backupId?: string; verifiedAt?: string; totalBytes?: number; previewId?: string; deletedCount?: number; deletedFileCount?: number; freedBytes?: number;
    skipped?: Array<{ id: string; label?: string; reasonCode: string; reason: string }>;
    failures?: Array<{ id: string; label?: string; reasonCode: string; reason: string; error?: string }> }) | null;
  integrity?: 'ok' | 'audit_corrupt'; message?: string;
};
type Backup = { id: string; type: string; createdAt: string; totalBytes: number; verification: string; verifiedAt: string | null; restorable: boolean;
  compatible: boolean; releaseId: string | null; scope: string; newerDataPolicy: string };
const activeStatuses = new Set(['queued', 'running']);
const stageLabels: Record<string, string> = {
  queued: '等待受控执行器领取', starting: '正在准备一致性快照', snapshotting: '正在固定数据库、配置与媒体引用',
  copying_media: '正在复制已固定媒体', verifying: '正在核验数据库与备份内容', finishing: '正在保存校验结果',
  awaiting_confirmation: '隔离还原已校验，等待确认切换', cutting_over: '正在切换受管活动数据根',
  completed: '维护完成', failed: '维护失败',
};
const statusLabels: Record<Job['status'], string> = { queued: '待执行', running: '运行中', awaiting_confirmation: '待确认', succeeded: '成功', failed: '失败', needs_review: '待核查' };
const backupTypeLabels: Record<string, string> = { daily: '每日', manual: '手动', 'pre-upgrade': '升级前', 'pre-restore': '还原前' };
const bytes = (value: number) => value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

export default function TeamMaintenancePanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activity, setActivity] = useState<RestoreActivity>({ state: 'original', activeLabel: '正在读取实际活动数据', protectedCopies: 0 });
  const idempotency = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [jobResponse, backupResponse] = await Promise.all([
        fetch('/api/team/maintenance/jobs', { cache: 'no-store' }),
        fetch('/api/team/maintenance/backups', { cache: 'no-store' }),
      ]);
      if (!jobResponse.ok) throw new Error(await teamError(jobResponse, '无法读取维护作业'));
      if (!backupResponse.ok) throw new Error(await teamError(backupResponse, '无法读取备份列表'));
      const jobBody = await jobResponse.json() as { jobs: Job[]; activity: RestoreActivity };
      setJobs(jobBody.jobs);
      setActivity(jobBody.activity);
      setBackups((await backupResponse.json() as { backups: Backup[] }).backups);
      if (!jobBody.jobs.some((job) => activeStatuses.has(job.status))) idempotency.current = null;
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '维护状态读取失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 2000);
    queueMicrotask(() => void refresh());
    return () => clearInterval(timer);
  }, [refresh]);
  async function submit() {
    if (busy) return;
    setBusy(true); setError('');
    idempotency.current ??= globalThis.crypto.randomUUID();
    try {
      const response = await teamWrite('/api/team/maintenance/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: idempotency.current, target: { kind: 'backup', backupType: 'manual' } }),
      });
      if (!response.ok) throw new Error(await teamError(response, '无法提交备份作业'));
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '备份提交失败，正在重连原作业'); await refresh(); }
    finally { setBusy(false); }
  }
  const active = jobs.some((job) => activeStatuses.has(job.status));
  return <>
    <section className="card p-6" aria-label="立即备份">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div><h2 className="text-lg font-semibold text-ink">立即备份</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">固定数据库、配置、媒体引用和执行证据，完成完整性校验后才可用于还原。由独立维护执行器完成，关闭此页面不会取消作业。</p>
        </div>
        <button className="btn-primary" disabled={busy || active} onClick={() => void submit()}>{busy ? '正在提交…' : active ? '备份执行中' : '立即备份'}</button>
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-fail">{error}</p>}
      <div className="mt-5 space-y-3" aria-live="polite">
        {jobs.filter((job) => job.action === 'backup.create').slice(0, 5).map((job) => <article key={job.id} className="rounded-xl border border-hairline p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-ink">{job.integrity === 'audit_corrupt' ? '待核查' : statusLabels[job.status]} · {job.stage === 'completed' && job.action === 'backup.create' ? '备份完成' : stageLabels[job.stage] ?? job.stage}</h3>
            <span className={`text-xs ${job.status === 'succeeded' ? 'text-ok' : ['failed', 'needs_review'].includes(job.status) ? 'text-warn' : 'text-ink-secondary'}`}>{job.status === 'succeeded' ? '已通过完整性校验' : job.progress === null ? '阶段进度，无可用百分比' : `${job.progress}%`}</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-ink-secondary">发起人：{job.requestedBy.displayName} · 提交：{time(job.createdAt)}</p>
          {job.error && <p className="mt-2 text-sm text-fail">{job.error.message}</p>}
          {job.message && <p className="mt-2 text-sm text-warn">{job.message}</p>}
          {job.reviewReason && <p className="mt-2 text-sm text-warn">{job.reviewReason}</p>}
          {job.result?.backupId && <p className="mt-2 break-all font-mono text-xs text-ink-tertiary">备份：{job.result.backupId}</p>}
        </article>)}
        {!loading && jobs.length === 0 && <p className="text-sm text-ink-secondary">尚未通过网页发起维护作业。</p>}
      </div>
    </section>
    <TeamRestorePanel backups={backups} jobs={jobs} activity={activity} busy={busy} onRefresh={refresh} />
    <TeamCleanupPanel jobs={jobs} />
    <section className="card p-6" aria-label="备份列表">
      <h2 className="text-lg font-semibold text-ink">备份列表</h2>
      <p className="mt-2 text-sm text-ink-secondary">只有重新通过数据库、配置、媒体和证据校验的完整备份才标记为可用于还原。</p>
      <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm">
        <thead><tr className="border-b border-hairline text-xs text-ink-tertiary"><th className="py-2 font-medium">类型</th><th className="py-2 font-medium">备份时间</th><th className="py-2 font-medium">大小</th><th className="py-2 font-medium">校验状态</th><th className="py-2 font-medium">可用于还原</th></tr></thead>
        <tbody>{backups.map((backup) => <tr key={`${backup.type}/${backup.id}`} className="border-b border-hairline last:border-0">
          <td className="py-3 text-ink">{backupTypeLabels[backup.type] ?? backup.type}</td>
          <td className="py-3 text-ink-secondary">{time(backup.createdAt)}<div className="mt-1 break-all font-mono text-[11px] text-ink-tertiary">{backup.id}</div></td>
          <td className="py-3 text-ink-secondary">{backup.totalBytes > 0 ? bytes(backup.totalBytes) : '—'}</td>
          <td className={`py-3 ${backup.verification === 'verified' ? 'text-ok' : 'text-warn'}`}>{backup.verification === 'verified' ? `已校验 · ${time(backup.verifiedAt)}` : '未通过，待核查'}</td>
          <td className="py-3 text-ink-secondary">{backup.restorable ? '可以' : '不可以'}</td>
        </tr>)}</tbody>
      </table></div>
      {!loading && backups.length === 0 && <p className="mt-4 text-sm text-ink-secondary">尚无备份。定时备份频率和保留规则保持不变。</p>}
    </section>
  </>;
}
