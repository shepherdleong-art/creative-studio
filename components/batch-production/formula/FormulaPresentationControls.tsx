'use client';

import { useRef, useState } from 'react';
import type { BatchOutputClipEditView } from '@/lib/batch-production/output-arrangement';

type Edit = (planId: string, edit: Record<string, unknown>) => Promise<boolean>;

export function FormulaPresentationLocks({ view, onEdit }: { view: BatchOutputClipEditView; onEdit: Edit }) {
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [pendingLock, setPendingLock] = useState<{ target: 'packaging' | 'cover'; locked: boolean } | null>(null);
  if (!view.presentationLocks) return null;
  return <fieldset disabled={!view.editable || saving} className="mb-3 rounded-xl border border-hairline bg-surface-subtle p-3 text-xs text-ink">
    <legend className="px-1 font-semibold">保留这条的效果</legend>
    <div className="flex flex-wrap gap-3">
      {(['packaging', 'cover'] as const).map(target => <label key={target} className="flex items-center gap-1.5">
        <input type="checkbox" checked={pendingLock?.target === target ? pendingLock.locked : view.presentationLocks![target]} onChange={async event => {
          if (pending.current) return;
          const locked = event.target.checked;
          pending.current = true; setSaving(true); setPendingLock({ target, locked });
          try { await onEdit(view.planId, { type: 'set_presentation_lock', target, locked,
            expectedEditRevision: view.editRevision, expectedOutputVersionId: view.outputVersionId }); }
          finally { pending.current = false; setSaving(false); setPendingLock(null); }
        }} />锁定{target === 'packaging' ? '包装' : '封面'}
      </label>)}
    </div>
    {saving && <p role="status" className="mt-2 text-ink-secondary">正在保存锁定设置…</p>}
    <p className="mt-2 text-ink-secondary">手动修改会自动锁定对应部分。锁定后，批量重新分配会跳过它；仍可继续单独修改。</p>
    <p className="mt-1 text-ink-secondary">包装模板也影响封面效果，全部保留请同时锁定两项。</p>
  </fieldset>;
}

export function FormulaPresentationBatchAction({ views, loading, onEdit }: { views: BatchOutputClipEditView[]; loading: boolean; onEdit: Edit }) {
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const eligible = views.filter(view => view.editable && view.outputVersionId && view.presentationLocks
    && (!view.presentationLocks.packaging || !view.presentationLocks.cover));
  return <div className="text-xs text-ink-secondary">
    <button type="button" disabled={loading || saving || !eligible.length}
      className="rounded-lg border border-hairline bg-surface px-3 py-1.5 text-ink disabled:opacity-50"
      title="处理本批已生成成片，按本次制作保存的候选重新分配。锁定部分跳过，效果改变后需重新确认。"
      onClick={async () => {
        if (pending.current || loading) return;
        pending.current = true; setSaving(true); setMessage('');
        let succeeded = 0, failed = 0;
        try {
          for (const view of eligible) {
            const ok = await onEdit(view.planId, { type: 'reassign_presentation',
              expectedEditRevision: view.editRevision, expectedOutputVersionId: view.outputVersionId });
            if (ok) succeeded++; else failed++;
          }
          setMessage(`已处理 ${succeeded} 条，锁定部分已跳过。${failed ? `${failed} 条未完成，请重新读取后重试。` : '效果有变化的成片需重新确认。'}`);
        } finally { pending.current = false; setSaving(false); }
      }}>{loading ? '正在读取本批成片…' : saving ? '重新分配中…' : `本批重新分配未锁定项（${eligible.length} 条）`}</button>
    <p className="mt-1">只分配包装和封面；文字、封面帧与花字时间保留。</p>
    {message && <p role="status" className="mt-1 max-w-sm">{message}</p>}
  </div>;
}
