'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  MANUAL_SCRIPT_BATCH_MAX,
  MANUAL_SCRIPT_BODY_MAX,
  MANUAL_SCRIPT_PASTE_CHARS_MAX,
  MANUAL_SCRIPT_TITLE_MAX,
  splitPastedScripts,
} from '@/lib/batch-production/manual-script-import';

/** 编辑场景预填的脚本内容(来自准备区的 PrepareScriptView)。 */
export interface ManualScriptDraft {
  id: string;
  title: string;
  bodyText: string;
  targetDurationSec: number;
}

interface BatchScriptImportDialogProps {
  open: boolean;
  projectId: string;
  /** 传入时为「编辑手动脚本」(提交走 PUT),否则为「导入自定义脚本」(POST)。 */
  editScript?: ManualScriptDraft | null;
  onClose: () => void;
  onCreated: () => void;
  onUpdated: (scriptId: string) => void;
}

interface CreatedResponse {
  created?: Array<{ id: string; title: string }>;
  error?: string;
  message?: string;
}

const inputClass = 'h-9 w-full rounded-xl border border-hairline bg-surface px-3 text-sm text-ink';
// components/batch-production/ 下第一个 textarea:样式沿用本区输入框惯例,
// 去掉 h-9、补 py-2(参考 components/ScriptSellingPointInput.tsx 的排版)。
const textareaClass = 'w-full rounded-xl border border-hairline bg-surface px-3 py-2 text-sm leading-6 text-ink';

export function BatchScriptImportDialog(props: BatchScriptImportDialogProps) {
  if (!props.open) return null;
  // key 保证切换编辑目标/新建时表单状态完全重置(同 ProjectInfoDialog)。
  return <BatchScriptImportDialogContent key={props.editScript?.id ?? 'create'} {...props} />;
}

function BatchScriptImportDialogContent({
  projectId,
  editScript,
  onClose,
  onCreated,
  onUpdated,
}: BatchScriptImportDialogProps) {
  const editing = Boolean(editScript);
  const [tab, setTab] = useState<'single' | 'batch'>('single');
  const [title, setTitle] = useState(editScript?.title ?? '');
  const [bodyText, setBodyText] = useState(editScript?.bodyText ?? '');
  const [durationSec, setDurationSec] = useState(String(editScript?.targetDurationSec ?? 15));
  const [pasteText, setPasteText] = useState('');
  const [pasteDurationSec, setPasteDurationSec] = useState('15');
  const [pastePreviewOpen, setPastePreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // 焦点/Escape 处理照 BatchStepMaterials.tsx 的画质弹窗:打开时聚焦关闭钮,
  // Escape 关闭(保存中不关,避免请求落地后状态丢失)。
  useEffect(() => {
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, saving]);

  const parsedPaste = useMemo(
    () => (tab === 'batch' && !editing ? splitPastedScripts(pasteText) : []),
    [tab, editing, pasteText],
  );

  function parseDuration(raw: string): number | null {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 600) return null;
    return value;
  }

  function validateEntry(entry: { title: string; bodyText: string }, index?: number): string | null {
    const where = index === undefined ? '' : `第 ${index + 1} 条`;
    if (!entry.title.trim()) return `${where}标题不能为空`;
    if (entry.title.trim().length > MANUAL_SCRIPT_TITLE_MAX) return `${where}标题不能超过 ${MANUAL_SCRIPT_TITLE_MAX} 字`;
    if (!entry.bodyText.trim()) return `${where}正文不能为空`;
    if (entry.bodyText.trim().length > MANUAL_SCRIPT_BODY_MAX) return `${where}正文不能超过 ${MANUAL_SCRIPT_BODY_MAX} 字`;
    return null;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;

    let scripts: Array<{ title: string; bodyText: string; targetDurationSec: number }>;
    if (editing || tab === 'single') {
      const duration = parseDuration(durationSec);
      const entry = { title: title.trim(), bodyText: bodyText.trim() };
      const invalid = validateEntry(entry);
      if (invalid) { setError(invalid); return; }
      if (duration === null) { setError('目标时长必须是 1-600 的整数秒'); return; }
      scripts = [{ ...entry, targetDurationSec: duration }];
    } else {
      if (pasteText.length > MANUAL_SCRIPT_PASTE_CHARS_MAX) {
        setError(`粘贴内容不能超过 ${MANUAL_SCRIPT_PASTE_CHARS_MAX.toLocaleString()} 字`);
        return;
      }
      if (parsedPaste.length === 0) { setError('没有识别到有效脚本，请按空行分隔多条文案'); return; }
      if (parsedPaste.length > MANUAL_SCRIPT_BATCH_MAX) {
        setError(`一次最多导入 ${MANUAL_SCRIPT_BATCH_MAX} 条，当前识别到 ${parsedPaste.length} 条`);
        return;
      }
      const duration = parseDuration(pasteDurationSec);
      if (duration === null) { setError('统一时长必须是 1-600 的整数秒'); return; }
      for (const [index, entry] of parsedPaste.entries()) {
        const invalid = validateEntry(entry, index);
        if (invalid) { setError(invalid); return; }
      }
      scripts = parsedPaste.map((entry) => ({
        title: entry.title.trim(),
        bodyText: entry.bodyText.trim(),
        targetDurationSec: duration,
      }));
    }

    setSaving(true);
    setError('');
    try {
      if (editing && editScript) {
        const response = await fetch(
          `/api/batch-production/scripts/${encodeURIComponent(editScript.id)}?projectId=${encodeURIComponent(projectId)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(scripts[0]),
          },
        );
        const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
        if (!response.ok) throw new Error(body.message || body.error || `保存失败（HTTP ${response.status}）`);
        onUpdated(editScript.id);
      } else {
        const response = await fetch('/api/batch-production/scripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, scripts }),
        });
        const body = await response.json().catch(() => ({})) as CreatedResponse;
        if (!response.ok || !Array.isArray(body.created)) {
          throw new Error(body.message || body.error || `导入失败（HTTP ${response.status}）`);
        }
        onCreated();
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  const batchTab = !editing && tab === 'batch';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-script-import-title"
        className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-surface shadow-xl"
      >
        <form onSubmit={(event) => void submit(event)}>
          <header className="flex items-start justify-between gap-4 px-5 pb-4 pt-5">
            <div>
              <h3 id="batch-script-import-title" className="font-semibold text-ink">
                {editing ? '编辑手动脚本' : '导入自定义脚本'}
              </h3>
              <p className="mt-1 text-sm text-ink-secondary">
                {editing
                  ? '修改标题、正文或目标时长；若该脚本已在本批次选中，保存后需要重新确认输入。'
                  : '在别处写好的文案粘贴进来，导入后本项目的所有批次都能勾选。'}
              </p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="关闭自定义脚本弹窗"
              className="icon-btn -mr-1 -mt-1 shrink-0"
              disabled={saving}
              onClick={onClose}
            >
              <Icon name="close" size={17} />
            </button>
          </header>

          {!editing && (
            <div className="flex gap-2 px-5 pb-4" role="tablist" aria-label="导入方式">
              {(['single', 'batch'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  aria-label={value === 'single' ? '单条导入' : '批量粘贴'}
                  className={`h-8 rounded-full px-4 text-xs transition ${tab === value ? 'bg-ink text-white' : 'bg-surface-subtle text-ink-secondary hover:text-ink'}`}
                  onClick={() => { setTab(value); setError(''); }}
                >
                  {value === 'single' ? '单条' : '批量粘贴'}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-4 px-5 pb-5">
            {!batchTab ? (
              <>
                <label className="grid gap-1.5 text-[13px] font-medium text-ink">
                  <span>标题 <span className="text-fail">*</span></span>
                  <input
                    className={inputClass}
                    aria-label="脚本标题"
                    value={title}
                    disabled={saving}
                    maxLength={MANUAL_SCRIPT_TITLE_MAX}
                    placeholder="例如：奶油风软床种草"
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <label className="grid gap-1.5 text-[13px] font-medium text-ink">
                  <span>正文 <span className="text-fail">*</span></span>
                  <textarea
                    className={textareaClass}
                    aria-label="脚本正文"
                    rows={7}
                    value={bodyText}
                    disabled={saving}
                    placeholder="粘贴或书写口播正文…"
                    onChange={(event) => setBodyText(event.target.value)}
                  />
                </label>
                <label className="grid gap-1.5 text-[13px] font-medium text-ink">
                  <span>目标时长（秒）</span>
                  <input
                    type="number"
                    className={inputClass}
                    aria-label="目标时长（秒）"
                    min={1}
                    max={600}
                    step={1}
                    value={durationSec}
                    disabled={saving}
                    onChange={(event) => setDurationSec(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="grid gap-1.5 text-[13px] font-medium text-ink">
                  <span>批量粘贴（空行分隔多条，每条首行作标题）</span>
                  <textarea
                    className={textareaClass}
                    aria-label="批量粘贴脚本"
                    rows={10}
                    value={pasteText}
                    disabled={saving}
                    placeholder={'标题一\n正文第一行\n正文第二行\n\n标题二\n正文……'}
                    onChange={(event) => setPasteText(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-ink-secondary" aria-live="polite">
                    识别到 {parsedPaste.length} 条（单次最多 {MANUAL_SCRIPT_BATCH_MAX} 条）
                  </p>
                  {parsedPaste.length > 0 && (
                    <button
                      type="button"
                      className="text-xs text-accent underline"
                      aria-expanded={pastePreviewOpen}
                      onClick={() => setPastePreviewOpen((open) => !open)}
                    >
                      {pastePreviewOpen ? '收起预览' : '逐条预览'}
                    </button>
                  )}
                </div>
                {pastePreviewOpen && parsedPaste.length > 0 && (
                  <ul className="max-h-56 space-y-2 overflow-y-auto rounded-xl bg-surface-subtle p-3">
                    {parsedPaste.map((entry, index) => (
                      <li key={index} className="text-xs leading-5">
                        <p className="font-medium text-ink">{index + 1}. {entry.title || '（无标题）'}</p>
                        <p className="line-clamp-2 whitespace-pre-wrap text-ink-secondary">{entry.bodyText}</p>
                      </li>
                    ))}
                  </ul>
                )}
                <label className="grid gap-1.5 text-[13px] font-medium text-ink">
                  <span>统一目标时长（秒）</span>
                  <input
                    type="number"
                    className={inputClass}
                    aria-label="统一目标时长（秒）"
                    min={1}
                    max={600}
                    step={1}
                    value={pasteDurationSec}
                    disabled={saving}
                    onChange={(event) => setPasteDurationSec(event.target.value)}
                  />
                </label>
              </>
            )}
          </div>

          <div className="min-h-5 px-5 pb-3" aria-live="polite">
            {error && <p className="text-[13px] text-fail">{error}</p>}
          </div>

          <footer className="flex items-center justify-end gap-3 border-t border-hairline px-5 py-4">
            <button type="button" className="btn-secondary" disabled={saving} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? '提交中…' : editing ? '保存' : batchTab ? `导入 ${parsedPaste.length} 条` : '导入'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
