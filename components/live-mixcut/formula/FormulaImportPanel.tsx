'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FormulaInputsView, FormulaImportSessionView } from '@/lib/live-mixcut/formula/import-store';
import FormulaVideoImportPanel from './FormulaVideoImportPanel';
import FormulaColumnMapping from './FormulaColumnMapping';
import type { FormulaSheetMapping } from '@/lib/live-mixcut/formula/workbook';
import type { FormulaScriptInput, FormulaScriptFields } from '@/lib/live-mixcut/formula/script-rows';
import FormulaScriptRowEditor from './FormulaScriptRowEditor';
import FormulaGenerationSettings from './FormulaGenerationSettings';

type InputsWithModels = FormulaInputsView & { aiProviders?: Array<{ id: string; name: string; model: string }> };

async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '读取失败，请重试');
  return body;
}

export interface FormulaInputSummary { batchId: string; videoSources: number; scripts: number }

export default function FormulaImportPanel({ projectId, batchId, step, onSummary, onGenerated, onInputRevised, progress, readOnly: outerReadOnly }: {
  projectId: string; batchId: string; step: 0 | 1; onSummary: (summary: FormulaInputSummary) => void;
  onGenerated: () => Promise<void>; onInputRevised: () => Promise<void>; progress?: ReactNode; readOnly: boolean;
}) {
  const [inputs, setInputs] = useState<InputsWithModels | null>(null);
  const [session, setSession] = useState<FormulaImportSessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [excludeErrors, setExcludeErrors] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [aiRequested, setAiRequested] = useState(false);
  const [editing, setEditing] = useState<{ session: FormulaImportSessionView; row: FormulaScriptInput } | null>(null);
  const progressElement = useRef<HTMLDivElement>(null);
  const openingInput = useRef(false);
  const readOnly = inputs ? !inputs.editing.editable : outerReadOnly;
  const controlsBusy = busy || !!editing || readOnly;
  const kind = 'scripts';
  const label = '脚本表';
  const url = `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/formula/imports?projectId=${encodeURIComponent(projectId)}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await read<InputsWithModels>(await fetch(url, { cache: 'no-store', signal }));
    setInputs(value);
    setSession(value.drafts.find(item => item.kind === kind && item.baseRevision === value.revision) ?? null);
    onSummary({ batchId, videoSources: value.videoSourceCount, scripts: value.scripts?.rows.length ?? 0 });
  }, [url, kind, batchId, onSummary]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(read<InputsWithModels>).then(value => {
      if (controller.signal.aborted) return;
      setInputs(value);
      setSession(value.drafts.find(item => item.kind === kind && item.baseRevision === value.revision) ?? null);
      onSummary({ batchId, videoSources: value.videoSourceCount, scripts: value.scripts?.rows.length ?? 0 });
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '读取失败'); });
    return () => controller.abort();
  }, [url, kind, batchId, onSummary]);
  const aiRunning = session?.extraction?.state === 'running';
  useEffect(() => {
    if (!aiRunning && !aiRequested) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void load(controller.signal).catch(() => {}); }, 2000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [aiRunning, aiRequested, load]);

  async function beginInputRevision() {
    if (openingInput.current || busy || !inputs?.editing.canRevise || !inputs.editing.batchVersionId) return;
    openingInput.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await read(await fetch(url.replace('/imports?', '/input-revisions?'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedBatchVersionId: inputs.editing.batchVersionId, expectedInputRevision: inputs.revision }) }));
      await load();
      await onInputRevised();
      setMessage('现在可以修改素材、脚本和制作设置。改好后在第二步点「生成」，才开始新一轮制作。');
    } catch (err) { setError(err instanceof Error ? err.message : '未能打开修改，请重试'); }
    finally { openingInput.current = false; setBusy(false); }
  }

  async function preview(file: File) {
    if (busy || !inputs) return;
    setBusy(true); setError(''); setMessage(''); setExcludeErrors(false); setShowAll(false);
    try {
      const next = await read<FormulaImportSessionView>(await fetch(`${url}&kind=${kind}&revision=${inputs.revision}&filename=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: file,
      }));
      setSession(next);
      if (inputs.aiProviders?.length && next.draftRevision === 0 && !next.extraction) {
        await updatePreview(next, 'ai');
      }
    } catch (err) { setError(err instanceof Error ? err.message : '读取失败'); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!session || busy) return;
    setBusy(true); setError('');
    try {
      const receipt = await read<{ importedRows: number }>(await fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, expectedRevision: session.baseRevision,
          expectedDraftRevision: session.draftRevision,
          excludedKeys: [...new Set([...(session.excludedKeys ?? []), ...(excludeErrors ? session.preview.issues.map(issue => issue.key) : [])])] }),
      }));
      await load();
      setMessage(`已保存 ${receipt.importedRows} 条${label}资料，刷新或重新打开批次后仍可查看。`);
    } catch (err) { setError(err instanceof Error ? err.message : '确认失败'); }
    finally { setBusy(false); }
  }

  async function modify(action: 'mapping' | 'ai', mapping?: FormulaSheetMapping[]) {
    if (!session || busy) return;
    setBusy(true); setError(''); setMessage(''); setExcludeErrors(false);
    try { await updatePreview(session, action, mapping); }
    finally { setBusy(false); }
  }

  async function updatePreview(current: FormulaImportSessionView, action: 'mapping' | 'ai', mapping?: FormulaSheetMapping[]) {
    setAiRequested(action === 'ai');
    try {
      const next = await read<FormulaImportSessionView>(await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sessionId: current.id, expectedRevision: current.baseRevision,
          expectedDraftRevision: current.draftRevision, mapping, providerId: providerId || inputs?.aiProviders?.[0]?.id }) }));
      setSession(next);
      setMessage(action === 'ai' ? `AI 已识别列对应，已逐行检查 ${next.preview.rowCount} 行原始资料。` : '已保存列对应，预览已更新。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别或修改失败');
      await load().catch(() => {});
    } finally { setAiRequested(false); }
  }

  async function openScript(key?: string) {
    if (!inputs || controlsBusy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      let current = session;
      if (!current) {
        current = await read<FormulaImportSessionView>(await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'revise_scripts', sessionId: inputs.scripts?.sessionId, expectedRevision: inputs.revision }) }));
        setSession(current); setExcludeErrors(false);
      }
      if (key) {
        const row = current.preview.scriptInputs?.find(item => item.key === key);
        if (!row) throw new Error('此旧预览缺少可编辑的原表字段，请重新选择工作簿。');
        setEditing({ session: current, row });
      } else setMessage('已打开脚本修订，原来确认的资料会保留到此次整表确认。');
    } catch (err) { setError(err instanceof Error ? err.message : '无法打开脚本修改'); }
    finally { setBusy(false); }
  }

  async function saveScript(values: FormulaScriptFields) {
    if (!editing || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const current = editing.session;
      const next = await read<FormulaImportSessionView>(await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit_script', sessionId: current.id, key: editing.row.key, values,
          expectedRevision: current.baseRevision, expectedDraftRevision: current.draftRevision }) }));
      setSession(next); setEditing(null); setExcludeErrors(false);
      setMessage(next.preview.issues.length ? '修改已保存到预览，下方问题仍需处理后整表确认。' : '修改已保存到预览，请确认整表后使用。');
    } catch (err) { setError(err instanceof Error ? err.message : '修改未保存'); }
    finally { setBusy(false); }
  }

  const saved = inputs?.[kind];
  const rows = session ? session.preview.rows.filter(row => !session.excludedKeys?.includes(row.key)) : saved?.rows ?? [];
  const unresolvedIssues = session?.preview.issues.filter(issue => !session.excludedKeys?.includes(issue.key)) ?? [];
  const scriptInputs = new Map(session?.preview.scriptInputs?.map(row => [row.key, row]));
  return (
    <section className="min-h-0 flex-1 space-y-4 overflow-auto p-4" aria-label="实拍公式混剪输入">
      {step === 1 && <div ref={progressElement}>{progress}</div>}
      {readOnly && <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-ink-secondary">这次制作的输入已锁定。点「修改输入」可调整素材、脚本、音色和包装；旧成片与导出包会保留。</p>
        {inputs?.editing.canRevise && <button type="button" className="btn-secondary" disabled={busy} onClick={() => void beginInputRevision()}>
          {busy ? '正在打开…' : '修改输入'}
        </button>}
      </div>}
      {inputs?.editing.revisionId && <p role="status" className="rounded-xl border border-hairline bg-surface-subtle p-3 text-sm text-ink">
        正在修改下一轮制作的输入。上一次成片仍可查看；第二步点「生成」后，使用新输入重新制作。
      </p>}
      {busy && <p role="status" className="text-sm text-ink-secondary">正在处理…</p>}
      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      {message && <p role="status" className="text-sm text-ok">{message}</p>}
      {step === 0 && inputs && <fieldset disabled={readOnly}><FormulaVideoImportPanel projectId={projectId} batchId={batchId} inputRevision={inputs.revision} readOnly={readOnly} onChanged={load} /></fieldset>}
      {step === 1 && <div className="card space-y-3 p-4">
        <h2 className="text-base font-semibold text-ink">导入脚本与公式</h2>
        <p className="text-sm text-ink-secondary">导入脚本表，保留原脚本序号、镜头顺序、目标时长和文案。</p>
        <label className={`inline-flex cursor-pointer items-center rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink focus-within:ring-2 focus-within:ring-accent ${controlsBusy || !inputs ? 'opacity-50' : 'hover:bg-surface-subtle'}`}>
          <span>选择{label}（XLSX）</span>
          <input type="file" accept=".xlsx" aria-label={`选择${label}`} disabled={controlsBusy || !inputs}
            onChange={event => { const file = event.target.files?.[0]; if (file) void preview(file); event.target.value = ''; }}
            className="sr-only" />
        </label>
        <p className="text-xs text-ink-tertiary">每个工作簿不超过 10 MiB、10,000 行、50 列。已配置脚本模型时，导入后自动识别列对应；也可手动修改。</p>
        {saved && <p className="text-sm text-ink-secondary">已保存：{saved.filename} · {saved.rows.length} 条{saved.excludedKeys.length ? ` · 已排除 ${saved.excludedKeys.length} 行` : ''}</p>}
        {saved && !session && <button type="button" className="btn-secondary" disabled={controlsBusy} onClick={() => void openScript()}>修改已保存脚本</button>}
      </div>}
      {step === 1 && session && <div className="card space-y-3 p-4">
        <p className="text-sm font-medium text-ink">待确认：{session.filename} · 共 {session.preview.rowCount} 行，可导入 {rows.length} 行</p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="表格识别模型" className="rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-ink"
            value={providerId || inputs?.aiProviders?.[0]?.id || ''} disabled={controlsBusy || aiRunning || !inputs?.aiProviders?.length} onChange={event => setProviderId(event.target.value)}>
            {!inputs?.aiProviders?.length && <option value="">暂无可用脚本模型</option>}
            {inputs?.aiProviders?.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}
          </select>
          <button type="button" className="btn-secondary" disabled={controlsBusy || aiRunning || !inputs?.aiProviders?.length} onClick={() => void modify('ai')}>
            {aiRunning ? 'AI 正在识别…' : session.extraction ? '重新用 AI 识别' : '用 AI 识别表头'}
          </button>
        </div>
        <p className="text-xs text-ink-secondary">AI 仅接收表头和前 20 行文字样本，用于判断列对应；全部资料由程序读取原表。没有模型时可直接手动选择列。</p>
        {session.extraction && <p role="status" className={`text-sm ${session.extraction.state === 'failed' ? 'text-fail' : 'text-ink-secondary'}`}>
          {session.extraction.manualOverride ? session.extraction.message : session.extraction.state === 'running' ? `正在识别表头：${session.extraction.completedSheets} / ${session.extraction.totalSheets} 个工作表`
            : session.extraction.state === 'completed' ? `已由 ${session.extraction.providerName} 识别列对应；${session.preview.issues.length ? '下方错误行仍需处理。' : '原表内容及后续手工修改均已保留。'}`
              : session.extraction.message}
        </p>}
        <FormulaColumnMapping key={`${session.id}:${session.draftRevision}`} session={session} busy={controlsBusy} onApply={mapping => void modify('mapping', mapping)} />
        {session.excludedKeys?.length > 0 && <p className="text-sm text-ink-secondary">保留此前排除的 {session.excludedKeys.length} 行；修正其中一行并保存后，该行会重新参加整表检查。</p>}
        {session.preview.issues.length > 0 && <>
          <ul className="max-h-48 space-y-1 overflow-auto text-sm text-fail">
            {session.preview.issues.map(issue => <li key={issue.key}>{issue.sheet} 第 {issue.row} 行：{issue.message}
              {session.excludedKeys?.includes(issue.key) && <span>（此前已排除）</span>}
              {step === 1 && scriptInputs.has(issue.key) && !scriptInputs.get(issue.key)!.blocked.length && <button type="button" className="btn-secondary ml-2" disabled={controlsBusy} onClick={() => void openScript(issue.key)}>修正第 {issue.row} 行</button>}
            </li>)}
          </ul>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={excludeErrors} disabled={controlsBusy} onChange={event => setExcludeErrors(event.target.checked)} />
            明确排除以上错误行，只导入其余资料
          </label>
        </>}
        <button type="button" className="btn-primary" disabled={controlsBusy || aiRunning || !rows.length || (unresolvedIssues.length > 0 && !excludeErrors)} onClick={() => void confirm()}>
          确认导入 {rows.length} 条
        </button>
      </div>}
      {editing && <FormulaScriptRowEditor key={`${editing.session.id}:${editing.session.draftRevision}:${editing.row.key}`} input={editing.row} busy={busy} onSave={values => void saveScript(values)} onClose={() => setEditing(null)} />}
      {step === 1 && inputs && <FormulaGenerationSettings projectId={projectId} batchId={batchId} inputRevision={inputs.revision}
        pendingImport={!!session} disabled={controlsBusy} onEdit={key => void openScript(key)} onGenerated={async () => {
          await onGenerated();
          await load();
          window.requestAnimationFrame(() => progressElement.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
        }} />}
      {step === 1 && session && rows.length > 0 && <div className="card overflow-x-auto p-4">
        <p className="mb-3 text-sm text-ink-secondary">导入预览 · {showAll ? rows.length : Math.min(rows.length, 20)} / {rows.length} 条</p>
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b border-hairline text-ink-secondary"><th className="p-2">编号</th><th className="p-2">内容</th><th className="p-2">来源</th></tr></thead>
          <tbody>{(showAll ? rows : rows.slice(0, 20)).map(row => <tr key={row.key} className="border-b border-hairline align-top text-ink">
            <td className="p-2">{'logicalCode' in row ? row.logicalCode : row.scriptNumber}</td>
            <td className="p-2">{'logicalCode' in row ? row.fields['画面描述'] : <><p>{row.codes.join(' → ')}</p><p className="mt-1 whitespace-pre-wrap text-ink-secondary">{row.bodyText}</p><p className="mt-1 text-xs text-ink-tertiary">{row.platform} · 目标 {row.targetDurationSec} 秒</p></>}</td>
            <td className="p-2 text-xs text-ink-tertiary">{row.source.sheet} 第 {row.source.row} 行
              {'scriptNumber' in row && <button type="button" className="btn-secondary mt-2" disabled={controlsBusy} onClick={() => void openScript(row.key)}>修改脚本 {row.scriptNumber}</button>}
              {!!scriptInputs.get(row.key)?.edits.length && <p className="mt-1">已手工修改</p>}
            </td>
          </tr>)}</tbody>
        </table>
        {rows.length > 20 && <button type="button" className="btn-secondary mt-3" onClick={() => setShowAll(value => !value)}>{showAll ? '收起' : `查看全部 ${rows.length} 条`}</button>}
      </div>}
      <p className="text-sm text-ink-secondary">{step === 0 ? '素材准备好后，进入第二步选择脚本、声音和包装，再点击生成。' : '制作中可以离开页面，已就绪的成片可先进入第三步检查。'}</p>
    </section>
  );
}
