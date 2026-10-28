'use client';

import { useEffect, useState } from 'react';
import type { FormulaGenerationProgress } from '@/lib/live-mixcut/formula/progress';
import type { FormulaSelectionHistory } from '@/lib/live-mixcut/formula/reselection';
import FormulaAudioRecoveryPanel from './FormulaAudioRecoveryPanel';

export default function FormulaIssuePanel({ projectId, batchId, item, onChanged, onNavigate }: {
  projectId: string; batchId: string; item: FormulaGenerationProgress['items'][number];
  onChanged: () => Promise<void>; onNavigate: (step: 0 | 1) => void;
}) {
  const [view, setView] = useState<FormulaSelectionHistory | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const url = `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(item.planId)}/selection?projectId=${encodeURIComponent(projectId)}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.message || '读取失败');
      if (!controller.signal.aborted) setView(body);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取失败'); });
    return () => controller.abort();
  }, [url]);
  const candidates = view?.candidates.filter((candidate, index, all) => all.findIndex(other => other.assetId === candidate.assetId && other.logicalCode === candidate.logicalCode) === index) ?? [];
  const missing = view?.current.result?.slots.filter(slot => !slot.candidate) ?? [];
  async function replace() {
    if (!view || busy) return;
    setBusy(true); setError('');
    try {
      const overrides = [...view.current.overrides.filter(choice => !choices[choice.slotId]),
        ...Object.entries(choices).filter(([, value]) => value).map(([slotId, value]) => {
          const candidate = view.candidates.find(candidate => JSON.stringify([candidate.logicalCode, candidate.assetId]) === value);
          if (!candidate) throw new Error('候选已变化，请重新打开');
          return { slotId, sourceLogicalCode: candidate.logicalCode, assetId: candidate.assetId };
        })];
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        requestKey: crypto.randomUUID(), expectedStageId: view.current.id, expectedOutputVersionId: view.outputVersion?.id ?? null,
        expectedEditRevision: view.outputVersion?.editRevision ?? 0, overrides,
      }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.message || '替换未保存');
      setView(body); setChoices({}); setMessage('已为这条成片保存替换并继续制作，公式镜头顺序保留。其他成片不变。');
      await onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : '处理失败'); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4" aria-label="处理这条成片">
    <p className="font-medium text-ink">脚本 {item.scriptNumber} · 第 {item.copyIndex} 份 · {item.phase}</p>
    <p className="whitespace-pre-wrap text-sm text-fail">{item.detail}</p>
    {view && <p className="text-sm text-ink-secondary">公式顺序：{view.slots.map(slot => slot.logicalCode).join(' → ')}</p>}
    {view && item.phase === '安排声音' && <FormulaAudioRecoveryPanel projectId={projectId} batchId={batchId} planId={item.planId}
      assets={view.current.result?.slots.flatMap(slot => slot.candidate ? [{ slotId: slot.slotId, assetId: slot.candidate.assetId }] : []) ?? []}
      onChanged={onChanged} />}
    {item.phase === '选片' && missing.map(slot => <div key={slot.slotId} className="space-y-2 rounded-xl border border-hairline p-3">
      <p className="text-sm font-medium text-ink">第 {slot.clipId + 1} 个镜头：{slot.logicalCode}</p>
      <p className="text-xs text-ink-secondary">{slot.replacementCheck?.message || '原片不可用，请补传或明确指定替代素材。'}</p>
      <label className="block text-sm text-ink">为 {slot.logicalCode} 指定替代原片
        <select aria-label={`第 ${slot.clipId + 1} 个镜头替代原片`} value={choices[slot.slotId] ?? ''} disabled={busy || !view?.editable}
          onChange={event => setChoices(current => ({ ...current, [slot.slotId]: event.target.value }))}
          className="mt-2 w-full rounded-lg border border-hairline bg-surface p-2 text-ink">
          <option value="">请选择你确认能替代的原片</option>
          {candidates.map(candidate => <option key={`${candidate.logicalCode}:${candidate.assetId}`} value={JSON.stringify([candidate.logicalCode, candidate.assetId])}>
            {candidate.logicalCode} · {candidate.sourceName}</option>)}
        </select>
      </label>
      {choices[slot.slotId] && <video controls preload="metadata" className="max-h-48 w-full rounded-lg" aria-label={`第 ${slot.clipId + 1} 个镜头替代预览`}
        src={`/api/live-mixcut/assets/${encodeURIComponent(JSON.parse(choices[slot.slotId])[1])}/preview?projectId=${encodeURIComponent(projectId)}`} />}
    </div>)}
    {!!missing.length && item.phase === '选片' && <button type="button" className="btn-primary" disabled={busy || !view?.editable || !Object.values(choices).some(Boolean)}
      onClick={() => void replace()}>{busy ? '正在保存…' : '使用所选素材继续这条'}</button>}
    <div className="flex flex-wrap gap-2">
      {item.phase === '选片' && <button type="button" className="btn-secondary" onClick={() => onNavigate(0)}>前往补传原片</button>}
      <button type="button" className="btn-secondary" onClick={() => onNavigate(1)}>{item.phase === '选片' ? '前往修正脚本公式' : '打开声音、时长与生成设置'}</button>
    </div>
    {!view && !error && <p role="status" className="text-sm text-ink-secondary">正在读取这条成片的记录…</p>}
    {view && !view.editable && <p className="text-sm text-ink-secondary">这份制作输入已过期或批次已停止，请从当前制作进度重新进入。</p>}
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {message && <p role="status" className="text-sm text-ok">{message}</p>}
  </section>;
}
