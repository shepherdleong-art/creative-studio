'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaMaterialIndex } from '@/lib/live-mixcut/formula/material-bindings';
import type { FormulaMaterialContent, FormulaMaterialNoteItem, FormulaMaterialNotesView } from '@/lib/live-mixcut/formula/material-notes';
import { groupFormulaVideoUploads } from '@/lib/live-mixcut/formula/video-upload';
import { fingerprintsEqual } from '@/lib/live-mixcut/fingerprint-format';

type MaterialModel = { id: string; name: string; model: string };
type NotesView = FormulaMaterialNotesView & { aiProviders?: MaterialModel[] };
const pendingNote = (item: FormulaMaterialNoteItem) => item.available && !item.excluded
  && (!item.profile || (item.stale && item.profile.origin === 'ai'));

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

function MaterialPreview({ projectId, assetId, sourcePath, available, expanded, onToggle }: {
  projectId: string; assetId: string; sourcePath: string; available: boolean; expanded: boolean; onToggle: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (expanded) {
    return <video key={assetId} controls preload="metadata" className="aspect-video w-full rounded-lg bg-black"
      src={`/api/live-mixcut/assets/${encodeURIComponent(assetId)}/preview?projectId=${encodeURIComponent(projectId)}`} />;
  }
  return <button type="button" disabled={!available} onClick={onToggle} aria-label={`预览 ${sourcePath}`}
    className="group relative block aspect-video w-full overflow-hidden rounded-lg border border-hairline bg-surface-subtle">
    {available && !failed
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={`/api/live-mixcut/assets/${encodeURIComponent(assetId)}/thumbnail?projectId=${encodeURIComponent(projectId)}`}
        alt="" loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" />
      : <span className="flex h-full items-center justify-center text-xs text-ink-tertiary">{available ? '暂无缩略图' : '文件不可用'}</span>}
    {available && <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/25">
      <span className="rounded-full bg-black/55 px-3 py-1.5 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">预览</span>
    </span>}
  </button>;
}

function NoteEditor({ item, busy, onSave, onCancel }: { item: FormulaMaterialNoteItem; busy: boolean;
  onSave: (content: FormulaMaterialContent) => void; onCancel: () => void }) {
  const [description, setDescription] = useState(item.profile?.content.description ?? '');
  const [category, setCategory] = useState(item.profile?.content.category ?? '');
  const [sellingPoints, setSellingPoints] = useState(item.profile?.content.sellingPoints.join('，') ?? '');
  const [actions, setActions] = useState(item.profile?.content.actions.join('，') ?? '');
  const [speech, setSpeech] = useState<FormulaMaterialContent['speech']>(item.profile?.content.speech ?? 'unknown');
  const split = (value: string) => value.split(/[，,\n]/).map(value => value.trim()).filter(Boolean);
  return <form className="space-y-3 rounded-lg border border-hairline bg-surface p-3" onSubmit={event => {
    event.preventDefault(); onSave({ description, category, sellingPoints: split(sellingPoints), actions: split(actions), speech, evidence: [] });
  }}>
    <p className="text-sm font-medium text-ink">修改说明：{item.sourceName}</p>
    {Boolean(item.profile?.content.conflicts?.length) && <p className="text-sm text-fail">命名与表格有差异。请核对后填写采用的说明；保存人工说明后消除此提示，原始依据仍保留。</p>}
    <label className="block text-xs text-ink-secondary">内容说明
      <textarea aria-label="素材内容说明" value={description} maxLength={400} required disabled={busy} onChange={event => setDescription(event.target.value)}
        className="mt-1 min-h-20 w-full rounded border border-hairline bg-surface px-2 py-1 text-sm text-ink" />
    </label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-ink-secondary">类别
        <input aria-label="素材类别" value={category} maxLength={100} disabled={busy} onChange={event => setCategory(event.target.value)} className="mt-1 w-full rounded border border-hairline bg-surface px-2 py-1 text-sm text-ink" />
      </label>
      <label className="text-xs text-ink-secondary">是否包含口播
        <select aria-label="素材口播标记" value={speech} disabled={busy} onChange={event => setSpeech(event.target.value as FormulaMaterialContent['speech'])}
          className="mt-1 w-full rounded border border-hairline bg-surface px-2 py-1 text-sm text-ink">
          <option value="unknown">尚不确定</option><option value="yes">有口播</option><option value="no">无口播</option>
        </select>
      </label>
      <label className="text-xs text-ink-secondary">卖点（用逗号分隔）
        <input aria-label="素材卖点" value={sellingPoints} maxLength={1440} disabled={busy} onChange={event => setSellingPoints(event.target.value)} className="mt-1 w-full rounded border border-hairline bg-surface px-2 py-1 text-sm text-ink" />
      </label>
      <label className="text-xs text-ink-secondary">动作（用逗号分隔）
        <input aria-label="素材动作" value={actions} maxLength={1440} disabled={busy} onChange={event => setActions(event.target.value)} className="mt-1 w-full rounded border border-hairline bg-surface px-2 py-1 text-sm text-ink" />
      </label>
    </div>
    <p className="text-xs text-ink-secondary">这里记录内容说明；实际台词、声音和动作区间会在后续制作时另行核验。</p>
    <div className="flex gap-2"><button type="submit" className="btn-primary" disabled={busy || !description.trim()}>保存素材说明</button>
      <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>取消修改</button></div>
  </form>;
}

function NoteBody({ item }: { item: FormulaMaterialNoteItem }) {
  return <>
    <p className="text-xs text-ink-secondary">{item.profile ? item.profile.origin === 'manual' ? '人工说明' : 'AI 整理 · 基于文件名与已有资料' : '尚未整理'}
      {item.stale ? ' · 来源资料已变化，请核对' : ''}{!item.available ? ' · 视频不可用' : ''}</p>
    {item.profile ? <>
      <p className="whitespace-pre-wrap text-sm text-ink">{item.profile.content.description}</p>
      {item.profile.content.conflicts?.map((conflict, i) => <p key={i} className="text-xs text-fail">命名与表格有差异：{conflict.message}（文件名“{conflict.filenameQuote}”；素材表“{conflict.tableQuote}”）。请核对并修改说明。</p>)}
      <p className="text-xs text-ink-secondary">类别：{item.profile.content.category || '未确定'} · 口播：{item.profile.content.speech === 'yes' ? '有口播（仍需核验）' : item.profile.content.speech === 'no' ? '无口播（仍需核验）' : '未确定'}</p>
      {(item.profile.content.sellingPoints.length > 0 || item.profile.content.actions.length > 0) && <p className="text-xs text-ink-secondary">卖点：{item.profile.content.sellingPoints.join('、') || '未确定'}；动作：{item.profile.content.actions.join('、') || '未确定'}</p>}
    </> : <p className="text-xs text-ink-secondary">工作台会根据文件名自动整理内容说明，也可以手动填写。</p>}
    <details className="text-xs text-ink-secondary"><summary className="cursor-pointer">查看整理依据</summary>
      <p className="mt-2 break-all">文件名：{item.sourceName}</p>
      {item.source.table && <div className="mt-2 space-y-1"><p>{item.source.table.sheet} 第 {item.source.table.row} 行</p>
        {Object.entries(item.source.table.fields).map(([field, value]) => <p key={field} className="whitespace-pre-wrap">{field}：{value}</p>)}</div>}
      {item.profile?.content.evidence.map((evidence, i) => <p key={i} className="mt-1">{evidence.source === 'filename' ? '文件名' : '素材表'}引用：{evidence.quote}</p>)}
    </details>
  </>;
}

export default function FormulaVideoImportPanel({ projectId, batchId, inputRevision, readOnly, onChanged }: {
  projectId: string; batchId: string; inputRevision: number; readOnly: boolean; onChanged: () => Promise<void>;
}) {
  const [index, setIndex] = useState<FormulaMaterialIndex | null>(null);
  const [notes, setNotes] = useState<NotesView | null>(null);
  const [providerId, setProviderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [failures, setFailures] = useState<Array<{ file: File; message: string }>>([]);
  const [showAll, setShowAll] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ item: FormulaMaterialNoteItem; revision: number } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const organizeRef = useRef<AbortController | null>(null);
  const materialsUrl = `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/materials?projectId=${encodeURIComponent(projectId)}`;
  const notesUrl = `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/material-notes?projectId=${encodeURIComponent(projectId)}`;
  const loadIndex = useCallback(async (signal?: AbortSignal) => {
    const next = await read<FormulaMaterialIndex>(await fetch(materialsUrl, { cache: 'no-store', signal }));
    setIndex(next); return next;
  }, [materialsUrl]);
  const loadNotes = useCallback(async (signal?: AbortSignal) => {
    const next = await read<NotesView>(await fetch(notesUrl, { cache: 'no-store', signal }));
    if (!signal?.aborted) setNotes(next);
    return next;
  }, [notesUrl]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(materialsUrl, { cache: 'no-store', signal: controller.signal }).then(read<FormulaMaterialIndex>)
      .then(value => { if (!controller.signal.aborted) setIndex(value); })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    void fetch(notesUrl, { cache: 'no-store', signal: controller.signal }).then(read<NotesView>)
      .then(value => { if (!controller.signal.aborted) setNotes(value); })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    return () => controller.abort();
  }, [materialsUrl, notesUrl, inputRevision]);
  const organize = useCallback(async (current: NotesView, modelId: string) => {
    if (organizeRef.current || readOnly) return;
    const controller = new AbortController();
    organizeRef.current = controller;
    setOrganizing(true); setError('');
    try {
      const next = await read<NotesView>(await fetch(notesUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ expectedRevision: current.revision, providerId: modelId }) }));
      setNotes({ ...next, aiProviders: current.aiProviders });
      await onChanged();
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '整理失败');
      await loadNotes().catch(() => {});
    } finally { organizeRef.current = null; setOrganizing(false); }
  }, [notesUrl, readOnly, onChanged, loadNotes]);
  useEffect(() => {
    if (readOnly || editing) return;
    const modelId = providerId || notes?.aiProviders?.[0]?.id;
    if (!notes || !modelId) return;
    // 载入后自动续跑未完成项：这是启动外部整理任务的副作用，不是派生状态。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (notes.items.some(pendingNote) && (!notes.run || notes.run.state === 'completed')) void organize(notes, modelId);
  }, [notes, providerId, readOnly, editing, organize]);
  const running = notes?.run?.state === 'running';
  useEffect(() => {
    if (!running && !organizing) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void loadNotes(controller.signal).catch(() => {}); }, 2000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [running, organizing, loadNotes]);
  useEffect(() => () => { controllerRef.current?.abort(); organizeRef.current?.abort(); }, []);

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
      const current = await loadIndex(controller.signal);
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
            `/api/live-mixcut/assets/import?projectId=${encodeURIComponent(projectId)}&formulaBatchId=${encodeURIComponent(batchId)}`,
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
      try { await Promise.all([loadIndex(), loadNotes()]); await onChanged(); }
      catch (err) { setError(err instanceof Error ? err.message : '刷新失败'); }
    }
  }

  async function saveCode(bindingId: string, logicalCode: string) {
    if (busy || !index) return;
    setBusy(true); setError('');
    try {
      setIndex(await read<FormulaMaterialIndex>(await fetch(materialsUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindingId, logicalCode, expectedRevision: index.revision }) })));
      await loadNotes().catch(() => {});
      await onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : '编号保存失败'); }
    finally { setBusy(false); }
  }

  async function saveNote(content: FormulaMaterialContent) {
    if (!editing || busy) return;
    setBusy(true); setError('');
    try {
      const next = await read<NotesView>(await fetch(notesUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindingId: editing.item.bindingId, expectedRevision: editing.revision,
          expectedProfileId: editing.item.profile?.id ?? null, content }) }));
      setNotes({ ...next, aiProviders: notes?.aiProviders }); setEditing(null);
      await onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
    finally { setBusy(false); }
  }

  const bindings = index?.bindings ?? [];
  const notesById = new Map((notes?.items ?? []).map(item => [item.bindingId, item]));
  const items = notes?.items.filter(item => !item.excluded) ?? [];
  const remaining = items.filter(pendingNote).length;
  const missing = index?.codes.filter(code => code.status !== 'available' && (code.defined || code.referencedBy.length)) ?? [];
  const visible = showAll ? bindings : bindings.slice(0, 20);
  return <div className="card space-y-3 p-4" aria-label="实拍视频导入与整理">
    <h2 className="text-base font-semibold text-ink">导入与整理素材</h2>
    <p className="text-sm text-ink-secondary">选择视频或整个文件夹，系统会分批复制到项目中，按文件名识别编号，并自动整理内容说明。原文件保持不变。</p>
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
    {bindings.length > 0 && <p className="text-sm text-ink-secondary">已登记 {bindings.length} 个文件来源 · 待填编号 {bindings.filter(item => !item.logicalCode).length} 个 · 排除预览文件 {bindings.filter(item => item.excludedReason).length} 个</p>}
    {items.length > 0 && <p className="text-sm text-ink-secondary">正式文件 {items.length} 个 · 已有说明 {items.filter(item => item.profile).length} 个 · 待整理 {remaining} 个 · 需核对 {items.filter(item => item.stale || item.profile?.content.conflicts?.length).length} 个</p>}
    {bindings.length > 0 && <div className="space-y-2 rounded-lg border border-hairline bg-surface-subtle p-3">
      <p className="text-xs text-ink-secondary">AI 根据文件名整理大概内容，结果标为“AI 整理”。视频画面、原声和动作时间尚未核验。</p>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="素材整理模型" value={providerId || notes?.aiProviders?.[0]?.id || ''} disabled={busy || running || organizing || !notes?.aiProviders?.length}
          onChange={event => setProviderId(event.target.value)} className="rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink">
          {!notes?.aiProviders?.length && <option value="">暂无可用脚本模型</option>}
          {notes?.aiProviders?.map(model => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}
        </select>
        <button type="button" className="btn-secondary" disabled={busy || running || organizing || !notes?.aiProviders?.length || !remaining}
          onClick={() => { if (notes) void organize(notes, providerId || notes.aiProviders![0].id); }}>整理未完成项（{remaining}）</button>
        {organizing && <button type="button" className="btn-secondary" onClick={() => organizeRef.current?.abort()}>停止本次整理</button>}
      </div>
      {!notes?.aiProviders?.length && <p className="text-xs text-ink-secondary">暂时没有可用的脚本模型，可以先手动填写说明；不会把本地编号识别显示成 AI 分析成功。</p>}
      {notes?.run && <p role="status" className="text-sm text-ink-secondary">{running ? '正在整理' : notes.run.state === 'completed' ? '本次整理完成' : '本次整理未全部完成'}：已保存 {notes.run.succeeded} / {notes.run.total} 项，保留已有说明 {notes.run.skipped} 项。{notes.run.message}</p>}
    </div>}
    {bindings.length > 0 && <div className="grid items-start gap-3 sm:grid-cols-2">{visible.map(binding => {
      const note = notesById.get(binding.id);
      const status = binding.excludedReason ? '预览文件，已排除' : !binding.available ? '文件不可用' : !binding.logicalCode ? '待填编号' : '已复制并核验';
      const expanded = previewId === binding.assetId;
      return <article key={binding.id} className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface p-3">
        <MaterialPreview projectId={projectId} assetId={binding.assetId} sourcePath={binding.sourcePath} available={binding.available}
          expanded={expanded} onToggle={() => setPreviewId(expanded ? null : binding.assetId)} />
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 break-all text-sm font-medium text-ink" title={binding.sourcePath}>{binding.sourcePath}</p>
          <span className="shrink-0 text-xs text-ink-secondary">{status}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CodeEditor key={`${binding.id}:${binding.logicalCode}`} value={binding.logicalCode ?? ''} disabled={busy} onSave={code => void saveCode(binding.id, code)} />
          {expanded && <button type="button" className="btn-secondary" onClick={() => setPreviewId(null)}>收起预览</button>}
          {!binding.excludedReason && note && <button type="button" className="btn-secondary" disabled={busy || Boolean(editing)}
            onClick={() => { if (notes) setEditing({ item: note, revision: notes.revision }); }}>修改说明</button>}
        </div>
        {editing?.item.bindingId === binding.id ? <NoteEditor key={binding.id} item={editing.item} busy={busy}
          onSave={content => void saveNote(content)} onCancel={() => setEditing(null)} />
          : note && !binding.excludedReason && <NoteBody item={note} />}
        {notes?.run?.errors.filter(error => error.bindingId === binding.id).map((item, i) => <p key={i} className="text-xs text-fail">{item.message}</p>)}
      </article>;
    })}</div>}
    {bindings.length > 20 && <button type="button" className="btn-secondary" onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : `查看全部 ${bindings.length} 个来源`}</button>}
    {missing.length > 0 && <details className="text-sm text-ink-secondary"><summary>有 {missing.length} 个编号需要补资料或文件</summary>
      <ul className="mt-2 max-h-48 overflow-auto">{missing.map(code => <li key={code.logicalCode}>{code.logicalCode}：{code.defined ? '有素材资料，但没有可用视频' : '编号未定义，也没有可用视频'}{code.referencedBy.length ? `，影响 ${code.referencedBy.length} 条脚本` : ''}</li>)}</ul>
    </details>}
  </div>;
}
