'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { FinalEditGroupView, TimelineClip } from '@/lib/final-edit/types';
import type { VariantCommandInput } from '@/components/final-edit/command-types';
import { MixcutTimeline } from './MixcutTimeline';
import { TrimEditor } from './TrimEditor';
import styles from './mixcut-content.module.css';

async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error);
  return body;
}
export function ReassembledPreviewStep({ group, onGroupChange, onExport }: {
  group: FinalEditGroupView; onGroupChange: (group: FinalEditGroupView) => void; onExport: (id: string) => void;
}) {
  const searchParams = useSearchParams();
  const variant = group.variants[0], film = group.reassembled!;
  const [selectedId, setSelectedId] = useState(variant.timeline.clips[0]?.id || '');
  const [candidateId, setCandidateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [playhead, setPlayhead] = useState(0);
  const [trim, setTrim] = useState<TimelineClip | null>(null);
  const [jobId, setJobId] = useState(group.jobs.find(j => j.kind === 'film-preview' && ['queued', 'running'].includes(j.status))?.id || '');
  const [jobStatus, setJobStatus] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef(group);
  useEffect(() => { current.current = group; }, [group]);
  const clip = variant.timeline.clips.find(c => c.id === selectedId);
  const candidates = group.assets.filter(a => film.candidates.some(c => c.clipId === selectedId && c.videoJobId === a.videoJobId));
  const selectedCandidate = candidates.find(a => a.videoJobId === candidateId) || candidates[0];
  const ordered = [...variant.timeline.clips].sort((a, b) => a.timelineInFrame - b.timelineInFrame);
  const previewCurrent = film.previewRevision === variant.revision;
  const reload = async () => {
    const next = await read<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${group.id}`, { cache: 'no-store' }));
    onGroupChange(next);
  };
  const apply = async (command: VariantCommandInput): Promise<boolean> => {
    setBusy(true); setMessage('');
    try {
      const latest = current.current.variants[0];
      await read(await fetch(`/api/final-edit-variants/${latest.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...command, expectedRevision: latest.revision }) }));
      await reload(); setMessage('镜头修改已保存。可选生成完整包装预览，或直接导出新版。'); return true;
    } catch (error) { setMessage(String(error instanceof Error ? error.message : error)); await reload(); return false; }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const job = await read<{ status: string; phase: string; errorMessage?: string }>(await fetch(`/api/final-edit-jobs/${jobId}`, { cache: 'no-store' }));
        if (cancelled) return;
        setJobStatus(job.status); setMessage(job.errorMessage || `预览：${job.phase}`);
        if (job.status === 'succeeded') {
          const next = await read<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${group.id}`, { cache: 'no-store' }));
          if (!cancelled) { onGroupChange(next); setMessage('带包装预览已生成，请检查字幕、标签和人物避让。'); }
        } else if (['queued', 'running'].includes(job.status)) timer = setTimeout(poll, 1200);
      } catch (error) { if (!cancelled) setMessage(String(error)); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId, group.id, onGroupChange]);
  const startPreview = async () => {
    setBusy(true);
    try {
      const result = await read<{ id: string; status: string }>(await fetch(`/api/final-edit-groups/${group.id}/film-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variantId: variant.id, expectedGroupRevision: group.revision, expectedVariantRevision: variant.revision }) }));
      if (result.status === 'failed') {
        await read(await fetch(`/api/final-edit-jobs/${result.id}/retry`, { method: 'POST' }));
      }
      setJobId(result.id); setJobStatus('queued');
      // A retry of the same job needs a fresh poll even if its id has not changed.
      if (result.id === jobId) { setJobId(''); setTimeout(() => setJobId(result.id), 0); }
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const unsupported = async () => { setMessage('本阶段保留配音、字幕和包装，只编辑镜头截取位置与顺序。'); return false; };
  const seek = (seconds: number) => { setPlayhead(seconds); if (video.current) video.current.currentTime = seconds; };
  return <main className={styles.mainCol} style={{ gridColumn: '2 / -1', gridRow: 1, minWidth: 0, overflow: 'auto', padding: 20, gap: 8 }} data-testid="film-editor">
    <h2 className={styles.stepTitle}>实拍成片 · {group.script.title}</h2>
    <p>已交付 v{film.deliveryVersion}（编辑版本 {film.deliveredRevision}） · 当前编辑版本 {variant.revision}</p>
    <p>{previewCurrent ? '下方是当前编辑的完整包装预览。' : `镜头已修改，下方仍是编辑版本 ${film.previewRevision} 的历史画面。可重新生成预览，也可直接导出新版。`}</p>
    {searchParams.get('deliveryVersion') && Number(searchParams.get('deliveryVersion')) !== film.deliveryVersion && <p role="status">你从旧版审片链接进入；这里显示当前保存的编辑，旧版文件保留在交付记录中。</p>}
    <video ref={video} controls src={variant.previewUrl || undefined} onTimeUpdate={() => setPlayhead(video.current?.currentTime || 0)} preload="metadata" style={{ width: '100%', height: 'min(42vh, 440px)', flexShrink: 0, objectFit: 'contain', background: 'var(--color-surface-subtle)', borderRadius: 12 }} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '16px 0' }}>
      <button className="btn-secondary" disabled={busy || ['queued', 'running'].includes(jobStatus)} onClick={() => void startPreview()}>生成带包装预览</button>
      {['queued', 'running', 'failed'].includes(jobStatus) && <button className="btn-secondary" onClick={async () => { try { await read(await fetch(`/api/final-edit-jobs/${jobId}/cancel`, { method: 'POST' })); setJobStatus('cancelled'); } catch (error) { setMessage(String(error)); } }}>取消预览任务</button>}
      <button className="btn-primary" disabled={busy} onClick={() => onExport(variant.id)}>导出新版本</button>
      <a href={film.reviewUrl} target="_blank" rel="noopener">打开审片页</a>
    </div>
    <p role="status" data-testid="film-message">{message}</p>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
      <label>镜头 <select aria-label="选择镜头" value={selectedId} onChange={e => { setSelectedId(e.target.value); setCandidateId(''); }}>{ordered.map((c, i) => <option key={c.id} value={c.id}>{i + 1}. {c.id}</option>)}</select></label>
      <label>已有候选 <select aria-label="已有候选" value={selectedCandidate?.videoJobId || ''} onChange={e => setCandidateId(e.target.value)}>{candidates.map(c => <option key={c.videoJobId} value={c.videoJobId}>{c.displayName}</option>)}</select></label>
      <button className="btn-secondary" disabled={busy || !clip || !selectedCandidate} onClick={() => {
        if (!clip || !selectedCandidate) return;
        const approved = film.candidates.find(c => c.videoJobId === selectedCandidate.videoJobId)!;
        const start = Math.ceil(approved.approvedRangeSec[0] * 24);
        void apply({ type: 'replace_clip', clipId: clip.id, videoJobId: selectedCandidate.videoJobId, sourceFingerprint: selectedCandidate.fingerprint, sourceInFrame: start, sourceOutFrame: start + clip.sourceOutFrame - clip.sourceInFrame });
      }}>替换镜头</button>
      <button className="btn-secondary" disabled={busy || !clip} onClick={() => clip && setTrim(clip)}>调整截取位置</button>
      {[-1, 1].map(delta => <button className="btn-secondary" key={delta} disabled={busy || !clip || !ordered[ordered.findIndex(c => c.id === clip.id) + delta]} onClick={() => {
        const index = ordered.findIndex(c => c.id === clip?.id); if (index < 0 || !ordered[index + delta]) return;
        void apply({ type: 'swap_clips', leftClipId: ordered[index].id, rightClipId: ordered[index + delta].id });
      }}>{delta < 0 ? '前移' : '后移'}</button>)}
    </div>
    {trim && <TrimEditor key={`${trim.id}:${variant.revision}`} clip={trim} clipIndex={ordered.findIndex(c => c.id === trim.id)} asset={group.assets.find(a => a.videoJobId === trim.videoJobId) || null} disabled={busy} onClose={() => setTrim(null)} onCommit={async (sourceInFrame, sourceOutFrame) => {
      const result = await apply({ type: 'trim_clip', clipId: trim.id, sourceInFrame, sourceOutFrame, timelineInFrame: trim.timelineInFrame, timelineOutFrame: trim.timelineOutFrame }); if (result) setTrim(null); return result;
    }} />}
    <MixcutTimeline variant={variant} cues={group.subtitleCues} assets={group.assets} selectedClipId={selectedId} selectedCueId="" playheadSec={playhead} disabled={busy}
      onTogglePlay={() => { if (video.current?.paused) void video.current.play(); else video.current?.pause(); }} onSeek={seek} onSelectClip={setSelectedId} onSelectCue={() => void unsupported()}
      onVariantCommand={apply} onGroupCommand={unsupported} onTrimClip={setTrim} onEditCueText={() => void unsupported()}
      narrationPlaybackRate={1} narrationDurationSec={variant.timeline.bodyFrames / 24} onNarrationPlaybackRatePreview={() => void unsupported()} onNarrationPlaybackRateCommit={() => void unsupported()}
      bgmTrackName="原片音乐" pointCues={[]} coverSec={20 / 24} selectedPointId="" packagingEnabled={false} packagingTemplate={film.template} activeCueText="" onSelectPoint={() => void unsupported()} onPointsChange={() => void unsupported()} />
  </main>;
}
