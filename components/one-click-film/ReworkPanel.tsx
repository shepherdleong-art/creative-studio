'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FilmVersion, ReworkCandidate, ReworkPurpose, ReworkReference } from '@/lib/one-click-film/rework';
import type { HdPlan } from '@/lib/one-click-film/hd';
import type { getRedrawQuote } from '@/lib/one-click-film/rework-generation';
import { REWORK_VIDEO_PROMPT_LIMIT } from '@/lib/one-click-film/contract';
import { FINAL_EDIT_FPS, sourceFrameLimit } from '@/lib/media-core/render-contract';
import { GroupHeading, Tag, ToolbarButton } from '@/components/ui/Appearance';
import { Dialog } from '@/components/ui/Dialog';
import { CandidateTrimDialog } from './CandidateTrimDialog';
import type { FilmImage } from './types';
import styles from './one-click-film.module.css';

const PURPOSES: Record<ReworkPurpose, string> = {
  appearance: '产品外观', person: '人物形象', action: '动作', camera: '运镜', scene: '场景',
};

export function ReworkPanel({ projectId, images, review, shot, reload, onCompare, onAdjustSound }: {
  projectId: string;
  images: FilmImage[];
  review: { jobId: string; entryId: string; entryCode: string; durationUs: number; approved: boolean;
    draft: boolean; hdApproved: boolean; hdVideoUrl: string | null; reviewSourceId: string | null };
  shot: { id: string; startUs: number; endUs: number } | null;
  reload: () => Promise<void>;
  onCompare: (candidate: ReworkCandidate | null, seamUrl: string) => void;
  onAdjustSound?: () => void;
}) {
  const [candidates, setCandidates] = useState<ReworkCandidate[]>([]);
  const [versions, setVersions] = useState<FilmVersion[]>([]);
  const [restoreId, setRestoreId] = useState('');
  const [hd, setHd] = useState<HdPlan | null>(null);
  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [purpose, setPurpose] = useState<ReworkPurpose>('appearance');
  const [attachments, setAttachments] = useState<ReworkReference[]>([]);
  const [uploading, setUploading] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [seam, setSeam] = useState('');
  const [confirmHd, setConfirmHd] = useState(false);
  const [confirmRedraw, setConfirmRedraw] = useState<{ requestKey: string; prompt: string | null } | null>(null);
  const [redrawEdit, setRedrawEdit] = useState<string | null>(null);
  const closeRedrawEditor = useCallback(() => setRedrawEdit(null), []);
  const [redraw, setRedraw] = useState<ReturnType<typeof getRedrawQuote>>(null);
  const loadRevision = useRef(0);
  const endpoint = `/api/one-click-film/${projectId}/rework`;

  const load = useCallback(async () => {
    const revision = loadRevision.current;
    const params = new URLSearchParams({ entryId: review.entryId, reviewJobId: review.jobId });
    const response = await fetch(`${endpoint}?${params}`, { cache: 'no-store' });
    const payload = await response.json() as { candidates?: ReworkCandidate[]; hd?: HdPlan; versions?: FilmVersion[];
      redraw?: ReturnType<typeof getRedrawQuote>; message?: string; error?: string };
    if (!response.ok) throw new Error(payload.message || payload.error || '读取候选和高清任务失败');
    if (revision !== loadRevision.current) return;
    setCandidates(payload.candidates ?? []);
    setVersions(payload.versions ?? []);
    setRedraw(payload.redraw ?? null);
    setHd(payload.hd ?? null);
  }, [endpoint, review.entryId, review.jobId]);

  useEffect(() => {
    const timer = setTimeout(() => void load().catch((cause: Error) => setError(cause.message)), 0);
    return () => clearTimeout(timer);
  }, [load, review.approved]);

  const visible = candidates.filter((item) => item.reviewJobId === review.jobId &&
    (item.shotId === 'whole' || (item.shotId === shot?.id && item.reviewSourceId === review.reviewSourceId)));
  const candidate = visible.find((item) => item.id === selected) ?? visible.at(-1) ?? null;
  const hdSources = hd?.sources.filter((item) => item.entryCode === review.entryCode) ?? [];
  const hdPending = hdSources.some((item) => item.status === 'pending' && item.id !== item.sourceVideoJobId);
  const waiting = hdPending || visible.some((item) => ['queued', 'running', 'needs_check'].includes(item.status));
  useEffect(() => {
    if (!waiting || working) return;
    let stopped = false;
    const poll = async () => {
      try {
        await load();
        if (!stopped) await reload();
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!stopped) timer = setTimeout(poll, 1300);
    };
    let timer = setTimeout(poll, 1300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [waiting, working, load, reload]);
  useEffect(() => { onCompare(candidate, seam); }, [candidate, seam, onCompare]);

  const post = async (body: Record<string, unknown>) => {
    if (working) return false;
    setWorking(true);
    setError('');
    const adopting = body.action === 'adopt';
    setStatus(adopting ? '正在替换…' : body.action === 'preview' ? '正在合成接缝预览…' : '');
    let refreshing = false;
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json() as { candidate?: ReworkCandidate; candidates?: ReworkCandidate[];
        previewUrl?: string; message?: string; error?: string };
      if (!response.ok) throw new Error(result.message || result.error || '操作失败');
      if (result.candidate) setSelected(result.candidate.id);
      if (result.candidates) {
        ++loadRevision.current;
        setCandidates(result.candidates);
      }
      setSeam(result.previewUrl ?? '');
      if (adopting) {
        setStatus('已替换，正在刷新成片预览…');
        refreshing = true;
        void Promise.all([load(), reload()]).then(
          () => setStatus('已替换。请重新审片。'),
          () => setStatus('已替换，预览刷新失败。请重新打开审片。'),
        ).finally(() => setWorking(false));
        return true;
      }
      if (body.action === 'preview') { setStatus('接缝预览已打开。'); return true; }
      await load();
      await reload();
      return true;
    } catch (cause) {
      setStatus('');
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
    finally { if (!refreshing) setWorking(false); }
  };

  const uploadReferences = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      const response = await fetch(`/api/projects/${projectId}/video-reference-assets`, { method: 'POST', body: form });
      const result = await response.json() as { files?: Array<{ id: string; kind: string; filename: string }>; error?: string };
      if (!response.ok || !result.files) throw new Error(result.error || '参考素材上传失败');
      const uploaded = result.files.flatMap((file): ReworkReference[] => file.kind === 'image' || file.kind === 'video'
        ? [{ id: file.id, kind: file.kind, label: file.filename, purpose: 'appearance' }] : []);
      if (uploaded.length !== result.files.length) setError('返工参考只支持图片或视频。');
      setAttachments((items) => [...items, ...uploaded]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploading(false); }
  };
  const submit = (target: string, redraw?: { requestKey: string; prompt: string | null }) => post({
    action: 'create', reviewJobId: review.jobId, shotId: target,
    prompt: redraw?.prompt != null ? '' : prompt,
    redrawPrompt: redraw?.prompt ?? undefined,
    requestKey: redraw?.requestKey ?? crypto.randomUUID(),
    references: [
      ...(referenceId ? [{ id: referenceId, kind: 'image', purpose, label: images.find((image) => image.id === referenceId)?.filename }] : []),
      ...attachments,
    ],
  });
  const frame = (us: number) => Math.round(us * FINAL_EDIT_FPS / 1e6);
  const totalFrames = sourceFrameLimit(candidate?.durationUs ?? 0);
  const length = candidate ? frame(candidate.replaceEndUs) - frame(candidate.replaceStartUs) : 0;
  const trimFrame = Math.max(0, Math.min(totalFrames - length, frame(candidate?.trimStartUs ?? 0)));
  const trimUs = Math.round(trimFrame * 1e6 / FINAL_EDIT_FPS);
  const replacementBlocked = candidate && (candidate.shotId === 'whole'
    ? candidate.replaceStartUs !== 0 || candidate.replaceEndUs !== review.durationUs
    : candidate.replaceStartUs !== shot?.startUs || candidate.replaceEndUs !== shot?.endUs);
  const tooShort = length <= 0 || totalFrames < length;
  const closeTrim = useCallback(() => {
    if (working) return;
    setTrimming(false);
    setError('');
  }, [working]);

  return <>
    <details className={styles.reviewSection}>
      <summary>返工设置</summary>
      <div className={styles.reviewSectionBody}>
    <label className={styles.editRow}>返工要求
      <textarea aria-label="返工要求" className="input-field" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
    </label>
    <label className={styles.editRow}>参考素材
      <select aria-label="返工参考素材" className="input-field" value={referenceId} onChange={(event) => setReferenceId(event.target.value)}>
        <option value="">无</option>
        {images.map((image) => <option key={image.id} value={image.id}>{image.filename}</option>)}
      </select>
    </label>
    {referenceId ? <label className={styles.editRow}>参考用途
      <select aria-label="参考用途" className="input-field" value={purpose} onChange={(event) => setPurpose(event.target.value as ReworkPurpose)}>
        {Object.entries(PURPOSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label> : null}
    <label className={styles.editRow}>{uploading ? '正在上传参考素材…' : '添加图片或视频参考'}
      <input type="file" aria-label="添加图片或视频参考" className="input-field" multiple
        accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,.mov" disabled={uploading || working} onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void uploadReferences(files);
        }} />
    </label>
    {attachments.map((item) => <div key={item.id} className={styles.editBox}>
      <a href={`/api/video-reference-assets/${item.id}`} target="_blank" rel="noreferrer">{item.label}</a>
      <select className="input-field" aria-label={`${item.label} 的用途`} value={item.purpose} onChange={(event) => {
        const next = event.target.value as ReworkPurpose;
        setAttachments((items) => items.map((ref) => ref.id === item.id ? { ...ref, purpose: next } : ref));
      }}>
        {Object.entries(PURPOSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <button type="button" className="cap" onClick={() => setAttachments((items) => items.filter((ref) => ref.id !== item.id))}>移除</button>
    </div>)}
      <ToolbarButton variant="primary" disabled={!shot || !prompt.trim() || working || uploading}
        onClick={() => { if (shot) void submit(shot.id); }}>重新生成片段</ToolbarButton>
      </div>
    </details>
    <div className={styles.reviewActions}>
      <button type="button" className="cap" disabled={working || uploading || !redraw} onClick={() => {
        setError('');
        setConfirmRedraw({ requestKey: crypto.randomUUID(), prompt: null });
      }}>整条重抽</button>
      {onAdjustSound ? <button type="button" className="cap" onClick={onAdjustSound}>调整声音</button> : null}
    </div>
    {confirmRedraw && redraw ? <div className={styles.editBox}>
      <b>{review.entryCode} 整条重抽</b>
      <p className={styles.hint}>正文 0–{redraw.duration} 秒，提交生成 {redraw.generatedDuration} 秒。</p>
      <p className={styles.hint}>{redraw.model} · {redraw.provider} · 账号 {redraw.account}</p>
      <p className={styles.hint}>{redraw.costMicros === null ? '通道暂无可用费率' : `预计 ¥${(redraw.costMicros / 1e6).toFixed(2)}`} · {redraw.sound}</p>
      <div className={styles.reviewActions}>
        <ToolbarButton icon="text" disabled={working} onClick={() => setRedrawEdit(confirmRedraw.prompt ?? redraw.promptText)}>
          修改提示词
        </ToolbarButton>
        {confirmRedraw.prompt !== null ? <Tag tone="ok">已修改提示词</Tag> : null}
      </div>
      <div className={styles.reviewActions}>
        <ToolbarButton disabled={working} onClick={() => setConfirmRedraw(null)}>取消重抽</ToolbarButton>
        <ToolbarButton variant="primary" disabled={working || uploading} onClick={async () => {
          if (await submit('whole', confirmRedraw)) setConfirmRedraw(null);
        }}>{working ? '提交中…' : '确认整条重抽'}</ToolbarButton>
      </div>
      {redrawEdit !== null ? <Dialog open width="wide" title={`${review.entryCode} · 整条重抽提示词`}
        description="此处修改只用于本次重抽。" onClose={closeRedrawEditor}
        footer={<div className={styles.inlineActions}>
          <ToolbarButton onClick={closeRedrawEditor}>取消编辑</ToolbarButton>
          <ToolbarButton variant="primary" disabled={!redrawEdit.trim()} onClick={() => {
            const edited = redrawEdit.trim();
            setConfirmRedraw({ ...confirmRedraw, prompt: edited === redraw.promptText.trim() ? null : edited });
            closeRedrawEditor();
          }}>应用到本次重抽</ToolbarButton>
        </div>}>
        <label className={styles.field}>
          <span>视频提示词全文</span>
          <textarea aria-label="整条重抽提示词全文" className={`input-field ${styles.redrawPromptField}`} rows={14}
            maxLength={REWORK_VIDEO_PROMPT_LIMIT} value={redrawEdit} onChange={(event) => setRedrawEdit(event.target.value)} />
        </label>
      </Dialog> : null}
    </div> : null}
    {visible.length ? <GroupHeading>候选片段</GroupHeading> : null}
    {visible.length ? <div className={styles.candidateList}>{visible.map((item, index) =>
      <button key={item.id} type="button" className="cap" disabled={working} aria-pressed={candidate?.id === item.id}
      onClick={() => { setSelected(item.id); setSeam(''); setStatus(''); setError(''); }}>
      候选 {index + 1} · {item.status === 'ready' ? item.adopted ? '已替换' : '可预览'
        : item.status === 'failed' ? '失败' : item.status === 'needs_check' ? '待核对' : '生成中'}
    </button>)}</div> : null}
    {candidate?.errorMessage ? <p className={styles.hintFail}>{candidate.errorMessage}</p> : null}
    {candidate?.status === 'ready' ? <>
      <p className={styles.hint}>目标 {(candidate.replaceStartUs / 1e6).toFixed(2)}–{(candidate.replaceEndUs / 1e6).toFixed(2)} 秒 · 候选 {(candidate.durationUs / 1e6).toFixed(2)} 秒</p>
      {replacementBlocked ? <p className={styles.hintWarn}>镜头切点已变更。请选用当前区间的候选，或按当前切点重新生成。</p> : null}
      {tooShort ? <p className={styles.hintWarn}>候选长度不足，无法覆盖选区。</p> : null}
      <div className={styles.reviewActions}>
        {candidate.shotId !== 'whole' && candidate.videoUrl ? <ToolbarButton icon="scissors"
          disabled={working || tooShort || !!replacementBlocked} onClick={() => { setError(''); setTrimming(true); }}>
          调整入点与出点
        </ToolbarButton> : null}
        <button type="button" className="cap" disabled={working || candidate.adopted || tooShort || !!replacementBlocked}
          onClick={() => void post({ action: 'preview', candidateId: candidate.id, trimStartUs: trimUs })}>循环预览接缝</button>
        {candidate.adopted ? <button type="button" className="cap" disabled={working}
          onClick={() => void post({ action: 'revert', entryId: review.entryId, entryCode: review.entryCode, shotId: candidate.shotId })}>撤销替换</button>
          : <button type="button" className="cap cap-primary" disabled={working || tooShort || !!replacementBlocked}
            onClick={() => void post({ action: 'adopt', candidateId: candidate.id, trimStartUs: candidate.shotId === 'whole' ? 0 : trimUs })}>
            {working && status === '正在替换…' ? status : candidate.shotId === 'whole' ? '采用整条' : '替换'}
          </button>}
      </div>
      {trimming && candidate.videoUrl ? <CandidateTrimDialog key={candidate.id}
        url={candidate.videoUrl} initialFrame={trimFrame} length={length} totalFrames={totalFrames}
        adopted={candidate.adopted} working={working} error={error} onClose={closeTrim} onReplace={async (start) => {
          if (await post({ action: 'adopt', candidateId: candidate.id, trimStartUs: Math.round(start * 1e6 / FINAL_EDIT_FPS) })) setTrimming(false);
        }} /> : null}
    </> : null}
    {status ? <p className={styles.hint} role="status">{status}</p> : null}
    {error && !trimming ? <p className={styles.hintFail} role="alert">{error}</p> : null}
    {versions.length ? <details className={styles.reviewSection}>
      <summary>剪辑历史</summary>
      <div className={styles.reviewSectionBody}>
      <label className={styles.editRow}>历史版本
        <select className="input-field" value={restoreId} onChange={(event) => setRestoreId(event.target.value)}>
          <option value="">请选择</option>
          {[...versions].reverse().map((version) => <option key={version.id} value={version.id}>
            第 {version.versionNumber} 版 · {version.adopted.length ? `${version.adopted.length} 处替换` : '原片'}
          </option>)}
        </select>
      </label>
      <button type="button" className="cap" disabled={!restoreId || working} onClick={() => void post({
        action: 'restore-version', reviewJobId: review.jobId, versionId: restoreId,
      })}>恢复该版本</button>
      </div>
    </details> : null}
    {review.approved && review.draft ? <>
      {hd?.blocked.filter((item) => item.entryCode === review.entryCode).map((item) => <p className={styles.hintFail} key={item.reason}>{item.reason}</p>)}
      {hdSources.filter((item) => item.errorMessage).map((item) => <p className={styles.hintFail} key={item.sourceVideoJobId}>{item.errorMessage}</p>)}
      {review.hdVideoUrl ? <button type="button" className="cap cap-primary" disabled={review.hdApproved || working}
        onClick={() => void post({ action: 'approve-hd', entryCode: review.entryCode })}>
        {review.hdApproved ? '高清已复核' : '确认高清通过'}
      </button> : <button type="button" className="cap" disabled={working || hdPending}
        onClick={() => setConfirmHd(true)}>{hdSources.some((item) => item.needsCheck) ? '高清任务待核对' : hdPending ? '转高清中…' : '一键高清'}</button>}
      {confirmHd && !review.hdVideoUrl ? <div className={styles.editBox}>
        <b>采用的样片来源</b>
        {hdSources.map((item) => <p key={item.sourceVideoJobId} className={styles.hint}>
          {item.sourceVideoJobId.slice(0, 8)} · {item.model} · {item.accountRef} · {item.reusable ? '已有高清'
            : item.estimatedCostMicros === null ? '通道暂无可用费率' : `约 ¥${(item.estimatedCostMicros / 1e6).toFixed(2)}`}
        </p>)}
        <button type="button" className="cap cap-primary" disabled={working || hdPending} onClick={() => {
          setConfirmHd(false); void post({ action: 'convert-hd', entryCode: review.entryCode });
        }}>确认转高清</button>
      </div> : null}
    </> : null}
  </>;
}
