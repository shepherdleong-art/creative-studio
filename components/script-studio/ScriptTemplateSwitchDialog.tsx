'use client';

import { useCallback, useRef, useState } from 'react';
import type { ScriptStudioTaskSnapshot } from '@/lib/script-studio/types';
import TemplateRewritePicker from './TemplateRewritePicker';

export default function ScriptTemplateSwitchDialog({
  projectId, scriptId, targetDurationSec, libraryRevisionId, providerId, onClose, onCreated,
}: {
  projectId: string;
  scriptId: string;
  targetDurationSec: number;
  libraryRevisionId: string;
  providerId: string;
  onClose: () => void;
  onCreated: (task: ScriptStudioTaskSnapshot) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const pendingAction = useRef<Record<string, unknown> | null>(null);

  const submit = useCallback(async () => {
    if (inFlight.current) return;
    if (!pendingAction.current && (!providerId || selectedIds.length !== 1)) {
      setError('请选择一个爆文模板，并确认已配置脚本模型');
      return;
    }
    // 断连 / 5xx 后保留完整请求身份；重试不创建第二个任务。
    if (!pendingAction.current) {
      pendingAction.current = {
        requestKey: `switch-template:${crypto.randomUUID()}`,
        libraryRevisionId,
        targetScriptId: scriptId,
        targetDurationSec,
        requestedCount: 1,
        productionMode: 'template_rewrite',
        templateEntryIds: [...selectedIds],
        providerId,
      };
    }
    inFlight.current = true;
    setSubmitting(true);
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/projects/${projectId}/script-studio/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingAction.current),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && response.status === 202) {
        pendingAction.current = null;
        setPending(false);
        onCreated(data.task as ScriptStudioTaskSnapshot);
      } else {
        if (response.status >= 400 && response.status < 500) {
          pendingAction.current = null;
          setPending(false);
        }
        setError(data.message || data.error || `提交失败：HTTP ${response.status}，请重试`);
      }
    } catch {
      setError('连接中断，提交结果尚未确认。请重试本次提交。');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [projectId, scriptId, targetDurationSec, libraryRevisionId, providerId, selectedIds, onCreated]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-media-scrim p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="switch-template-title" className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-[18px] border border-hairline bg-surface shadow-xl">
        <div className="border-b border-hairline p-5">
          <h3 id="switch-template-title" className="text-base font-semibold">更换爆文模板</h3>
          <p className="mt-1 text-xs text-ink-secondary">选择一个模板，复用当前卖点库，为这条脚本生成新版本。原版本可在版本历史中查看。</p>
        </div>
        <div className="overflow-y-auto p-5">
          <TemplateRewritePicker projectId={projectId} libraryRevisionId={libraryRevisionId} selectedIds={selectedIds} onChange={setSelectedIds} maxCount={1} disabled={submitting || pending} />
        </div>
        <div className="space-y-3 border-t border-hairline p-5">
          {error && <p role="alert" className="text-sm text-fail">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={submitting} onClick={onClose}>{pending ? '关闭' : '取消'}</button>
            <button type="button" className="btn-primary" disabled={submitting || (!pending && (!providerId || selectedIds.length !== 1))} onClick={() => void submit()}>
              {submitting ? '正在提交…' : pending ? '重试本次提交' : '按新模板生成一版'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
