'use client';

import { useRef, useState } from 'react';
import { teamError, teamWrite } from './client';
import { Dialog } from '@/components/ui/Dialog';
import { StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';
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
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'fail' | 'run' | 'idle'> = {
  queued: 'idle', running: 'run', succeeded: 'ok', failed: 'fail', needs_review: 'warn',
};

/**
 * 无用文件清理（团队版）。14 号票只换外观：确认框换成共用 Dialog，区块与
 * 状态换成共用部件；扫描范围、接口与提交逻辑不变。
 */
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
  return <section className="card p-5" aria-label="无用文件清理">
    <div className="flex flex-wrap items-start justify-between gap-5">
      <div><h2 className="text-[15px] font-semibold text-ink">无用文件清理</h2>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-6 text-ink-secondary">只扫描失败任务临时文件、待删过期缓存和回收站无引用产物。不能接受任意文件路径；正常素材、成片、历史版本、备份、账本、执行证据和诊断审计均不在范围内。</p>
      </div>
      <ToolbarButton onClick={() => void scan()} disabled={busy}>{busy ? '正在处理…' : preview ? '重新扫描' : '扫描无用文件'}</ToolbarButton>
    </div>
    {error && <p role="alert" className="mt-3 text-[13px] text-fail">{error}</p>}
    {preview && <div className="mt-4">
      <p className="tnum text-[12px] text-ink-tertiary">预览时间：{time(preview.createdAt)} · {preview.estimateNote}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">{preview.categories.map((category) => <article key={category.kind} className="rounded-[11px] border border-hairline p-4">
        <h3 className="text-[13px] font-semibold text-ink">{category.label}</h3>
        <p className="mt-1.5 text-[13px] text-ink-secondary">可清理 {category.cleanableCount} 项 · 预计释放 {bytes(category.estimatedBytes)}</p>
        {category.protected.length > 0 && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">不可清理原因（{category.protected.length}）</summary>
          <ul className="mt-2 space-y-2">{category.protected.map((item, index) => <li key={`${item.id}-${index}`} className="leading-5">{item.reason}</li>)}</ul>
        </details>}
      </article>)}</div>
      <p className="tnum mt-3 text-[13px] font-medium text-ink">合计：{preview.totals.cleanableCount} 项，预计释放 {bytes(preview.totals.estimatedBytes)}</p>
      <ul className="mt-2 space-y-1 text-[12px] leading-5 text-ink-tertiary">{preview.protectedSummary.map((item) => <li key={item.kind}>{item.reason}</li>)}</ul>
      <ToolbarButton variant="primary" onClick={() => setConfirming(true)} disabled={busy || preview.totals.cleanableCount === 0 || latestCleanup?.target.previewId === preview.id && ['queued', 'running'].includes(latestCleanup.status)}>确认清理预览中的项目</ToolbarButton>
    </div>}
    {latestCleanup && <article className="mt-4 rounded-[11px] border border-hairline p-4" aria-label="清理执行结果" aria-live="polite">
      <h3 className="flex items-center gap-2 text-[13px] font-medium text-ink"><StatusDot tone={STATUS_TONE[latestCleanup.status] ?? 'idle'} />清理执行结果 · {statusText[latestCleanup.status] ?? latestCleanup.status}</h3>
      <p className="mt-2 text-[12px] text-ink-secondary">发起人：{latestCleanup.requestedBy.displayName} · 作业：{latestCleanup.id}</p>
      {latestCleanup.result && <>
        <p className="tnum mt-2 text-[13px] text-ink">实际删除 {latestCleanup.result.deletedFileCount ?? latestCleanup.result.deletedCount ?? 0} 个文件 · 实际释放 {bytes(latestCleanup.result.freedBytes ?? 0)} · 跳过 {latestCleanup.result.skipped?.length ?? 0} 项 · 失败 {latestCleanup.result.failures?.length ?? 0} 项</p>
        {latestCleanup.result.skipped?.map((item, index) => <p key={`skip-${index}`} className="mt-1.5 text-[12px] text-warn">跳过：{item.reason}</p>)}
        {latestCleanup.result.failures?.map((item, index) => <p key={`failure-${index}`} className="mt-1.5 text-[12px] text-fail">失败：{item.reason}{item.error ? `（${item.error}）` : ''}</p>)}
      </>}
      {latestCleanup.error && <p className="mt-2 text-[13px] text-fail">{latestCleanup.error.message}</p>}
      {latestCleanup.reviewReason && <p className="mt-2 text-[13px] text-warn">{latestCleanup.reviewReason}</p>}
    </article>}
    <Dialog
      open={confirming && Boolean(preview)}
      title="确认永久清理？"
      description={preview ? `将按 ${time(preview.createdAt)} 的预览提交 ${preview.totals.cleanableCount} 项，预计释放 ${bytes(preview.totals.estimatedBytes)}。` : undefined}
      onClose={() => { if (!busy) setConfirming(false); }}
      footer={
        <>
          <span className="mr-auto flex items-center gap-1.5 text-[12px] text-ink-secondary"><Tag tone="fail">不可撤销</Tag>受控执行器会在删除前重新核验。</span>
          <ToolbarButton onClick={() => setConfirming(false)} disabled={busy}>取消</ToolbarButton>
          <ToolbarButton variant="primary" onClick={() => void confirm()} disabled={busy}>{busy ? '正在提交…' : '确认永久清理'}</ToolbarButton>
        </>
      }
    >
      <p className="text-[13px] leading-6 text-ink-secondary">受控执行器会在删除前重新核验，新增引用或在途任务将被跳过。此操作不可撤销。</p>
    </Dialog>
  </section>;
}
