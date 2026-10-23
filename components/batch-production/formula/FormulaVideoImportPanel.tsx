'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaMaterialIndex } from '@/lib/batch-production/formula/material-bindings';
import { groupFormulaVideoUploads } from '@/lib/batch-production/formula/video-upload';
import { fingerprintsEqual } from '@/lib/batch-production/fingerprint-format';

async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '操作失败，请重试');
  return body;
}

function CodeEditor({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (code: string) => void }) {
  const [code, setCode] = useState(value);
  return <form className="flex gap-2" onSubmit={event => { event.preventDefault(); onSave(code); }}>
    <input aria-label="素材编号" placeholder="例如 G1" value={code} maxLength={64} disabled={disabled}
      onChange={event => setCode(event.target.value)} className="w-24 rounded border border-hairline bg-surface px-2 py-1 text-ink" />
    <button type="submit" className="btn-secondary" disabled={disabled || !code.trim() || code === value}>保存</button>
  </form>;
}

export default function FormulaVideoImportPanel({ projectId, batchId, inputRevision, onChanged }: {
  projectId: string; batchId: string; inputRevision: number; onChanged: () => Promise<void>;
}) {
  const [index, setIndex] = useState<FormulaMaterialIndex | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [failures, setFailures] = useState<Array<{ file: File; message: string }>>([]);
  const [showAll, setShowAll] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/materials?projectId=${encodeURIComponent(projectId)}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const next = await read<FormulaMaterialIndex>(await fetch(url, { cache: 'no-store', signal }));
    setIndex(next); return next;
  }, [url]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(read<FormulaMaterialIndex>).then(value => {
      if (!controller.signal.aborted) setIndex(value);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    return () => controller.abort();
  }, [url, inputRevision]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function upload(files: File[]) {
    if (!index || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true); setUploading(true); setError(''); setFailures([]);
    const groups = groupFormulaVideoUploads(files);
    const remaining = new Set(groups.batches.flat());
    const failed = [...groups.rejected];
    let imported = 0;
    let reused = 0;
    try {
      // 重新选择文件夹后按内容指纹和相对来源核对；同名/同大小不能冒充同一文件。
      const current = await load(controller.signal);
      for (const group of groups.batches) {
        controller.signal.throwIfAborted();
        const pending: File[] = [];
        for (const file of group) {
          setProgress(`核对文件 ${imported + reused + pending.length + 1} / ${files.length}：${file.name}`);
          const sourcePath = file.webkitRelativePath || file.name;
          const known = current.bindings.filter(item => item.sourcePath === sourcePath && item.available);
          let present = false;
          if (known.length) {
            const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
            const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
            present = known.some(item => fingerprintsEqual(item.contentFingerprint, fingerprint));
          }
          controller.signal.throwIfAborted();
          if (present) { reused++; remaining.delete(file); } else pending.push(file);
        }
        if (!pending.length) continue;
        const data = new FormData();
        for (const file of pending) data.append('files', file, file.name);
        data.append('sourcePaths', JSON.stringify(pending.map(file => file.webkitRelativePath || file.name)));
        setProgress(`正在复制并核验 ${pending.length} 个视频，已完成 ${imported + reused} / ${files.length}`);
        try {
          const result = await read<{ receipts: Array<{ index: number; bindingId?: string }>; errors: Array<{ index: number; message: string }> }>(await fetch(
            `/api/batch-production/assets/import?projectId=${encodeURIComponent(projectId)}&formulaBatchId=${encodeURIComponent(batchId)}`,
            { method: 'POST', body: data, signal: controller.signal },
          ));
          pending.forEach((file, position) => {
            if (result.receipts?.some(receipt => receipt.index === position && receipt.bindingId)) { imported++; remaining.delete(file); }
            else { failed.push({ file, message: result.errors?.find(item => item.index === position)?.message ?? '没有收到导入回执，请重试' }); remaining.delete(file); }
          });
        } catch (err) {
          if (controller.signal.aborted) throw err;
          for (const file of pending) { failed.push({ file, message: err instanceof Error ? err.message : '上传失败' }); remaining.delete(file); }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      for (const file of remaining) failed.push({ file, message: controller.signal.aborted ? '已停止，重新导入时会核对是否已保存' : '尚未完成，请重试' });
      setFailures(failed);
      setProgress(`本次导入 ${imported} 个，已存在 ${reused} 个，未完成 ${failed.length} 个。`);
      controllerRef.current = null;
      setBusy(false);
      setUploading(false);
      try { await load(); await onChanged(); } catch (err) { setError(err instanceof Error ? err.message : '刷新失败'); }
    }
  }

  async function saveCode(bindingId: string, logicalCode: string) {
    if (busy || !index) return;
    setBusy(true); setError('');
    try {
      setIndex(await read<FormulaMaterialIndex>(await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindingId, logicalCode, expectedRevision: index.revision }) })));
      await onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : '编号保存失败'); }
    finally { setBusy(false); }
  }

  const bindings = index?.bindings ?? [];
  const missing = index?.codes.filter(code => code.status !== 'available' && (code.defined || code.referencedBy.length)) ?? [];
  return <div className="card space-y-3 p-4" aria-label="实拍视频导入">
    <h2 className="text-base font-semibold text-ink">导入实拍视频</h2>
    <p className="text-sm text-ink-secondary">选择视频或整个文件夹，系统会分批复制到项目中，并按文件名识别编号。原文件保持不变。</p>
    <div className="flex flex-wrap gap-4">
      <label className={`inline-flex cursor-pointer items-center rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus-within:ring-2 focus-within:ring-accent ${busy || !index ? 'opacity-50' : 'hover:bg-surface-subtle'}`}><span>选择视频</span>
        <input className="sr-only" type="file" multiple accept=".mp4,.mov,.avi,.webm" aria-label="选择实拍视频" disabled={busy || !index}
          onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void upload(files); }} />
      </label>
      <label className={`inline-flex cursor-pointer items-center rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus-within:ring-2 focus-within:ring-accent ${busy || !index ? 'opacity-50' : 'hover:bg-surface-subtle'}`}><span>选择文件夹</span>
        <input className="sr-only" type="file" multiple {...{ webkitdirectory: '' }} aria-label="选择实拍文件夹" disabled={busy || !index}
          onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void upload(files); }} />
      </label>
    </div>
    <p className="text-xs text-ink-tertiary">单文件不超过 256 MiB；每次请求不超过 100 个文件、512 MiB。关闭页面后可重新选择原文件夹，已保存且内容相同的文件会跳过。</p>
    {progress && <p role="status" className="text-sm text-ink-secondary">{progress}</p>}
    {uploading && <button type="button" className="btn-secondary" onClick={() => controllerRef.current?.abort()}>停止本次导入</button>}
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {failures.length > 0 && <div className="space-y-2">
      <ul className="max-h-40 overflow-auto text-sm text-fail">{failures.map((item, i) => <li key={i}>{item.file.webkitRelativePath || item.file.name}：{item.message}</li>)}</ul>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => void upload(failures.map(item => item.file))}>重试未完成文件</button>
    </div>}
    <p className="text-sm text-ink-secondary">已登记 {bindings.length} 个文件来源 · 待填编号 {bindings.filter(item => !item.logicalCode).length} 个 · 排除预览文件 {bindings.filter(item => item.excludedReason).length} 个</p>
    {bindings.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead><tr className="border-b border-hairline text-ink-secondary"><th className="p-2">文件</th><th className="p-2">编号</th><th className="p-2">状态</th></tr></thead>
      <tbody>{(showAll ? bindings : bindings.slice(0, 20)).map(binding => <tr key={binding.id} className="border-b border-hairline text-ink">
        <td className="p-2">{binding.sourcePath}{binding.available && <button type="button" className="btn-secondary ml-2" onClick={() => setPreviewId(binding.assetId)}>预览</button>}</td>
        <td className="p-2"><CodeEditor key={`${binding.id}:${binding.logicalCode}`} value={binding.logicalCode ?? ''} disabled={busy} onSave={code => void saveCode(binding.id, code)} /></td>
        <td className="p-2">{binding.excludedReason ? '预览文件，已排除' : !binding.available ? '文件不可用' : !binding.logicalCode ? '待填编号' : '已复制并核验'}</td>
      </tr>)}</tbody>
    </table>{bindings.length > 20 && <button type="button" className="btn-secondary mt-2" onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : `查看全部 ${bindings.length} 个来源`}</button>}</div>}
    {previewId && <div className="space-y-2"><video key={previewId} controls preload="metadata" className="max-h-72 w-full rounded-lg"
      src={`/api/batch-production/assets/${encodeURIComponent(previewId)}/preview?projectId=${encodeURIComponent(projectId)}`} />
      <button type="button" className="btn-secondary" onClick={() => setPreviewId(null)}>关闭预览</button></div>}
    {missing.length > 0 && <details className="text-sm text-ink-secondary"><summary>有 {missing.length} 个编号需要补资料或文件</summary>
      <ul className="mt-2 max-h-48 overflow-auto">{missing.map(code => <li key={code.logicalCode}>{code.logicalCode}：{code.defined ? '有素材资料，但没有可用视频' : '编号未定义，也没有可用视频'}{code.referencedBy.length ? `，影响 ${code.referencedBy.length} 条脚本` : ''}</li>)}</ul>
    </details>}
  </div>;
}
