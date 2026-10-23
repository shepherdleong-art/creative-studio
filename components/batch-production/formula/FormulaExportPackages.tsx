'use client';

import { useEffect, useRef, useState } from 'react';
import type { BatchWorkspaceView } from '@/lib/batch-production/batch-workspace';
import type { FormulaPackageSummary } from '@/lib/batch-production/formula/export-package';

export default function FormulaExportPackages({ projectId, batchId, workspace, selectedPlanIds }: {
  projectId: string; batchId: string; workspace: BatchWorkspaceView; selectedPlanIds: string[];
}) {
  const [packages, setPackages] = useState<FormulaPackageSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const pending = useRef(false);
  const attempt = useRef<{ selection: string; requestKey: string } | null>(null);
  const endpoint = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/packages`;
  const query = `projectId=${encodeURIComponent(projectId)}`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${endpoint}?${query}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || '导出包列表读取失败');
      if (!controller.signal.aborted) setPackages(body.packages);
    }).catch(error => { if (!controller.signal.aborted) setErrors([error instanceof Error ? error.message : '导出包列表读取失败']); });
    return () => controller.abort();
  }, [endpoint, query]);
  const selected = workspace.cards.filter(card => selectedPlanIds.includes(card.planId));
  const ready = selected.length === selectedPlanIds.length && selected.length > 0 && selected.every(card => card.approved && card.exportEligible
    && card.exportStatus === 'exported' && !card.formalOutdated && card.currentFormalArtifact?.cover);
  async function create() {
    if (pending.current || !ready) return;
    pending.current = true; setBusy(true); setErrors([]); setMessage('');
    const items = selected.map(card => ({ planId: card.planId, videoArtifactId: card.currentFormalArtifact!.video.id,
      coverArtifactId: card.currentFormalArtifact!.cover!.id }));
    const selection = JSON.stringify(items);
    if (attempt.current?.selection !== selection) attempt.current = { selection, requestKey: crypto.randomUUID() };
    try {
      const response = await fetch(`${endpoint}?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestKey: attempt.current!.requestKey, items }) });
      const body = await response.json();
      if (!response.ok) {
        setErrors(Array.isArray(body.items) ? body.items.map((item: { planId: string; message: string }) =>
          `成片 ${selected.find(card => card.planId === item.planId)?.seq ?? '—'}：${item.message}`) : [body.message || '打包失败，请重试']);
        return;
      }
      setPackages(current => [body, ...current.filter(item => item.id !== body.id)]);
      setMessage(`已保存 ${body.count} 条成片的导出包，点击下方「下载 ZIP」即可下载。`);
    } catch { setErrors(['打包结果暂未收到，请重试；同一次选择不会重复建包。']); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="card space-y-3 p-5" aria-label="成片导出包">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h4 className="font-semibold text-ink">打包下载</h4>
        <p className="mt-1 text-xs text-ink-secondary">把选中的正式视频、封面和剪辑清单一起打包。后续修改成片，已有导出包仍保留原来的内容。</p></div>
      <button type="button" className="btn-secondary text-xs" disabled={busy || !ready} onClick={() => void create()}>
        {busy ? '正在核对并打包…' : `创建导出包（${selected.length}）`}
      </button>
    </div>
    {!ready && <p className="text-xs text-ink-secondary">请勾选已确认、已正式导出的成片；有未导出的修改时，先重新正式导出。</p>}
    {message && <p role="status" className="text-xs text-ok">{message}</p>}
    {errors.length > 0 && <ul role="alert" className="list-inside list-disc text-xs text-fail">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
    {packages.length > 0 && <ul className="space-y-2" aria-label="已保存的导出包">{packages.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <span className="text-ink-secondary">{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.count} 条成片</span>
      <a className="btn-secondary text-xs" href={`${endpoint}/${encodeURIComponent(item.id)}/download?${query}`} target="_blank" rel="noreferrer">下载 ZIP</a>
    </li>)}</ul>}
  </section>;
}
