'use client';

import { useState } from 'react';
import type { FinalEditGroupView } from '@/lib/final-edit/types';
import styles from './mixcut-shell.module.css';

const templates = [
  ['overlay-poster', 'f1 花字种草'], ['overlay-journal', 'f2 手账拼贴'],
  ['overlay-minimal', 'f3 极简高级'], ['overlay-variety', 'f4 综艺撕纸'],
] as const;

export function AdoptFilmStep({ group, onGroupChange }: { group: FinalEditGroupView; onGroupChange: (group: FinalEditGroupView) => void }) {
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const adopt = async () => {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/final-edit-groups/${group.id}/use-mixcut`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, expectedRevision: group.variants[0].revision, expectedGroupRevision: group.revision }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || '打开智能混剪失败');
      onGroupChange(body);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <main className={styles.mainCol}><section className="card m-4 p-6">
    <h3 className="mb-3 text-lg font-semibold">选择包装，继续智能混剪</h3>
    <p className="mb-4">这条历史成片使用了独立包装。选择你的预设后，将保留镜头、配音、字幕和卖点文案，在智能混剪中继续编辑；原圆点引线和片尾装饰改用所选模板，请在预览中检查版式。</p>
    <select aria-label="接管包装预设" value={template} disabled={busy} onChange={event => setTemplate(event.target.value)}>
      <option value="">选择包装预设</option>
      {templates.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select>
    <button type="button" className="btn-primary ml-3" disabled={!template || busy} onClick={() => void adopt()}>{busy ? '正在打开…' : '进入智能混剪'}</button>
    {message && <p role="alert" className="mt-3">{message}</p>}
  </section></main>;
}
