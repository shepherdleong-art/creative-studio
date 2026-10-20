'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { FinalEditGroupView, TimelineClip } from '@/lib/final-edit/types';
import type { VariantCommandInput } from '@/components/final-edit/command-types';
import { MixcutTimeline } from './MixcutTimeline';
import { TrimEditor } from './TrimEditor';
import { ReassembledContentEditor } from './ReassembledContentEditor';
import { ReassembledExternalCandidate } from './ReassembledExternalCandidate';
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
  const [selectedId, setSelectedId] = useState(searchParams.get('filmClip') || variant.timeline.clips[0]?.id || '');
  const [candidateId, setCandidateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [contentOpen, setContentOpen] = useState(false);
  const [contentProposalId, setContentProposalId] = useState('');
  const [historyRevision, setHistoryRevision] = useState('');
  const [playhead, setPlayhead] = useState(0);
  const [trim, setTrim] = useState<(TimelineClip & { editRevision: number }) | null>(null);
  const [speedDraft, setSpeedDraft] = useState<{ clipId: string; revision: number; rate: string } | null>(null);
  const [durationDraft, setDurationDraft] = useState<{ clipId: string; revision: number; frames: string; oldFrames: number; totalFrames: number; following: number } | null>(null);
  const [externalClipId, setExternalClipId] = useState('');
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
  const contentProposal = film.proposals.find(p => p.id === contentProposalId);
  const reload = async () => {
    const next = await read<FinalEditGroupView>(await fetch(`/api/final-edit-groups/${group.id}`, { cache: 'no-store' }));
    onGroupChange(next);
  };
  const apply = async (command: VariantCommandInput, expectedRevision?: number): Promise<boolean> => {
    setBusy(true); setMessage('');
    try {
      const latest = current.current.variants[0];
      await read(await fetch(`/api/final-edit-variants/${latest.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...command, expectedRevision: expectedRevision ?? latest.revision }) }));
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
  const unsupported = async () => { setMessage('请使用“编辑包装、字幕与音乐”保存内容；音轨剪切和变速尚未接入。'); return false; };
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
      <button className="btn-primary" disabled={busy || contentOpen} onClick={() => onExport(variant.id)}>导出新版本</button>
      <button className="btn-secondary" disabled={busy || contentOpen} onClick={() => { setContentProposalId(''); setContentOpen(true); }}>编辑包装、字幕与音乐</button>
      <a href={film.reviewUrl} target="_blank" rel="noopener">打开审片页</a>
      <label>历史编辑 <select aria-label="历史编辑" value={historyRevision} onChange={e => setHistoryRevision(e.target.value)}><option value="">选择版本</option>{film.history.filter(h => h.revision !== variant.revision).map(h => <option key={h.revision} value={h.revision}>编辑版本 {h.revision} · {h.createdAt}</option>)}</select></label>
      <button className="btn-secondary" disabled={busy || contentOpen || historyRevision === ''} onClick={() => void apply({ type: 'restore_revision', revision: Number(historyRevision) })}>恢复所选编辑版本</button>
    </div>
    <p role="status" data-testid="film-message">{message}</p>
    {film.proposals.filter(p => p.status === 'ready').map(p => <div key={p.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}><p>内容提案：{p.summary} · 基于编辑版本 {p.baseRevision}{p.baseRevision !== variant.revision ? '（已过期，不能覆盖当前修改）' : ''}</p><button className="btn-secondary" disabled={busy || contentOpen || p.baseRevision !== variant.revision} onClick={() => { setContentProposalId(p.id); setContentOpen(true); }}>查看并编辑提案</button></div>)}
    {contentOpen && <ReassembledContentEditor initial={contentProposal?.content || film.content} original={film.originalContent} revision={contentProposal?.baseRevision ?? variant.revision} busy={busy} onClose={() => setContentOpen(false)} onSave={(content, revision) => apply({ type: 'set_film_content', content, ...(contentProposalId ? { proposalId: contentProposalId } : {}) }, revision)} />}
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
      <label>镜头 <select aria-label="选择镜头" value={selectedId} onChange={e => { setSelectedId(e.target.value); setCandidateId(''); }}>{ordered.map((c, i) => <option key={c.id} value={c.id}>{i + 1}. {c.id}</option>)}</select></label>
      {clip && <Link href={`/projects/${group.projectId}?tab=storyboard&filmGroup=${group.id}&filmShotSet=${group.shotSetId}&filmClip=${encodeURIComponent(clip.id)}`}>返工这个镜头</Link>}
      <label>已有候选 <select aria-label="已有候选" value={selectedCandidate?.videoJobId || ''} onChange={e => setCandidateId(e.target.value)}>{candidates.map(c => <option key={c.videoJobId} value={c.videoJobId}>{c.displayName}</option>)}</select></label>
      <button className="btn-secondary" disabled={busy || !clip || !selectedCandidate} onClick={() => {
        if (!clip || !selectedCandidate) return;
        const approved = film.candidates.find(c => c.videoJobId === selectedCandidate.videoJobId)!;
        const start = Math.ceil(approved.approvedRangeSec[0] * 24);
        void apply({ type: 'replace_clip', clipId: clip.id, videoJobId: selectedCandidate.videoJobId, sourceFingerprint: selectedCandidate.fingerprint, sourceInFrame: start, sourceOutFrame: start + clip.sourceOutFrame - clip.sourceInFrame });
      }}>替换镜头</button>
      <button className="btn-secondary" disabled={busy || !clip} onClick={() => clip && setTrim({ ...clip, editRevision: variant.revision })}>调整截取位置</button>
      <button className="btn-secondary" disabled={busy || !clip || !!speedDraft} onClick={() => clip && setSpeedDraft({ clipId: clip.id, revision: variant.revision, rate: String(clip.playbackRate ?? 1) })}>调整镜头速度</button>
      <button className="btn-secondary" disabled={busy || !clip || !!durationDraft} onClick={() => clip && setDurationDraft({ clipId: clip.id, revision: variant.revision, frames: String(clip.timelineOutFrame - clip.timelineInFrame), oldFrames: clip.timelineOutFrame - clip.timelineInFrame, totalFrames: variant.timeline.bodyFrames + 20, following: ordered.filter(c => c.timelineInFrame >= clip.timelineOutFrame).length })}>调整镜头时长</button>
      <button className="btn-secondary" disabled={busy || !clip || !!externalClipId} onClick={() => clip && setExternalClipId(clip.id)}>添加新视频候选</button>
      {[-1, 1].map(delta => <button className="btn-secondary" key={delta} disabled={busy || !clip || !ordered[ordered.findIndex(c => c.id === clip.id) + delta]} onClick={() => {
        const index = ordered.findIndex(c => c.id === clip?.id); if (index < 0 || !ordered[index + delta]) return;
        void apply({ type: 'swap_clips', leftClipId: ordered[index].id, rightClipId: ordered[index + delta].id });
      }}>{delta < 0 ? '前移' : '后移'}</button>)}
    </div>
    {externalClipId && <ReassembledExternalCandidate key={externalClipId} projectId={group.projectId} shotSetId={group.shotSetId} groupId={group.id} clipId={externalClipId} onClose={() => setExternalClipId('')} onRegistered={async () => {
      await reload(); setExternalClipId(''); setMessage('新视频已登记为候选。请选择该候选并明确替换镜头；原编辑尚未改变。');
    }} />}
    {speedDraft && <form aria-label="镜头定长变速" onSubmit={async e => {
      e.preventDefault();
      if (await apply({ type: 'set_clip_playback_rate', clipId: speedDraft.clipId, playbackRate: Number(speedDraft.rate) }, speedDraft.revision)) setSpeedDraft(null);
    }}>
      <p>镜头 {speedDraft.clipId}：保持片段时长和其他镜头位置，按新速度调整源片结束位置。保存后请检查标注与画面的对应关系。</p>
      <label>镜头倍速 <input aria-label="镜头倍速" type="number" min="0.25" max="4" step="0.05" required value={speedDraft.rate} disabled={busy} onChange={e => setSpeedDraft({ ...speedDraft, rate: e.target.value })} /></label>
      <button className="btn-primary" type="submit" disabled={busy}>保存镜头速度</button>
      <button className="btn-secondary" type="button" disabled={busy} onClick={() => setSpeedDraft(null)}>取消速度修改</button>
      {speedDraft.revision !== variant.revision && <p role="status">当前编辑已变化，输入已保留。请取消后重新打开并核对，不会覆盖新的修改。</p>}
    </form>}
    {durationDraft && <form aria-label="镜头时长调整" onSubmit={async e => {
      e.preventDefault();
      if (await apply({ type: 'set_film_clip_duration', clipId: durationDraft.clipId, durationFrames: Number(durationDraft.frames) }, durationDraft.revision)) {
        setDurationDraft(null); setMessage('时长已保存。请检查后续镜头与配音、字幕、卖点及标注的对应关系和人物避让；可生成完整包装预览或直接导出。');
      }
    }}>
      <p>镜头 {durationDraft.clipId}：保留源入点和速度，调整源片结束位置；后续 {durationDraft.following} 个镜头整体顺延，其素材与截取区间保留。</p>
      <label>镜头时长（帧，24 帧/秒） <input aria-label="镜头时长帧数" type="number" min="12" step="1" required value={durationDraft.frames} disabled={busy} onChange={e => setDurationDraft({ ...durationDraft, frames: e.target.value })} /></label>
      {Number.isSafeInteger(Number(durationDraft.frames)) && <p>变化 {Number(durationDraft.frames) - durationDraft.oldFrames} 帧；新成片总长 {((durationDraft.totalFrames + Number(durationDraft.frames) - durationDraft.oldFrames) / 24).toFixed(3)} 秒（含封面）。</p>}
      <p>字幕、配音和定时卖点保持原时间；classic 标注随所属镜头，片尾随总长。音乐参数保留并覆盖新片长。超出素材、标注、字幕或配音边界时整次修改不保存。</p>
      <button className="btn-primary" type="submit" disabled={busy}>保存镜头时长</button>
      <button className="btn-secondary" type="button" disabled={busy} onClick={() => setDurationDraft(null)}>取消时长修改</button>
      {durationDraft.revision !== variant.revision && <p role="status">当前编辑已变化，输入已保留。请取消后重新打开并核对，不会覆盖新的修改。</p>}
    </form>}
    {trim && <TrimEditor key={`${trim.id}:${trim.editRevision}`} clip={trim} clipIndex={ordered.findIndex(c => c.id === trim.id)} asset={group.assets.find(a => a.videoJobId === trim.videoJobId) || null} disabled={busy} onClose={() => setTrim(null)} onCommit={async (sourceInFrame, sourceOutFrame) => {
      const result = await apply({ type: 'trim_clip', clipId: trim.id, sourceInFrame, sourceOutFrame, timelineInFrame: trim.timelineInFrame, timelineOutFrame: trim.timelineOutFrame }, trim.editRevision); if (result) setTrim(null); return result;
    }} />}
    <MixcutTimeline variant={variant} cues={group.subtitleCues} assets={group.assets} selectedClipId={selectedId} selectedCueId="" playheadSec={playhead} disabled={busy}
      onTogglePlay={() => { if (video.current?.paused) void video.current.play(); else video.current?.pause(); }} onSeek={seek} onSelectClip={setSelectedId} onSelectCue={() => void unsupported()}
      onVariantCommand={apply} onGroupCommand={unsupported} onTrimClip={clip => setTrim({ ...clip, editRevision: variant.revision })} onEditCueText={() => void unsupported()}
      narrationPlaybackRate={1} narrationDurationSec={variant.timeline.bodyFrames / 24} onNarrationPlaybackRatePreview={() => void unsupported()} onNarrationPlaybackRateCommit={() => void unsupported()}
      bgmTrackName="原片音乐" pointCues={[]} coverSec={20 / 24} selectedPointId="" packagingEnabled={false} packagingTemplate={film.template} activeCueText="" onSelectPoint={() => void unsupported()} onPointsChange={() => void unsupported()} />
  </main>;
}
