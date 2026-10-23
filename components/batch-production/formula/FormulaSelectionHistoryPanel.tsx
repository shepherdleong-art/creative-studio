'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaSelectionHistory, FormulaReselectionChoice } from '@/lib/batch-production/formula/reselection';
import FormulaTimelineSummary from './FormulaTimelineSummary';
import FormulaManualAudioPanel from './FormulaManualAudioPanel';

async function readResponse(response: Response): Promise<FormulaSelectionHistory> {
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '读取选片记录失败');
  return result;
}

function FormulaNarrationPlayer({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    audio.src = src;
    const play = (event: Event) => {
      // 已暂停媒体仍可能派发队列中的旧 play 事件，不能抢停刚开始的试听。
      if (!(event.target instanceof HTMLMediaElement) || event.target.paused) return;
      // 时间线在用户点播放时同步停其他试听；其加载后的迟到事件不再抢占。
      if (event.target.closest('[data-batch-timeline-player]')) return;
      if (event.target !== audio) audio.pause();
      else document.querySelectorAll<HTMLMediaElement>('audio,video').forEach(media => { if (media !== audio) media.pause(); });
    };
    document.addEventListener('play', play, true);
    return () => { document.removeEventListener('play', play, true); audio.pause(); audio.removeAttribute('src'); audio.load(); };
  }, [src]);
  return <audio ref={ref} controls preload="none" className="w-full" aria-label={label} src={src} />;
}

export default function FormulaSelectionHistoryPanel({ projectId, batchId, planId, refreshKey, onChanged }: {
  projectId: string; batchId: string; planId: string; refreshKey: string; onChanged: () => void;
}) {
  const [view, setView] = useState<FormulaSelectionHistory | null>(null);
  const [revisionId, setRevisionId] = useState('');
  const [choices, setChoices] = useState<FormulaReselectionChoice[]>([]);
  const [previewAsset, setPreviewAsset] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [stale, setStale] = useState(false);
  const dirty = useRef(false);
  const base = useRef<{ stageId: string; outputVersionId: string | null; editRevision: number } | null>(null);
  const requestKey = useRef<string | null>(null);
  const url = `/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(planId)}/selection?projectId=${encodeURIComponent(projectId)}`;
  const apply = useCallback((next: FormulaSelectionHistory, reset: boolean) => {
    setView(next);
    if (reset || !dirty.current) {
      base.current = { stageId: next.current.id, outputVersionId: next.outputVersion?.id ?? null, editRevision: next.outputVersion?.editRevision ?? 0 };
      setChoices(next.current.overrides); setRevisionId(next.current.id); setStale(false);
      dirty.current = false; requestKey.current = null;
    } else if (base.current?.stageId !== next.current.id || base.current.outputVersionId !== (next.outputVersion?.id ?? null)
      || base.current.editRevision !== (next.outputVersion?.editRevision ?? 0)) setStale(true);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(readResponse).then(next => {
      if (!controller.signal.aborted) { apply(next, false); setError(''); }
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取失败'); });
    return () => controller.abort();
  }, [url, refreshKey, apply]);

  const speechPending = view?.current.speech.status === 'pending'
    || ['queued', 'running'].includes(view?.current.audioMapping.taskStatus ?? '')
    || view?.current.narration.status === 'pending'
    || ['queued', 'running'].includes(view?.current.timeline.taskStatus ?? '')
    || (view?.current.speech.status === 'waiting_selection' && ['queued', 'running'].includes(view.current.task?.status ?? ''));
  useEffect(() => {
    if (!speechPending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await readResponse(await fetch(url, { cache: 'no-store', signal: controller.signal }));
        if (controller.signal.aborted) return;
        if (base.current?.stageId !== next.current.id || base.current.outputVersionId !== (next.outputVersion?.id ?? null)
          || base.current.editRevision !== (next.outputVersion?.editRevision ?? 0)) apply(next, false);
        else setView(next); // 只更新进度，保留用户正在查看的历史和未提交选择。
      } catch { /* 主读取和手动刷新负责显示错误；轮询临时失败保留已读结果。 */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2_000);
    };
    timer = setTimeout(poll, 2_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, speechPending, apply]);

  async function reload() {
    setBusy(true); setError('');
    try { apply(await readResponse(await fetch(url, { cache: 'no-store' })), true); setMessage('已读取最新选片记录。'); }
    catch (error) { setError(error instanceof Error ? error.message : '读取失败'); }
    finally { setBusy(false); }
  }
  async function reselect() {
    if (!view || !base.current || busy || stale) return;
    setBusy(true); setError(''); setMessage('');
    requestKey.current ??= crypto.randomUUID();
    try {
      const next = await readResponse(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        requestKey: requestKey.current, expectedStageId: base.current.stageId,
        expectedOutputVersionId: base.current.outputVersionId, expectedEditRevision: base.current.editRevision, overrides: choices,
      }) }));
      apply(next, true); setMessage('已为这条成片创建新的选片记录，其他成片不变。'); onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : '重新选片失败'); }
    finally { setBusy(false); }
  }
  const revision = view?.history.find(item => item.id === revisionId) ?? view?.current;
  const historical = !!view && revision?.id !== view.current.id;
  const locked = busy || !view?.editable || historical || stale;
  return <section className="space-y-3 text-xs text-ink" aria-label="公式选片记录">
    <div><h3 className="font-semibold">选片与替换记录</h3><p className="mt-1 text-ink-secondary">这是制作时的选片记录。替换依据来自资料，画面、声音和最终裁切仍需核验。</p></div>
    {error && <p role="alert" className="text-fail">{error}</p>}
    {message && <p role="status" className="text-ok">{message}</p>}
    {stale && <p role="status" className="text-warn">这条成片已在其他操作中更新，当前选择未丢失。请重新读取后核对。</p>}
    {!view ? <p className="text-ink-secondary">正在读取选片记录…</p> : <>
      <label className="block space-y-1"><span>选片历史</span><select aria-label="选片历史" value={revision?.id ?? ''} disabled={busy}
        className="w-full rounded-lg border border-hairline bg-surface p-2 text-ink" onChange={event => setRevisionId(event.target.value)}>
        {view.history.map(item => <option key={item.id} value={item.id}>第 {item.revision} 次{item.id === view.current.id ? '（当前）' : '（历史）'}</option>)}
      </select></label>
      {historical && <p className="text-ink-secondary">正在查看历史记录，不影响当前选片。</p>}
      {revision && <div className="space-y-2 rounded-lg border border-hairline p-3" aria-label="原声检查结果">
        <h4 className="font-medium">原声检查</h4>
        <p className="text-ink-secondary">{revision.speech.status === 'waiting_selection' ? '选片完成后自动检查这份成片的原声。'
          : revision.speech.status === 'pending' ? '正在检查原片声音，结果会自动更新。'
          : revision.speech.status === 'not_required' ? '本次选择了全部配音，不使用原片声音。'
          : revision.speech.status === 'needs_attention' ? '有原声需要处理，当前还不能确认声音已就绪。'
          : '原片检查已完成，仍需完成这条成片的配音与声音编排。'}</p>
        {revision.speech.sources.map(source => <div key={source.id} className="space-y-1 border-t border-hairline pt-2">
          <p className="font-medium">镜头 {view.slots.filter(slot => source.slotIds.includes(slot.slotId)).map(slot => slot.clipId + 1).join('、')}</p>
          {source.result?.status === 'transcribed' ? <>
            <p>{source.result.text}</p>
            <p className="text-ink-secondary">{source.result.manualVerification ? '人工核对的台词与时间' : '自动识别'} · 待听审 · 原片 {((source.result.words[0]?.startUs ?? 0) / 1_000_000).toFixed(2)}–{((source.result.words.at(-1)?.endUs ?? 0) / 1_000_000).toFixed(2)} 秒</p>
          </> : source.result?.status === 'no_speech' ? <p>人工确认此原片没有人声。</p> : source.result?.status === 'no_audio_stream' ? <p>原片没有音轨。</p>
            : source.result?.status === 'needs_attention' ? <p className="text-warn">{source.result.message}</p>
            : source.taskStatus === 'failed' ? <p className="text-fail">{source.errorMessage || '原声检查失败，请查看任务提示。'}</p>
            : source.taskStatus === 'cancelled' ? <p className="text-ink-secondary">这次检查已停止，记录保留。</p>
            : <p className="text-ink-secondary">等待检查结果…</p>}
        </div>)}
      </div>}
      {revision && <div className="space-y-2 rounded-lg border border-hairline p-3" aria-label="原声与配音分配">
        <h4 className="font-medium">原声与配音分配</h4>
        {revision.audioMapping.result?.status === 'mapped' ? <>
          {revision.audioMapping.result.basis === 'manual' && <p className="font-medium">已人工分配声音用途，成片仍需审听确认。</p>}
          <p className="text-ink-secondary">{revision.timeline.result?.status === 'planned' ? '声音和字幕已排入时间线，仍需结合成片审听。'
            : revision.narration.status === 'ready' ? '配音已生成，可在下方逐段试听。' : '文案用途已保存，实际配音和时间编排仍待完成。'}</p>
          {revision.audioMapping.result.narrations.map(item => {
            const ready = revision.narration.result?.items.find(audio => audio.id === item.id);
            return <div key={`${revision.id}:${item.id}`} className="space-y-1">
            <p className="font-medium">{ready ? '已配音' : '待配音'} · 镜头 {view.slots.filter(slot => item.slotIds.includes(slot.slotId)).map(slot => slot.clipId + 1).join('、')}{ready && ` · ${(ready.audio.durationUs / 1_000_000).toFixed(2)} 秒`}</p>
            <p className="whitespace-pre-wrap">{item.text}</p>
            {ready && <FormulaNarrationPlayer label={`配音试听 ${item.id}`}
              src={`/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(planId)}/narration?projectId=${encodeURIComponent(projectId)}&selectionStageId=${encodeURIComponent(revision.id)}&narrationId=${encodeURIComponent(item.id)}`} />}
          </div>; })}
          {revision.narration.status === 'unconfigured' && <p className="text-warn">这次制作尚未保存完整配音设置；请回到第二步选择音色，重新发起制作。</p>}
          {revision.narration.status === 'pending' && <p role="status" className="text-ink-secondary">正在生成配音并对齐字幕…</p>}
          {revision.narration.status === 'needs_attention' && <p className="text-fail">{revision.narration.taskStatus === 'cancelled'
            ? '这次配音已停止，历史输入保留。' : revision.narration.errorMessage || '配音还需要处理，请查看任务提示。'}</p>}
          {!revision.audioMapping.result.narrations.length && <p>{revision.audioMapping.result.mode === 'original'
            ? '本次保留原声，脚本只作参考，不自动配音。' : '本次没有补配音，请按下方用途和台词对照核对。'}</p>}
          {revision.audioMapping.result.blocks.filter(block => block.kind === 'on_screen').map(block => <div key={block.id} className="space-y-1">
            <p className="font-medium">画面花字 · 镜头 {view.slots.find(slot => slot.slotId === block.slotId)!.clipId + 1}</p>
            <p className="whitespace-pre-wrap">{block.displayText}</p>
            <p className="text-ink-secondary">生成时分配到该镜头；当前文字和显示时段可在包装轨道调整。</p>
          </div>)}
          {revision.audioMapping.result.issues.map((issue, i) => <div key={i} className="space-y-1">
            <p className="text-warn">{issue.message}</p>
            {issue.scriptText && <p className="whitespace-pre-wrap">脚本文案：{issue.scriptText}</p>}
            {issue.sourceText && <p className="whitespace-pre-wrap">实际台词：{issue.sourceText}</p>}
          </div>)}
        </> : revision.audioMapping.result?.status === 'needs_attention' ? revision.audioMapping.result.issues.map((issue, i) => <div key={i} className="space-y-1">
          <p className="text-warn">{issue.message}</p>
          {issue.scriptText && <p>脚本文案：{issue.scriptText}</p>}{issue.sourceText && <p>实际台词：{issue.sourceText}</p>}
        </div>) : revision.audioMapping.taskStatus === 'failed' ? <p className="text-fail">{revision.audioMapping.errorMessage || '声音分配失败，请按任务提示重试。'}</p>
          : <p className="text-ink-secondary">{revision.audioMapping.taskStatus === 'cancelled' ? '这次分配已停止，历史输入保留。'
            : revision.audioMapping.stageId ? '正在分配原声与剩余配音文案…' : '选片和原声检查完成后自动分配。'}</p>}
      </div>}
      {!historical && <FormulaManualAudioPanel key={planId} projectId={projectId} batchId={batchId} planId={planId}
        refreshKey={`${refreshKey}:${revision?.id}:${revision?.speech.status}:${revision?.audioMapping.taskStatus}`}
        disabled={locked} onSaved={() => { void reload(); onChanged(); }} />}
      {revision && <FormulaTimelineSummary view={revision.timeline} />}
      {!revision?.result && <p role="status" className="text-ink-secondary">{revision?.task?.status === 'failed' ? `选片失败：${revision.task.errorMessage || '请重新选片'}`
        : revision?.task?.status === 'cancelled' ? '这次选片已停止，历史输入保留。' : '正在排队或选择素材，尚无本次结果。'}</p>}
      <ol className="space-y-3">{view.slots.map((slot, index) => {
        const decision = revision?.result?.slots.find(item => item.slotId === slot.slotId);
        const replacement = decision?.replacement ?? decision?.manualReplacement;
        const changedCode = decision?.sourceLogicalCode && decision.sourceLogicalCode !== slot.logicalCode;
        const chosen = choices.find(choice => choice.slotId === slot.slotId);
        return <li key={slot.slotId} className="space-y-2 rounded-lg border border-hairline p-2">
          <p className="font-medium">镜头 {index + 1} · {slot.logicalCode}{changedCode ? ` → ${decision.sourceLogicalCode}` : ''}</p>
          {replacement && <p className="text-warn">{decision?.manualReplacement ? '人工统一替换 · 待审' : '自动替换 · 待审'}</p>}
          {changedCode && !replacement && <p className="text-warn">人工指定其他编号 · 待审</p>}
          {replacement && <>
            <p>{replacement.reason}</p>
            {decision?.replacement?.importedSuggestion && <p className="text-ink-secondary">候选来自 {decision.replacement.importedSuggestion.filename}
              {decision.replacement.importedSuggestion.sourceLine ? ` 第 ${decision.replacement.importedSuggestion.sourceLine} 行` : ''}，已按本次素材资料重新核验，画面与声音仍待审片。</p>}
            {decision?.manualReplacement && <p className="text-ink-secondary">来自你保存的统一替换规则，未由 AI 判定等价，请核对画面、台词及脚本意图。</p>}
            <ul className="space-y-1 text-ink-secondary">{replacement.differences.map((difference, i) => <li key={i}>{difference}</li>)}</ul>
            <details><summary className="cursor-pointer text-ink-secondary">查看资料依据</summary><ul className="mt-2 space-y-2">
              {replacement.evidence.map((pair, i) => <li key={i}>
                <p>原资料：{pair.original.quote}</p><p>替代资料：{pair.replacement.quote}</p>
                <p className="text-ink-tertiary">{[pair.original, pair.replacement].map(source => source.source === 'material_table'
                  ? `${source.sheet} ${source.cell || `第 ${source.row} 行`} · ${source.field}` : source.source === 'filename' ? '文件名' : '人工说明').join(' → ')}</p>
              </li>)}
            </ul></details>
          </>}
          {decision && !decision.assetId && <p className="text-warn">{decision.replacementCheck?.message || '指定素材不可用，请检查文件或重新选择。'}</p>}
          {decision?.assetId && <button type="button" className="btn-secondary text-xs" onClick={() => setPreviewAsset(decision.assetId)}>查看原片 {index + 1}</button>}
          {!historical && <label className="block space-y-1"><span>下次使用</span><select aria-label={`镜头 ${index + 1} 选片`} disabled={locked}
            value={chosen ? `${chosen.sourceLogicalCode}:${chosen.assetId}` : ''}
            className="w-full rounded-lg border border-hairline bg-surface p-2 text-ink" onChange={event => {
              const candidate = view.candidates.find(item => `${item.logicalCode}:${item.assetId}` === event.target.value);
              setChoices(current => [...current.filter(item => item.slotId !== slot.slotId), ...(candidate ? [{ slotId: slot.slotId, sourceLogicalCode: candidate.logicalCode, assetId: candidate.assetId }] : [])]);
              dirty.current = true; requestKey.current = null; setMessage('');
            }}>
            <option value="">按已保存的主片或轮换规则自动选择</option>
            {view.candidates.filter((item, i, items) => items.findIndex(other => other.assetId === item.assetId && other.logicalCode === item.logicalCode) === i)
              .map(item => <option key={`${item.logicalCode}:${item.assetId}`} value={`${item.logicalCode}:${item.assetId}`}>{item.logicalCode} · {item.sourceName}</option>)}
          </select></label>}
        </li>;
      })}</ol>
      {previewAsset && <div className="space-y-1"><video controls preload="metadata" className="w-full rounded-lg"
        src={`/api/batch-production/assets/${encodeURIComponent(previewAsset)}/preview?projectId=${encodeURIComponent(projectId)}`} />
        <button type="button" className="btn-secondary text-xs" onClick={() => setPreviewAsset(null)}>关闭原片预览</button></div>}
      {!historical && <><p className="text-ink-secondary">重选只作用于这条成片，会重新检查素材，并使原来的审核确认失效。旧记录和已导出的文件保留。</p>
        <button type="button" className="btn-primary w-full text-xs" disabled={locked} onClick={() => void reselect()}>{busy ? '处理中…' : '按这些选择重选本条'}</button></>}
      <button type="button" className="btn-secondary w-full text-xs" disabled={busy} onClick={() => void reload()}>重新读取（放弃未保存选择）</button>
    </>}
  </section>;
}
