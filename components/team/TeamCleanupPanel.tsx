'use client';

import { useRef, useState } from 'react';
import { teamError, teamWrite } from './client';
import type { Job } from './TeamMaintenancePanel';

type ProtectedItem = { id: string; label?: string; reasonCode: string; reason: string };
type Category = { kind: string; label: string; cleanableCount: number; estimatedBytes: number; protected: ProtectedItem[] };
type Preview = {
  id: string; createdAt: string; estimateNote: string;
  totals: { cleanableCount: number; estimatedBytes: number }; categories: Category[];
  protectedSummary: Array<{ kind: string; reason: string }>;
};
type CleanupJob = Job;
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const statusText: Record<string, string> = { queued: '等待受控执行器', running: '正在重新核验并清理', succeeded: '已完成', failed: '执行失败', needs_review: '结果待核查' };

export default function TeamCleanupPanel({ jobs }: { jobs: CleanupJob[] }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const idempotency = useRef<string | null>(null);
  const latestCleanup = jobs.find((job) => job.action === 'cleanup.execute');
  async function scan() {
    if (busy) return;
    setBusy(true); setError(''); idempotency.current = null;
    try {
      const response = await teamWrite('/api/team/maintenance/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error(await teamError(response, '扫描失败'));
      setPreview((await response.json() as { preview: Preview }).preview);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '扫描失败'); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview || busy) return;
    setBusy(true); setError(''); idempotency.current ??= globalThis.crypto.randomUUID();
    try {
      const response = await teamWrite('/api/team/maintenance/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: idempotency.current, confirm: true, target: { kind: 'cleanup', previewId: preview.id } }),
      });
      if (!response.ok) throw new Error(await teamError(response, '无法提交清理作业'));
      setConfirming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '清理提交失败'); }
    finally { setBusy(false); }
  }
  return <section className="card p-6" aria-label="无用文件清理">
    <div className="flex flex-wrap items-start justify-between gap-5">
      <div><h2 className="text-lg font-semibold text-ink">无用文件清理</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">只扫描失败任务临时文件、待删过期缓存和回收站无引用产物。不能接受任意文件路径；正常素材、成片、历史版本、备份、账本、执行证据和诊断审计均不在范围内。</p>
      </div>
      <button className="btn-secondary" disabled={busy} onClick={() => void scan()}>{busy ? '正在处理…' : preview ? '重新扫描' : '扫描无用文件'}</button>
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-fail">{error}</p>}
    {preview && <div className="mt-5">
      <p className="text-xs text-ink-tertiary">预览时间：{time(preview.createdAt)} · {preview.estimateNote}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">{preview.categories.map((category) => <article key={category.kind} className="rounded-xl border border-hairline p-4">
        <h3 className="text-sm font-medium text-ink">{category.label}</h3>
        <p className="mt-2 text-sm text-ink-secondary">可清理 {category.cleanableCount} 项 · 预计释放 {bytes(category.estimatedBytes)}</p>
        {category.protected.length > 0 && <details className="mt-3 text-xs text-ink-secondary"><summary>不可清理原因（{category.protected.length}）</summary>
          <ul className="mt-2 space-y-2">{category.protected.map((item, index) => <li key={`${item.id}-${index}`} className="leading-5">{item.reason}</li>)}</ul>
        </details>}
      </article>)}</div>
      <p className="mt-4 text-sm font-medium text-ink">合计：{preview.totals.cleanableCount} 项，预计释放 {bytes(preview.totals.estimatedBytes)}</p>
      <ul className="mt-3 space-y-1 text-xs leading-5 text-ink-tertiary">{preview.protectedSummary.map((item) => <li key={item.kind}>{item.reason}</li>)}</ul>
      <button className="btn-primary mt-4" disabled={busy || preview.totals.cleanableCount === 0 || latestCleanup?.target.previewId === preview.id && ['queued', 'running'].includes(latestCleanup.status)} onClick={() => setConfirming(true)}>确认清理预览中的项目</button>
    </div>}
    {latestCleanup && <article className="mt-5 rounded-xl border border-hairline p-4" aria-label="清理执行结果" aria-live="polite">
      <h3 className="text-sm font-medium text-ink">清理执行结果 · {statusText[latestCleanup.status] ?? latestCleanup.status}</h3>
      <p className="mt-2 text-xs text-ink-secondary">发起人：{latestCleanup.requestedBy.displayName} · 作业：{latestCleanup.id}</p>
      {latestCleanup.result && <>
        <p className="mt-3 text-sm text-ink">实际删除 {latestCleanup.result.deletedFileCount ?? latestCleanup.result.deletedCount ?? 0} 个文件 · 实际释放 {bytes(latestCleanup.result.freedBytes ?? 0)} · 跳过 {latestCleanup.result.skipped?.length ?? 0} 项 · 失败 {latestCleanup.result.failures?.length ?? 0} 项</p>
        {latestCleanup.result.skipped?.map((item, index) => <p key={`skip-${index}`} className="mt-2 text-xs text-warn">跳过：{item.reason}</p>)}
        {latestCleanup.result.failures?.map((item, index) => <p key={`failure-${index}`} className="mt-2 text-xs text-fail">失败：{item.reason}{item.error ? `（${item.error}）` : ''}</p>)}
      </>}
      {latestCleanup.error && <p className="mt-2 text-sm text-fail">{latestCleanup.error.message}</p>}
      {latestCleanup.reviewReason && <p className="mt-2 text-sm text-warn">{latestCleanup.reviewReason}</p>}
    </article>}
    {confirming && preview && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="cleanup-confirm-title">
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl">
        <h3 id="cleanup-confirm-title" className="text-lg font-semibold text-ink">确认永久清理？</h3>
        <p className="mt-3 text-sm leading-6 text-ink-secondary">将按 {time(preview.createdAt)} 的预览提交 {preview.totals.cleanableCount} 项，预计释放 {bytes(preview.totals.estimatedBytes)}。受控执行器会在删除前重新核验，新增引用或在途任务将被跳过。此操作不可撤销。</p>
        <div className="mt-5 flex justify-end gap-3"><button className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>取消</button><button className="btn-primary" disabled={busy} onClick={() => void confirm()}>{busy ? '正在提交…' : '确认永久清理'}</button></div>
      </div>
    </div>}
  </section>;
}
