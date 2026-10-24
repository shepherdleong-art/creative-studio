'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormulaSelectionRulesView, FormulaPrimaryChoice, FormulaSlotChoice } from '@/lib/live-mixcut/formula/selection-rules';

type PrimaryInput = Pick<FormulaPrimaryChoice, 'logicalCode' | 'assetId'>;
type SlotInput = Omit<FormulaSlotChoice, 'contentFingerprint'>;
interface RotationInput { logicalCode: string; candidates: Array<{ assetId: string; rangeRevisionId: string }> }
interface ReplacementInput { logicalCode: string; replacementCode: string; reason: string; differencesText: string }
const fieldClass = 'min-w-0 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink';

async function read(response: Response): Promise<FormulaSelectionRulesView> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '人工选片读取失败');
  return body;
}

export default function FormulaSelectionPanel({ projectId, batchId, step, inputRevision, disabled, onChanged }: {
  projectId: string; batchId: string; step: 0 | 1; inputRevision: number; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<FormulaSelectionRulesView | null>(null);
  const [primary, setPrimary] = useState<PrimaryInput[]>([]);
  const [overrides, setOverrides] = useState<SlotInput[]>([]);
  const [rotation, setRotation] = useState<RotationInput[]>([]);
  const [replacements, setReplacements] = useState<ReplacementInput[]>([]);
  const [scriptKey, setScriptKey] = useState('');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [clearedStale, setClearedStale] = useState(false);
  const [preview, setPreview] = useState<{ assetId: string; name: string } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const dirty = useRef(false);
  const url = `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/selection-rules?projectId=${encodeURIComponent(projectId)}`;
  const apply = useCallback((next: FormulaSelectionRulesView) => {
    setView(next);
    setPrimary(next.saved?.rules.primary.map(({ logicalCode, assetId }) => ({ logicalCode, assetId })) ?? []);
    setOverrides(next.saved?.rules.overrides.map(({ scriptKey, slotIndex, logicalCode, sourceLogicalCode, assetId }) =>
      ({ scriptKey, slotIndex, logicalCode, sourceLogicalCode, assetId })) ?? []);
    setRotation(next.saved?.rules.rotation?.map(pool => ({ logicalCode: pool.logicalCode,
      candidates: pool.candidates.map(({ assetId, rangeRevisionId }) => ({ assetId, rangeRevisionId })) })) ?? []);
    setReplacements(next.saved?.rules.replacements?.map(rule => ({ logicalCode: rule.logicalCode,
      replacementCode: rule.replacementCode, reason: rule.reason, differencesText: rule.differences.join('\n') })) ?? []);
    setClearedStale(false); dirty.current = false;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(read).then(next => {
      if (controller.signal.aborted) return;
      if (dirty.current) { setError('资料已更新，未保存的选择仍保留。请重新读取并核对后保存。'); return; }
      apply(next);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    return () => controller.abort();
  }, [url, inputRevision, apply]);

  async function reload() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { apply(await read(await fetch(url, { cache: 'no-store' }))); }
    catch (err) { setError(err instanceof Error ? err.message : '读取失败'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!view || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      apply(await read(await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedInputRevision: view.inputRevision, expectedRulesRevision: view.saved?.revision ?? 0,
          scriptsSessionId: view.scriptsSessionId, rules: { primary, overrides, rotation,
            replacements: replacements.map(({ differencesText, ...rule }) => ({ ...rule,
              differences: differencesText.split(/\r?\n/).map(line => line.trim()).filter(Boolean) })) } }) })));
      await onChanged();
      setMessage('人工选片已保存，尚未开始制作。');
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败，选择已保留'); }
    finally { setBusy(false); }
  }
  function changed() { dirty.current = true; setMessage('选择尚未保存。'); }
  const stale = !!view?.stale && !clearedStale;
  const rotationNeedsReview = rotation.some(pool => !pool.candidates.length || pool.candidates.some(candidate =>
    !view?.ranges.some(range => range.id === candidate.rangeRevisionId && range.assetId === candidate.assetId && range.ranges.length)));
  const refreshing = !!view && view.inputRevision !== inputRevision;
  const locked = disabled || busy || !view?.editable || refreshing;
  const candidates = (view?.materials.bindings ?? []).filter((binding, index, all) => binding.logicalCode && !binding.excludedReason
    && all.findIndex(other => other.logicalCode === binding.logicalCode && other.assetId === binding.assetId && !other.excludedReason) === index);
  const codes = [...new Set([...(view?.materials.codes.map(code => code.logicalCode) ?? []), ...primary.map(item => item.logicalCode), ...rotation.map(item => item.logicalCode)])]
    .filter(code => code.toLowerCase().includes(search.toLowerCase())).map(logicalCode => ({ logicalCode }));
  const script = view?.scripts.find(item => item.key === scriptKey);
  function previewAsset(assetId: string, logicalCode: string) {
    setPreviewError(false);
    const binding = candidates.find(item => item.assetId === assetId && item.logicalCode === logicalCode);
    if (binding) setPreview({ assetId, name: binding.sourceName });
  }
  return <section className="card space-y-3 p-4" aria-label="人工选片">
    <h2 className="text-base font-semibold text-ink">{step === 0 ? '同号素材：主片或候选轮换' : '给某个镜头单独指定素材'}</h2>
    <p className="text-sm text-ink-secondary">可选设置。单镜头指定优先于主片或轮换，未设置时自动选择同号素材。指定原片不可用时会提示处理，不偷偷换片。</p>
    {!view && !error && <p role="status" className="text-sm text-ink-secondary">正在读取人工选片…</p>}
    {refreshing && !error && <p role="status" className="text-sm text-ink-secondary">正在更新素材与可用区间…</p>}
    {view && !view.editable && <p className="text-sm text-ink-secondary">本次制作输入已冻结，当前选择只读；修改需建立新的输入版本。</p>}
    {stale && <div className="space-y-2 text-sm text-ink-secondary">
      <p>脚本已更新，旧的单镜头指定需要重新核对。先清除旧指定，再按当前脚本选择；已冻结的制作记录不受影响。</p>
      <button type="button" className="btn-secondary" disabled={locked} onClick={() => { setOverrides([]); setClearedStale(true); changed(); }}>清除旧的单镜头指定</button>
    </div>}
    {step === 0 && view && <>
      <input className={fieldClass} aria-label="查找主片编号" placeholder="输入编号，如 G1" value={search} onChange={event => { setSearch(event.target.value); setShowAll(false); }} />
      <div className="space-y-3">
        {(showAll ? codes : codes.slice(0, 20)).map(code => {
          const pool = candidates.filter(item => item.logicalCode === code.logicalCode);
          const rotating = rotation.find(item => item.logicalCode === code.logicalCode);
          const chosen = rotating ? '__rotation' : primary.find(item => item.logicalCode === code.logicalCode)?.assetId ?? '';
          return <div key={code.logicalCode} className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
              <span className="w-16 shrink-0">{code.logicalCode}</span>
              <select className={`${fieldClass} flex-1`} aria-label={`${code.logicalCode} 主片`} value={chosen} disabled={locked}
                onChange={event => {
                  const value = event.target.value;
                  setPrimary([...primary.filter(item => item.logicalCode !== code.logicalCode),
                    ...(value && value !== '__rotation' ? [{ logicalCode: code.logicalCode, assetId: value }] : [])]);
                  setRotation([...rotation.filter(item => item.logicalCode !== code.logicalCode),
                    ...(value === '__rotation' ? [rotating ?? { logicalCode: code.logicalCode, candidates: [] }] : [])]); changed();
                }}>
                <option value="">自动选择同号素材</option>
                <option value="__rotation">已批准候选轮换</option>
                {chosen && chosen !== '__rotation' && !pool.some(item => item.assetId === chosen) && <option value={chosen} disabled>已指定素材不在当前编号下，请重新选择</option>}
                {pool.map(item => <option key={item.assetId} value={item.assetId} disabled={!item.available}>{item.sourcePath}{!item.available ? '（不可用）' : ''}</option>)}
              </select>
            </label>
            <button type="button" className="btn-secondary" disabled={!chosen || !pool.some(item => item.assetId === chosen && item.available)} onClick={() => previewAsset(chosen, code.logicalCode)}>预览 {code.logicalCode} 主片</button>
            {rotating && <div className="basis-full space-y-2 rounded-lg border border-hairline p-3">
              <p className="text-sm text-ink-secondary">勾选可用于同一编号的原片。只在这些候选中轮换，脚本的不同份数按固定规则选择；每份候选需先在上方确认可用区间。</p>
              {pool.map(item => {
                const approved = view.ranges.find(range => range.assetId === item.assetId && range.contentFingerprint === item.contentFingerprint && range.ranges.length);
                const checked = rotating.candidates.find(candidate => candidate.assetId === item.assetId);
                return <div key={item.assetId} className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" aria-label={`${code.logicalCode} 轮换候选 ${item.sourcePath}`}
                    checked={!!checked} disabled={locked || ((!approved || !item.available) && !checked)} onChange={event => {
                      const candidates = [...rotating.candidates.filter(candidate => candidate.assetId !== item.assetId),
                        ...(event.target.checked && approved ? [{ assetId: item.assetId, rangeRevisionId: approved.id }] : [])];
                      setRotation(rotation.map(pool => pool.logicalCode === code.logicalCode ? { ...pool, candidates } : pool)); changed();
                    }} />{item.sourcePath}</label>
                  <span className="text-xs text-ink-secondary">{checked && checked.rangeRevisionId !== approved?.id ? '区间已改，请取消后重新勾选' : approved ? `${approved.ranges.length} 个已确认区间` : '请先确认可用区间'}</span>
                  <button type="button" className="btn-secondary" disabled={!item.available} onClick={() => previewAsset(item.assetId, code.logicalCode)}>预览 {item.sourcePath}</button>
                </div>;
              })}
              {pool.length > 1 && <details><summary className="cursor-pointer text-sm text-ink-secondary">并排比较候选原片</summary>
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">{pool.map(item => <figure key={item.assetId}>
                  <figcaption className="mb-1 text-xs text-ink-secondary">{item.sourcePath}</figcaption>
                  <video controls preload="none" className="max-h-48 w-full" aria-label={`轮换候选预览 ${item.sourcePath}`}
                    src={`/api/live-mixcut/assets/${encodeURIComponent(item.assetId)}/preview?projectId=${encodeURIComponent(projectId)}`} />
                </figure>)}</div>
              </details>}
            </div>}
          </div>;
        })}
      </div>
      {codes.length > 20 && <button type="button" className="btn-secondary" onClick={() => setShowAll(value => !value)}>{showAll ? '收起主片列表' : `查看全部 ${codes.length} 个编号`}</button>}
      {!codes.length && <p className="text-sm text-ink-secondary">暂无匹配编号，请先导入视频或修改查找条件。</p>}
      <section className="space-y-3 border-t border-hairline pt-3" aria-label="缺号统一替换">
        <h3 className="font-medium text-ink">缺号统一替换（可选）</h3>
        <p className="text-sm text-ink-secondary">例如缺 S29 时统一用 S25。有原编号就优先用原片；单镜头指定优先。这里只记录你的选择，不表示已经核验画面或台词等价，生成后仍标记待审。</p>
        {replacements.map((rule, index) => {
          const source = view.materials.codes.find(code => code.logicalCode === rule.logicalCode);
          const update = (patch: Partial<ReplacementInput>) => { setReplacements(current => current.map((item, i) => i === index ? { ...item, ...patch } : item)); changed(); };
          const targets = [...new Set(candidates.filter(item => item.available).map(item => item.logicalCode!))];
          return <div key={index} className="space-y-2 rounded-lg border border-hairline p-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-ink">缺少哪个编号
                <select className={fieldClass} aria-label={`替换规则 ${index + 1} 原编号`} value={rule.logicalCode} disabled={locked} onChange={event => update({ logicalCode: event.target.value })}>
                  <option value="">选择原编号</option>
                  {rule.logicalCode && !source?.defined && <option value={rule.logicalCode}>原编号资料缺失：{rule.logicalCode}</option>}
                  {view.materials.codes.filter(code => code.defined).map(code => <option key={code.logicalCode} value={code.logicalCode}>{code.logicalCode}{code.referencedBy.length ? ` · ${code.referencedBy.length} 条脚本引用` : ''}</option>)}
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-ink">使用哪个编号
                <select className={fieldClass} aria-label={`替换规则 ${index + 1} 替代编号`} value={rule.replacementCode} disabled={locked} onChange={event => update({ replacementCode: event.target.value })}>
                  <option value="">选择直接替代编号</option>
                  {rule.replacementCode && !targets.includes(rule.replacementCode) && <option value={rule.replacementCode}>替代素材不可用：{rule.replacementCode}</option>}
                  {targets.filter(code => code !== rule.logicalCode).map(code => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
              <button type="button" className="btn-secondary" aria-label={`移除替换规则 ${index + 1}`} disabled={locked}
                onClick={() => { setReplacements(current => current.filter((_, i) => i !== index)); changed(); }}>移除</button>
            </div>
            <label className="flex flex-col gap-1 text-sm text-ink">替换原因
              <input className={fieldClass} aria-label={`替换规则 ${index + 1} 原因`} maxLength={500} value={rule.reason} disabled={locked}
                placeholder="说明为什么这样替换，供审片时核对" onChange={event => update({ reason: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink">已知差异（每行一项）
              <textarea className={fieldClass} aria-label={`替换规则 ${index + 1} 差异`} rows={2} maxLength={6020} value={rule.differencesText} disabled={locked}
                placeholder="例如：湿布改成纸擦拭，特写改成中景" onChange={event => update({ differencesText: event.target.value })} />
            </label>
            {source && <p className="text-xs text-ink-secondary">引用脚本：{source.referencedBy.join('、') || '暂未被已导入脚本引用'}。只影响此集合以后新生成的计划；已有选片记录不变。</p>}
          </div>;
        })}
        <button type="button" className="btn-secondary" disabled={locked || !view.materials.codes.some(code => code.defined)}
          onClick={() => { setReplacements(current => [...current, { logicalCode: '', replacementCode: '', reason: '', differencesText: '' }]); changed(); }}>添加统一替换规则</button>
        {!view.materials.codes.some(code => code.defined) && <p className="text-sm text-ink-secondary">先导入素材命名表，补齐原编号的资料后再设置统一替换。</p>}
      </section>
    </>}
    {step === 1 && view && <>
      <select className={`${fieldClass} w-full`} aria-label="选择要指定镜头的脚本" value={scriptKey}
        disabled={locked || stale || view.hasPendingScripts} onChange={event => setScriptKey(event.target.value)}>
        <option value="">选择一条脚本</option>
        {view.scripts.map(item => <option key={item.key} value={item.key}>脚本 {item.scriptNumber} · {item.codes.join(' → ')}</option>)}
      </select>
      {view.hasPendingScripts && <p className="text-sm text-ink-secondary">请先确认脚本表，再指定其中的镜头。</p>}
      {script && !stale && script.codes.map((logicalCode, slotIndex) => {
        const selected = overrides.find(item => item.scriptKey === script.key && item.slotIndex === slotIndex);
        const key = selected ? JSON.stringify([selected.sourceLogicalCode, selected.assetId]) : '';
        const present = candidates.some(item => item.logicalCode === selected?.sourceLogicalCode && item.assetId === selected?.assetId);
        return <div key={slotIndex} className="space-y-1">
          <p className="text-sm text-ink-secondary">第 {slotIndex + 1} 个镜头 · 原编号 {logicalCode}</p>
          <div className="flex flex-wrap gap-2">
            <select className={`${fieldClass} flex-1`} aria-label={`脚本 ${script.scriptNumber} 第 ${slotIndex + 1} 个镜头素材`}
              value={key} disabled={locked || view.hasPendingScripts} onChange={event => {
                const [sourceLogicalCode, assetId] = event.target.value ? JSON.parse(event.target.value) as [string, string] : ['', ''];
                setOverrides([...overrides.filter(item => item.scriptKey !== script.key || item.slotIndex !== slotIndex),
                  ...(assetId ? [{ scriptKey: script.key, slotIndex, logicalCode, sourceLogicalCode, assetId }] : [])]); changed();
              }}>
              <option value="">沿用主片或自动选片</option>
              {selected && !present && <option value={key} disabled>已指定素材不可用，请重新选择</option>}
              {candidates.map(item => <option key={JSON.stringify([item.logicalCode, item.assetId])} value={JSON.stringify([item.logicalCode, item.assetId])} disabled={!item.available}>
                {item.logicalCode} · {item.sourcePath}{!item.available ? '（不可用）' : ''}
              </option>)}
            </select>
            <button type="button" className="btn-secondary" disabled={!selected || !present} onClick={() => selected && previewAsset(selected.assetId, selected.sourceLogicalCode)}>预览第 {slotIndex + 1} 个镜头</button>
          </div>
          {selected && selected.sourceLogicalCode !== logicalCode && <p className="text-xs text-ink-secondary">人工指定：{logicalCode} → {selected.sourceLogicalCode}，会保留替换记录供审片核对。</p>}
        </div>;
      })}
      <p className="text-sm text-ink-secondary">当前指定 {overrides.length} 个镜头，适用于各脚本本次制作的所有份数。</p>
    </>}
    {preview && <div className="space-y-2 rounded-lg border border-hairline p-3">
      <p className="text-sm text-ink">正在预览：{preview.name}</p>
      <video key={preview.assetId} controls preload="metadata" className="max-h-72 w-full" aria-label="人工选片原片预览"
        src={`/api/live-mixcut/assets/${encodeURIComponent(preview.assetId)}/preview?projectId=${encodeURIComponent(projectId)}`}
        onError={() => setPreviewError(true)} />
      {previewError && <p role="alert" className="text-sm text-fail">这份原片暂时无法播放，请检查素材后重试。</p>}
      <button type="button" className="btn-secondary" onClick={() => setPreview(null)}>关闭原片预览</button>
    </div>}
    {rotationNeedsReview && <p className="text-sm text-ink-secondary">轮换候选尚未选齐，或其区间已修改。请回到准备素材，核对区间后重新勾选；也可改回自动选择或固定主片。</p>}
    <p className="text-xs text-ink-tertiary">这里确定使用哪份原片及已确认的画面范围。台词、声音和最终裁切仍需后续核验。</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn-primary" disabled={locked || stale || rotationNeedsReview || (!!view?.hasPendingScripts && overrides.length > 0)} onClick={() => void save()}>保存人工选片</button>
      <button type="button" className="btn-secondary" disabled={busy || disabled} onClick={() => void reload()}>重新读取（放弃未保存选择）</button>
    </div>
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {message && <p role="status" className="text-sm text-ok">{message}</p>}
  </section>;
}
