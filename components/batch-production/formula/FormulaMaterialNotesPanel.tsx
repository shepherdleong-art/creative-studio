'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaMaterialContent, FormulaMaterialNoteItem, FormulaMaterialNotesView } from '@/lib/batch-production/formula/material-notes';

type Model = { id: string; name: string; model: string };
type View = FormulaMaterialNotesView & { aiProviders?: Model[] };
const pending = (item: FormulaMaterialNoteItem) => item.available && !item.excluded && (!item.profile || (item.stale && item.profile.origin === 'ai'));
async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '素材整理失败，请重试');
  return body;
}

function NoteEditor({ item, busy, onSave, onCancel }: { item: FormulaMaterialNoteItem; busy: boolean;
  onSave: (content: FormulaMaterialContent) => void; onCancel: () => void }) {
  const [description, setDescription] = useState(item.profile?.content.description ?? '');
  const [category, setCategory] = useState(item.profile?.content.category ?? '');
  const [sellingPoints, setSellingPoints] = useState(item.profile?.content.sellingPoints.join('，') ?? '');
  const [actions, setActions] = useState(item.profile?.content.actions.join('，') ?? '');
  const [speech, setSpeech] = useState<FormulaMaterialContent['speech']>(item.profile?.content.speech ?? 'unknown');
  const split = (value: string) => value.split(/[，,\n]/).map(item => item.trim()).filter(Boolean);
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

export default function FormulaMaterialNotesPanel({ projectId, batchId, inputRevision, onChanged }: {
  projectId: string; batchId: string; inputRevision: number; onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<View | null>(null);
  const [providerId, setProviderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<{ item: FormulaMaterialNoteItem; revision: number } | null>(null);
  const active = useRef<AbortController | null>(null);
  const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/material-notes?projectId=${encodeURIComponent(projectId)}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await read<View>(await fetch(url, { cache: 'no-store', signal }));
    if (!signal?.aborted) setView(value);
    return value;
  }, [url]);
  const organize = useCallback(async (current: View, modelId: string) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setOrganizing(true); setError('');
    try {
      const next = await read<FormulaMaterialNotesView>(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ expectedRevision: current.revision, providerId: modelId }) }));
      setView({ ...next, aiProviders: current.aiProviders });
      await onChanged();
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '整理失败');
      await load().catch(() => {});
    } finally { active.current = null; setBusy(false); setOrganizing(false); }
  }, [url, onChanged, load]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(read<View>).then(value => {
      if (controller.signal.aborted) return;
      setView(value);
      const modelId = providerId || value.aiProviders?.[0]?.id;
      if (!editing && modelId && value.items.some(pending) && (!value.run || value.run.state === 'completed')) void organize(value, modelId);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    return () => controller.abort();
  }, [url, inputRevision, providerId, editing, organize]);
  useEffect(() => () => active.current?.abort(), []);
  const running = view?.run?.state === 'running';
  useEffect(() => {
    if (!running && !busy) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void load(controller.signal).catch(() => {}); }, 2000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [running, busy, load]);

  async function save(content: FormulaMaterialContent) {
    if (!editing || busy) return;
    setBusy(true); setError('');
    try {
      const next = await read<FormulaMaterialNotesView>(await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindingId: editing.item.bindingId, expectedRevision: editing.revision,
          expectedProfileId: editing.item.profile?.id ?? null, content }) }));
      setView({ ...next, aiProviders: view?.aiProviders }); setEditing(null);
      await onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
    finally { setBusy(false); }
  }
  const items = view?.items.filter(item => !item.excluded) ?? [];
  const remaining = items.filter(pending).length;
  return <section className="card space-y-3 p-4" aria-label="素材内容整理">
    <h2 className="text-base font-semibold text-ink">素材内容整理</h2>
    <p className="text-sm text-ink-secondary">AI 根据文件名和素材表整理大概内容，结果标为“基于命名和表格”。视频画面、原声和动作时间尚未核验。</p>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="素材整理模型" value={providerId || view?.aiProviders?.[0]?.id || ''} disabled={busy || running || !view?.aiProviders?.length}
        onChange={event => setProviderId(event.target.value)} className="rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink">
        {!view?.aiProviders?.length && <option value="">暂无可用脚本模型</option>}
        {view?.aiProviders?.map(model => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}
      </select>
      <button type="button" className="btn-secondary" disabled={busy || running || !view?.aiProviders?.length || !remaining}
        onClick={() => { if (view) void organize(view, providerId || view.aiProviders![0].id); }}>整理未完成项（{remaining}）</button>
      {organizing && <button type="button" className="btn-secondary" onClick={() => active.current?.abort()}>停止本次整理</button>}
    </div>
    {!view?.aiProviders?.length && <p className="text-xs text-ink-secondary">暂时没有可用的脚本模型，可以先手动填写说明；不会把本地编号识别显示成 AI 分析成功。</p>}
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {view?.run && <p role="status" className="text-sm text-ink-secondary">{running ? '正在整理' : view.run.state === 'completed' ? '本次整理完成' : '本次整理未全部完成'}：已保存 {view.run.succeeded} / {view.run.total} 项，保留已有说明 {view.run.skipped} 项。{view.run.message}</p>}
    <p className="text-xs text-ink-secondary">共 {items.length} 个正式文件来源 · 已有说明 {items.filter(item => item.profile).length} 个 · 资料变化或有差异需核对 {items.filter(item => item.stale || item.profile?.content.conflicts?.length).length} 个</p>
    {editing && <NoteEditor key={editing.item.bindingId} item={editing.item} busy={busy} onSave={content => void save(content)} onCancel={() => setEditing(null)} />}
    <div className="space-y-2">{(showAll ? items : items.slice(0, 20)).map(item => <article key={item.bindingId} className="space-y-2 rounded-lg border border-hairline p-3">
      <div className="flex items-start justify-between gap-3"><p className="break-all text-sm font-medium text-ink">{item.sourceName}</p>
        <button type="button" className="btn-secondary shrink-0" disabled={busy || Boolean(editing)} onClick={() => { if (view) setEditing({ item, revision: view.revision }); }}>修改说明</button></div>
      <p className="text-xs text-ink-secondary">{item.profile ? item.profile.origin === 'manual' ? '人工说明' : '基于命名和表格 · AI 整理' : '尚未整理'}{item.stale ? ' · 来源资料已变化，请核对' : ''}{!item.available ? ' · 视频不可用' : ''}</p>
      {item.profile && <><p className="whitespace-pre-wrap text-sm text-ink">{item.profile.content.description}</p>
        {item.profile.content.conflicts?.map((conflict, i) => <p key={i} className="text-xs text-fail">命名与表格有差异：{conflict.message}（文件名“{conflict.filenameQuote}”；素材表“{conflict.tableQuote}”）。请核对并修改说明。</p>)}
        <p className="text-xs text-ink-secondary">类别：{item.profile.content.category || '未确定'} · 口播：{item.profile.content.speech === 'yes' ? '有口播（仍需核验）' : item.profile.content.speech === 'no' ? '无口播（仍需核验）' : '未确定'}</p>
        {(item.profile.content.sellingPoints.length > 0 || item.profile.content.actions.length > 0) && <p className="text-xs text-ink-secondary">卖点：{item.profile.content.sellingPoints.join('、') || '未确定'}；动作：{item.profile.content.actions.join('、') || '未确定'}</p>}
      </>}
      <details className="text-xs text-ink-secondary"><summary className="cursor-pointer">查看命名及表格依据</summary>
        <p className="mt-2 break-all">文件名：{item.sourceName}</p>
        {item.source.table && <div className="mt-2 space-y-1"><p>{item.source.table.sheet} 第 {item.source.table.row} 行</p>
          {Object.entries(item.source.table.fields).map(([field, value]) => <p key={field} className="whitespace-pre-wrap">{field}：{value}</p>)}</div>}
        {item.profile?.content.evidence.map((evidence, i) => <p key={i} className="mt-1">{evidence.source === 'filename' ? '文件名' : '素材表'}引用：{evidence.quote}</p>)}
      </details>
      {view?.run?.errors.filter(error => error.bindingId === item.bindingId).map((error, i) => <p key={i} className="text-xs text-fail">{error.message}</p>)}
    </article>)}</div>
    {items.length > 20 && <button type="button" className="btn-secondary" onClick={() => setShowAll(value => !value)}>{showAll ? '收起素材说明' : `查看全部 ${items.length} 个素材说明`}</button>}
  </section>;
}
