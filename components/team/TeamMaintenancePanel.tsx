'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { teamError, teamWrite } from './client';
import TeamRestorePanel, { type RestoreActivity, type RestoreJob } from './TeamRestorePanel';
import TeamCleanupPanel from './TeamCleanupPanel';
import { StatusDot, Tag } from '@/components/ui/Appearance';

export type Job = RestoreJob & {
  target: { kind: string; previewId?: string };
  stage: string; progress: number | null;
  startedAt: string | null; finishedAt: string | null;
  result?: (RestoreJob['result'] & { backupId?: string; verifiedAt?: string; totalBytes?: number;
    previewId?: string; deletedCount?: number; deletedFileCount?: number; freedBytes?: number;
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
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupError, setBackupError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activity, setActivity] = useState<RestoreActivity>({ state: 'original', activeLabel: '正在读取实际活动数据', protectedCopies: 0 });
  const idempotency = useRef<string | null>(null);
  const backupRequest = useRef<Promise<void> | null>(null);
  const jobRequest = useRef<Promise<void> | null>(null);
  const completedBackups = useRef<string | null>(null);
  const refreshBackups = useCallback((): Promise<void> => {
    if (backupRequest.current) return backupRequest.current;
    setBackupLoading(true);
    backupRequest.current = (async () => {
      try {
        const response = await fetch('/api/team/maintenance/backups', { cache: 'no-store' });
        if (!response.ok) throw new Error(await teamError(response, '无法读取备份列表'));
        setBackups((await response.json() as { backups: Backup[] }).backups);
        setBackupError('');
      } catch (cause) { setBackupError(cause instanceof Error ? cause.message : '备份列表读取失败'); }
      finally { setBackupLoading(false); backupRequest.current = null; }
    })();
    return backupRequest.current;
  }, []);
  const refreshJobs = useCallback((): Promise<void> => {
    if (jobRequest.current) return jobRequest.current;
    jobRequest.current = (async () => {
      try {
        const jobResponse = await fetch('/api/team/maintenance/jobs', { cache: 'no-store' });
        if (!jobResponse.ok) throw new Error(await teamError(jobResponse, '无法读取维护作业'));
        const jobBody = await jobResponse.json() as { jobs: Job[]; activity: RestoreActivity };
        setJobs(jobBody.jobs);
        setActivity(jobBody.activity);
        const completed = jobBody.jobs.filter(job => job.result?.backupId || job.result?.preRestoreBackupId).map(job => job.id).sort().join(',');
        if (completedBackups.current !== null && completedBackups.current !== completed) void refreshBackups();
        completedBackups.current = completed;
        if (!jobBody.jobs.some((job) => activeStatuses.has(job.status))) idempotency.current = null;
        setError('');
      } catch (cause) { setError(cause instanceof Error ? cause.message : '维护状态读取失败'); }
      finally { setLoading(false); jobRequest.current = null; }
    })();
    return jobRequest.current;
  }, [refreshBackups]);
  const refresh = useCallback(async () => { await Promise.all([refreshJobs(), refreshBackups()]); }, [refreshJobs, refreshBackups]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function pollJobs() {
      await refreshJobs();
      if (!stopped) timer = setTimeout(() => void pollJobs(), 2000);
    }
    // 完整备份校验只在打开、手动刷新或产生新备份时进行，避免反复扫描媒体。
    queueMicrotask(() => { if (!stopped) { void pollJobs(); void refreshBackups(); } });
    return () => { stopped = true; clearTimeout(timer); };
  }, [refreshJobs, refreshBackups]);
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
      await refreshJobs();
    } catch (cause) { await refreshJobs(); setError(cause instanceof Error ? cause.message : '备份提交失败，正在重连原作业'); }
    finally { setBusy(false); }
  }
  const active = jobs.some((job) => activeStatuses.has(job.status));
  const latestDaily = backups.find(backup => backup.type === 'daily' && backup.verification === 'verified');
  return <>
    <section className="card p-5" aria-label="立即备份">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div><h2 className="text-[15px] font-semibold text-ink">立即备份</h2>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-6 text-ink-secondary">备份包含项目、任务、资源配置、已登记的上传素材和生成文件，以及任务执行记录。完整性校验通过后可恢复整套业务数据；服务器程序版本由独立的版本维护流程管理。</p>
          <p className="mt-1.5 text-[13px] text-ink-secondary">备份由服务器执行，关闭此页面不会取消。下方可查看每日自动备份和手动备份，并选择还原点。</p>
        </div>
        <button className="cap cap-primary" disabled={busy || active} onClick={() => void submit()}>{busy ? '正在提交…' : active ? '备份执行中' : '立即备份'}</button>
      </div>
      {error && <p role="alert" className="mt-3 text-[13px] text-fail">{error}</p>}
      <div className="mt-4 space-y-3" aria-live="polite">
        {jobs.filter((job) => job.action === 'backup.create').slice(0, 5).map((job) => <article key={job.id} className="rounded-[11px] border border-hairline p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[13px] font-medium text-ink">{job.integrity === 'audit_corrupt' ? '待核查' : statusLabels[job.status]} · {job.stage === 'completed' && job.action === 'backup.create' ? '备份完成' : stageLabels[job.stage] ?? job.stage}</h3>
            <span className={`inline-flex items-center gap-1.5 text-[12px] ${job.status === 'succeeded' ? 'text-ok' : ['failed', 'needs_review'].includes(job.status) ? 'text-warn' : 'text-ink-secondary'}`}>{job.status === 'succeeded' ? <Tag tone="ok">已通过完整性校验</Tag> : job.progress === null ? '阶段进度，无可用百分比' : `${job.progress}%`}</span>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-ink-secondary">发起人：{job.requestedBy.displayName} · 提交：{time(job.createdAt)}</p>
          {job.error && <p className="mt-2 text-[13px] text-fail">{job.error.message}</p>}
          {job.message && <p className="mt-2 text-[13px] text-warn">{job.message}</p>}
          {job.reviewReason && <p className="mt-2 text-[13px] text-warn">{job.reviewReason}</p>}
          {job.result?.backupId && <p className="mt-2 break-all font-mono text-[12px] text-ink-tertiary">备份：{job.result.backupId}</p>}
        </article>)}
        {!loading && jobs.length === 0 && <p className="text-[13px] text-ink-secondary">尚未通过网页发起维护作业。</p>}
      </div>
    </section>
    <section className="card p-5" aria-label="备份列表">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink">备份列表</h2>
        <button className="cap" disabled={backupLoading} onClick={() => void refreshBackups()}>{backupLoading ? '正在校验备份…' : '刷新备份列表'}</button>
      </div>
      {latestDaily && <p className="mt-3 flex items-center gap-2 text-[13px] text-ok"><StatusDot tone="ok" />最近成功的每日自动备份：{time(latestDaily.createdAt)}</p>}
      <p className="mt-1.5 text-[13px] text-ink-secondary">只有重新通过数据库、配置、媒体和证据校验的完整备份才标记为可用于还原。</p>
      {backupLoading && <p role="status" className="mt-3 text-[13px] text-ink-secondary">正在读取并校验备份文件，素材较多时可能需要一些时间。</p>}
      {backupError && <p role="alert" className="mt-3 text-[13px] text-fail">{backupError}</p>}
      <div className="mt-4 overflow-x-auto"><table className="data-table min-w-[650px]">
        <thead><tr><th>类型</th><th>备份时间</th><th>大小</th><th>校验状态</th><th>可用于还原</th></tr></thead>
        <tbody>{backups.map((backup) => <tr key={`${backup.type}/${backup.id}`}>
          <td className="text-ink">{backupTypeLabels[backup.type] ?? backup.type}</td>
          <td className="text-ink-secondary">{time(backup.createdAt)}<div className="mt-1 break-all font-mono text-[11px] text-ink-tertiary">{backup.id}</div></td>
          <td className="tnum text-ink-secondary">{backup.totalBytes > 0 ? bytes(backup.totalBytes) : '—'}</td>
          <td><Tag tone={backup.verification === 'verified' ? 'ok' : 'warn'}>{backup.verification === 'verified' ? `已校验 · ${time(backup.verifiedAt)}` : '未通过，待核查'}</Tag></td>
          <td className="text-ink-secondary">{backup.restorable ? <a className="text-accent underline" href="#team-restore">可用 · 前往还原</a> : backup.verification === 'verified' && !backup.compatible ? `程序版本不匹配（${backup.releaseId}）` : '校验未通过'}</td>
        </tr>)}</tbody>
      </table></div>
      {!backupLoading && !backupError && backups.length === 0 && <p className="mt-4 text-[13px] text-ink-secondary">尚无备份记录。可先点击「立即备份」；自动备份是否启用需由服务器计划任务确认。</p>}
    </section>
    <TeamRestorePanel backups={backups} jobs={jobs} activity={activity} busy={busy} backupsLoading={backupLoading} backupsError={backupError} onRefresh={refresh} />
    <TeamCleanupPanel jobs={jobs} />
  </>;
}
