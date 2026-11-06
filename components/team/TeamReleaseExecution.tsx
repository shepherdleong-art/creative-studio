'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { teamError, teamWrite } from './client';

type Candidate = {
  candidateId: string;
  release: { releaseId: string };
  target: { appVersion: string; dataSchemaVersion: number };
  originalName: string;
};
type Current = { appVersion: string; dataSchemaVersion: number; releaseId?: string };
type Job = {
  id: string; status: string; stage: string; createdAt: string;
  requestedBy: { displayName: string };
  action: string;
  result?: {
    actualRelease?: { releaseId: string };
    fromRelease?: { releaseId: string };
    toRelease?: { releaseId: string };
    preUpgradeBackupId?: string;
    recovery?: { reason: string; automaticRollbackAllowed: boolean };
    completedStages?: string[];
  } | null;
  error?: { message: string } | null;
  reviewReason?: string | null;
};
const stageNames: Record<string, string> = {
  queued: '等待独立维护执行器', starting: '准备升级', preflight: '复核候选和当前版本',
  maintenance: '进入维护，停止新阶段', drain: '排空在途工作并保留未知占额', capture: '保存执行与费用证据',
  stop: '受控停止已核验实例', backup: '创建并校验升级前备份', switch: '切换到不可变发布',
  start_maintenance: '在维护模式启动新版本', migrate: '执行受保护的追加迁移', self_check: '核验服务和数据健康',
  resume: '恢复生产', completed: '升级完成', failed: '升级未完成，保持维护',
};
const active = (job: Job) => ['queued', 'running'].includes(job.status);

export default function TeamReleaseExecution() {
  const [current, setCurrent] = useState<Current | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateId, setCandidateId] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const idempotency = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [previewResponse, jobsResponse] = await Promise.all([
        fetch('/api/team/release-candidates', { cache: 'no-store' }),
        fetch('/api/team/maintenance/jobs', { cache: 'no-store' }),
      ]);
      if (!previewResponse.ok) throw new Error(await teamError(previewResponse, '无法读取实际版本'));
      if (!jobsResponse.ok) throw new Error(await teamError(jobsResponse, '无法重连升级作业'));
      const preview = await previewResponse.json() as { current: Current; candidates: Candidate[] };
      setCurrent(preview.current); setCandidates(preview.candidates);
      setCandidateId((selected) => selected || preview.candidates[0]?.candidateId || '');
      const body = await jobsResponse.json() as { jobs: Job[] };
      setJobs(body.jobs.filter((job) => job.action === 'release.execute'));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接中断；请重连查看原作业，不要重新提交升级。');
    }
  }, []);
  useEffect(() => {
    queueMicrotask(() => void refresh());
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function submit() {
    const candidate = candidates.find((item) => item.candidateId === candidateId);
    if (busy || !current?.releaseId || !candidate || !acknowledged || jobs.some(active)) return;
    setBusy(true); setError('');
    idempotency.current ??= globalThis.crypto.randomUUID();
    try {
      const response = await teamWrite('/api/team/maintenance/releases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId, idempotencyKey: idempotency.current,
          confirmation: { expectedReleaseId: current.releaseId, targetAppVersion: candidate.target.appVersion, impactAcknowledged: true },
        }),
      });
      if (!response.ok) throw new Error(await teamError(response, '升级复核未通过，未启动'));
      idempotency.current = null;
      setAcknowledged(false);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : '提交连接中断'}；正在重连原作业，请勿重复提交。`);
    } finally { await refresh(); setBusy(false); }
  }
  const selected = candidates.find((item) => item.candidateId === candidateId);
  return <section className="card p-6" aria-label="确认并执行升级">
    <h2 className="text-lg font-semibold text-ink">确认并执行升级</h2>
    <p className="mt-2 text-sm leading-6 text-ink-secondary">关闭页面或客户端不会取消作业。应用短暂停止后，独立维护执行器继续同一作业；重新连接会显示服务器保存的实际阶段。</p>
    {current && <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-hairline p-4"><p className="text-xs text-ink-tertiary">当前版本</p><p className="mt-1 font-semibold text-ink">{current.appVersion}</p><p className="mt-1 break-all text-xs text-ink-secondary">{current.releaseId} · 数据结构 {current.dataSchemaVersion}</p></div>
      <div className="rounded-lg border border-hairline p-4"><p className="text-xs text-ink-tertiary">目标版本</p><p className="mt-1 font-semibold text-ink">{selected?.target.appVersion ?? '尚未选择'}</p><p className="mt-1 break-all text-xs text-ink-secondary">{selected?.release.releaseId ?? '请先在上方上传并校验'}</p></div>
    </div>}
    <label className="mt-4 block text-sm text-ink-secondary" htmlFor="upgrade-candidate">已校验的候选版本</label>
    <select id="upgrade-candidate" className="mt-2 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink" value={candidateId} disabled={jobs.some(active) || busy} onChange={(event) => { setCandidateId(event.target.value); setAcknowledged(false); }}>
      <option value="">请选择已校验候选版本</option>
      {candidates.map((candidate) => <option key={candidate.candidateId} value={candidate.candidateId}>{candidate.release.releaseId} · {candidate.target.appVersion} · {candidate.originalName}</option>)}
    </select>
    <div className="mt-4 rounded-lg border border-hairline bg-surface-subtle p-4 text-xs leading-6 text-ink-secondary">
      <p>升级影响：暂停新生产，排空并保存在途及受理不明请求的证据和占额；只停止核验归属的工作台实例；创建经验证升级前备份；执行受保护的追加迁移与维护态自检。</p>
      <p className="mt-1">数据、外部密钥和部署配置不由升级包覆盖。迁移或自检失败时保持维护；只有代码／数据兼容条件明确满足才可回退。</p>
    </div>
    <label className="mt-4 flex items-start gap-2 text-sm text-ink-secondary"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={jobs.some(active) || busy} onChange={(event) => setAcknowledged(event.target.checked)} />我已核对当前／目标版本，并确认上述停服、备份、证据保留和失败恢复影响。</label>
    <button className="btn-primary mt-4" disabled={busy || !selected || !acknowledged || jobs.some(active)} onClick={() => void submit()}>{busy ? '正在复核并提交…' : jobs.some(active) ? '升级执行中，页面重连不会取消' : jobs.some((job) => job.status === 'failed') ? '修复后复核并续跑原作业' : '确认并开始升级'}</button>
    {error && <p role="alert" className="mt-4 text-sm leading-6 text-fail">{error}</p>}
    <div className="mt-5 space-y-3" aria-live="polite">
      {jobs.slice(0, 5).map((job) => <article key={job.id} className="rounded-lg border border-hairline p-4">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-medium text-ink">{stageNames[job.stage] ?? job.stage}</h3><span className={job.status === 'succeeded' ? 'text-xs text-ok' : job.status === 'failed' ? 'text-xs text-warn' : 'text-xs text-ink-secondary'}>{job.status === 'succeeded' ? '已完成' : job.status === 'failed' ? '未完成 · 保持维护' : job.status === 'needs_review' ? '待核查' : '进行中'}</span></div>
        <p className="mt-2 text-xs text-ink-secondary">发起人：{job.requestedBy.displayName} · {new Date(job.createdAt).toLocaleString('zh-CN')}</p>
        <p className="mt-2 text-xs leading-5 text-ink-secondary">实际版本：{job.result?.actualRelease?.releaseId ?? job.result?.toRelease?.releaseId ?? job.result?.fromRelease?.releaseId ?? '等待服务端复核'}</p>
        {job.result?.preUpgradeBackupId && <p className="mt-1 break-all text-xs text-ink-secondary">升级前备份：{job.result.preUpgradeBackupId}</p>}
        {job.error && <p className="mt-2 text-sm text-fail">{job.error.message}</p>}
        {job.result?.recovery && <p className="mt-2 text-sm leading-6 text-warn">{job.result.recovery.reason}</p>}
        {job.reviewReason && <p className="mt-2 text-sm text-warn">{job.reviewReason}</p>}
        <details className="mt-3 text-xs text-ink-tertiary"><summary>作业与历史阶段</summary><p className="mt-2 break-all font-mono">{job.id}</p><p className="mt-1">{job.result?.completedStages?.map((stage) => stageNames[stage] ?? stage).join(' → ') || '尚无已完成阶段'}</p></details>
      </article>)}
    </div>
  </section>;
}
