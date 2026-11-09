'use client';

import { useState } from 'react';
import { teamError, teamWrite } from './client';

export default function ResolveErrorButton({ errorId, onResolved }: {
  errorId: string;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function resolve() {
    setBusy(true);
    setError('');
    try {
      const response = await teamWrite(`/api/team/errors/${encodeURIComponent(errorId)}/resolve`, { method: 'POST' });
      if (!response.ok) throw new Error(await teamError(response, '标记已处理失败'));
      onResolved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '标记已处理失败');
    } finally {
      setBusy(false);
    }
  }
  return <div className="flex flex-col items-start gap-1">
    <button className="cap" type="button" disabled={busy} onClick={() => void resolve()}>
      {busy ? '正在保存…' : '标记已处理'}
    </button>
    {error && <span role="alert" className="text-label text-fail">{error}</span>}
  </div>;
}
