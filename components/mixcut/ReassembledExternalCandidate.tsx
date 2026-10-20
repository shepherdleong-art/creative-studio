'use client';

import { useEffect, useState } from 'react';
import type { FinalEditExternalAssetView } from '@/lib/final-edit/types';
import type { ReworkCommand } from '@/lib/final-edit/reassembled/rework';

async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error || '操作失败');
  return body;
}

export function ReassembledExternalCandidate({ projectId, shotSetId, groupId, clipId, onClose, onRegistered }: {
  projectId: string; shotSetId: string; groupId: string; clipId: string;
  onClose: () => void; onRegistered: () => Promise<void>;
}) {
  const [assets, setAssets] = useState<FinalEditExternalAssetView[]>([]);
  const [assetId, setAssetId] = useState('');
  const [revision, setRevision] = useState<number | null>(null);
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<ReworkCommand | null>(null);
  const materialUrl = `/api/projects/${encodeURIComponent(projectId)}/final-edit/shot-sets/${encodeURIComponent(shotSetId)}/external-assets`;
  const reworkUrl = `/api/final-edit-groups/${encodeURIComponent(groupId)}/rework/${encodeURIComponent(clipId)}`;
  const selected = assets.find(asset => asset.id === assetId);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch(materialUrl).then(response => read<{ assets: FinalEditExternalAssetView[] }>(response)),
      fetch(reworkUrl).then(response => read<{ revision: number }>(response)),
    ]).then(([materials, shot]) => {
      if (!cancelled) { setAssets(materials.assets); setRevision(shot.revision); }
    }).catch(error => { if (!cancelled) setMessage(String(error)); });
    return () => { cancelled = true; };
  }, [materialUrl, reworkUrl]);
  const choose = (id: string, choices = assets) => {
    setAssetId(id); setStart('0'); setEnd(String((choices.find(asset => asset.id === id)?.durationUs || 0) / 1e6));
  };
  const register = async () => {
    if (revision === null) return;
    const command: ReworkCommand = pending || { type: 'register_external', requestId: crypto.randomUUID(), expectedRevision: revision, externalAssetId: assetId, approvedRangeSec: [Number(start), Number(end)] };
    setPending(command); setBusy(true); setMessage('');
    try {
      const response = await fetch(reworkUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      if (response.status < 500) setPending(null);
      await read(response);
      setPending(null); await onRegistered();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section aria-label="登记外部视频候选">
    <h3>为镜头 {clipId} 添加视频</h3>
    <p>上传后先预览并填写可用区间。登记仅增加候选；回到镜头编辑后，明确选择并替换才改变成片。</p>
    <label>上传新视频 <input aria-label="上传新视频" type="file" accept="video/*" disabled={busy || !!pending || revision === null} onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      e.target.value = ''; setBusy(true); setMessage('');
      try {
        const form = new FormData(); form.append('file', file);
        const uploaded = await read<{ assets: FinalEditExternalAssetView[]; errors: Array<{ message: string }> }>(await fetch(materialUrl, { method: 'POST', body: form }));
        const next = await read<{ assets: FinalEditExternalAssetView[] }>(await fetch(materialUrl));
        setAssets(next.assets);
        if (uploaded.assets[0]) choose(uploaded.assets[0].id, next.assets);
        setMessage(uploaded.errors.map(error => error.message).join('；') || '上传成功，请预览并核对可用区间。');
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }} /></label>
    <label>本组外部视频 <select aria-label="本组外部视频" value={assetId} disabled={busy || !!pending} onChange={e => choose(e.target.value)}>
      <option value="">选择视频</option>
      {assets.filter(asset => asset.status === 'ready').map(asset => <option key={asset.id} value={asset.id}>{asset.originalFilename}</option>)}
    </select></label>
    {selected && <video controls preload="metadata" src={selected.previewUrl} style={{ width: '100%', maxHeight: 300 }} />}
    <form onSubmit={e => { e.preventDefault(); void register(); }}>
      <label>已审核起点（秒）<input aria-label="外部视频审核起点" type="number" min="0" step="any" required disabled={busy || !!pending} value={start} onChange={e => setStart(e.target.value)} /></label>
      <label>已审核终点（秒）<input aria-label="外部视频审核终点" type="number" min="0" step="any" required disabled={busy || !!pending} value={end} onChange={e => setEnd(e.target.value)} /></label>
      <button type="submit" className="btn-primary" disabled={busy || !assetId || revision === null}>{pending ? '重试原登记请求' : '登记为本镜头候选'}</button>
      <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>关闭素材登记</button>
    </form>
    <p role="status">{message}</p>
    {pending && <p>尚未确认提交结果。重试将复用原请求，不会重复登记；修改参数前请先确认结果。</p>}
  </section>;
}
