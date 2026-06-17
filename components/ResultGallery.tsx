'use client';

import { useState, useEffect, useRef } from 'react';
import HoverZoomImage from '@/components/HoverZoomImage';
import { Icon } from '@/components/ui/Icon';
import {
  getResultGalleryCounts,
  getResultJobKind,
  getSceneReferenceBadgeLabel,
  getSelectableResultJobs,
  SceneReferenceSummary,
} from '@/lib/result-gallery-jobs';

interface Job {
  id: string;
  inputFilename: string;
  outputFilename?: string;
  status: string;
  outputImageId?: string;
  inputImageId?: string;
  errorMessage?: string;
  reviewMark?: string;
  prompt?: string;
  parentJobId?: string;
  revision?: number;
  referenceImageIds?: string;
  providerId?: string;
  model?: string;
  size?: string;
  quality?: string;
}

interface ImageAsset {
  id: string;
  role: string;
  filename: string;
  path: string;
  relativePath?: string;
  imageUrl?: string;
}

interface ImageProvider {
  id: string;
  name: string;
  model: string;
  enabled: number | boolean;
  hasApiKey: boolean;
}

export type RegeneratePayload = {
  prompt: string;
  inputSource: 'original' | 'current_result';
  referenceImageIds: string[];
  providerId?: string;
};

interface Props {
  jobs: Job[];
  images: ImageAsset[];
  onRetry: (jobId: string) => void;
  onMark: (jobId: string, mark: string) => void;
  onRegenerate: (jobId: string, payload: RegeneratePayload) => void;
  onSetSceneRef?: (jobId: string, imageAssetId: string) => void;
  projectId?: string;
  sceneReferenceByImageId?: Map<string, SceneReferenceSummary>;
  providers?: ImageProvider[];
}

/** ── Tiny inline uploader for the regen modal ── */
function InlineUploader({
  projectId,
  onUploaded,
}: {
  projectId?: string;
  onUploaded: (asset: ImageAsset) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('files', f));
      form.append('role', 'reference');
      form.append('preprocessEnabled', 'true');
      form.append('targetMaxSide', '1536');
      form.append('jpegQuality', '85');
      if (projectId) form.append('projectId', projectId);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed (${res.status})`);
      }
      const data = await res.json();
      if (data.files?.length > 0) onUploaded(data.files[0] as ImageAsset);
    } catch (err) {
      alert('上传失败: ' + String(err));
    } finally {
      setUploading(false);
      if (ref.current) ref.current.value = '';
    }
  };

  return (
    <label className="link-accent flex cursor-pointer items-center gap-1 text-xs">
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleChange} className="hidden" />
      <Icon name="plus" size={12} />
      {uploading ? '上传中…' : '添加参考图'}
    </label>
  );
}
/** ── Generation context sidebar ── */
function GenerationContextPanel({
  job, referenceImages, providerName,
}: {
  job: Job;
  referenceImages: ImageAsset[];
  providerName?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyPrompt = async () => {
    if (!job.prompt) return;
    try {
      await navigator.clipboard.writeText(job.prompt);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = job.prompt;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-l border-hairline p-3 text-xs">
      <h4 className="mb-3 font-medium text-ink">生成上下文</h4>

      {/* Reference images */}
      <div className="mb-4">
        <div className="mb-1.5 text-ink-secondary">参考图</div>
        {referenceImages.length === 0 ? (
          <p className="text-ink-tertiary italic">无参考图</p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {referenceImages.map((img) => (
              <a
                key={img.id}
                href={img.imageUrl || '#'}
                target="_blank"
                rel="noreferrer"
                title={img.filename}
                className="block"
              >
                <HoverZoomImage
                  src={img.imageUrl || ''}
                  alt={img.filename}
                  className="aspect-square w-full rounded border border-hairline object-cover transition-colors hover:border-accent"
                />
                <div className="mt-0.5 truncate text-[9px] text-ink-tertiary">{img.filename}</div>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Prompt */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-ink-secondary">提示词</span>
          {job.prompt && (
            <button onClick={handleCopyPrompt} className="link-accent inline-flex items-center gap-1 text-[10px]">
              <Icon name={copied ? 'check' : 'copy'} size={11} />
              {copied ? '已复制' : '复制'}
            </button>
          )}
        </div>
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-surface-subtle p-2 leading-relaxed text-ink-secondary">
          {job.prompt || <span className="text-ink-tertiary italic">无提示词</span>}
        </div>
      </div>

      {/* Parameters */}
      <div>
        <div className="mb-1.5 text-ink-secondary">参数</div>
        <div className="space-y-1 text-ink-secondary">
          {providerName && <div>供应商: <span className="text-ink">{providerName}</span></div>}
          {job.model && <div>模型: <span className="text-ink">{job.model}</span></div>}
          {job.size && <div>尺寸: <span className="text-ink">{job.size}</span></div>}
          {job.quality && <div>质量: <span className="text-ink">{job.quality}</span></div>}
          {job.revision != null && <div>版本: <span className="text-ink">r{job.revision}</span></div>}
        </div>
      </div>
    </aside>
  );
}

/** ── Status dot helper ── */
function JobStatusDot({ status }: { status: string }) {
  const cls =
    status === 'succeeded' ? 'status-dot-ok' :
    status === 'failed' ? 'status-dot-fail' :
    status === 'running' ? 'status-dot-run' :
    status === 'retrying' ? 'status-dot-warn' :
    'status-dot-idle';
  return <span className={`status-dot ${cls}`} title={status} />;
}

export default function ResultGallery({ jobs, images, onRetry, onMark, onRegenerate, onSetSceneRef, projectId, sceneReferenceByImageId, providers = [] }: Props) {
  const counts = getResultGalleryCounts(jobs);
  const succeededJobs = jobs.filter((j) => getResultJobKind(j) === 'succeeded');
  const failedJobs = jobs.filter((j) => j.status === 'failed');
  const [statusFilter, setStatusFilter] = useState<'all' | 'failed'>('all');
  const displayedJobs = statusFilter === 'all' ? jobs : failedJobs;
  const selectableJobs = getSelectableResultJobs(displayedJobs);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [regenInputSource, setRegenInputSource] = useState<'original' | 'current_result'>('original');
  const [regenProviderId, setRegenProviderId] = useState('');
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [extraUploads, setExtraUploads] = useState<ImageAsset[]>([]);
  const selectedIndex = selectedJobId ? selectableJobs.findIndex((job) => job.id === selectedJobId) : -1;
  const selectedJob = selectedIndex >= 0 ? selectableJobs[selectedIndex] : null;
  const selectedSceneReference = selectedJob?.outputImageId ? sceneReferenceByImageId?.get(selectedJob.outputImageId) : undefined;
  const selectableProviders = providers.filter((provider) => provider.enabled && provider.hasApiKey);
  const selectedProviderId = selectableProviders.some((provider) => provider.id === regenProviderId)
    ? regenProviderId
    : (selectableProviders.some((provider) => provider.id === selectedJob?.providerId)
      ? selectedJob?.providerId || ''
      : selectableProviders[0]?.id || '');
  const selectedProvider = selectableProviders.find((provider) => provider.id === selectedProviderId);

  const getImageUrl = (asset: ImageAsset | undefined): string | null => asset?.imageUrl || null;
  const getMark = (job: Job): string | null => job.reviewMark || null;

  const goPrev = () => {
    if (selectedIndex > 0) setSelectedJobId(selectableJobs[selectedIndex - 1].id);
  };
  const goNext = () => {
    if (selectedIndex >= 0 && selectedIndex < selectableJobs.length - 1) {
      setSelectedJobId(selectableJobs[selectedIndex + 1].id);
    }
  };

  useEffect(() => {
    if (!selectedJob) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedJobId(null);
      if (e.key === 'ArrowLeft' && selectedIndex > 0) setSelectedJobId(selectableJobs[selectedIndex - 1].id);
      if (e.key === 'ArrowRight' && selectedIndex < selectableJobs.length - 1) setSelectedJobId(selectableJobs[selectedIndex + 1].id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedJob, selectedIndex, selectableJobs]);

  const handleMark = (mark: string) => { if (!selectedJob) return; onMark(selectedJob.id, mark); };

  // ── Current base image ID ──
  const baseImageId = selectedJob
    ? (regenInputSource === 'current_result' ? selectedJob.outputImageId ?? null : selectedJob.inputImageId)
    : null;

  // ── Image lookup ──
  const imageById = new Map(images.map((img) => [img.id, img]));

  // ── Reference images used in the current job (for sidebar) ──
  const usedReferenceImages = (() => {
    if (!selectedJob || !selectedJob.referenceImageIds) return [];
    try {
      const ids: string[] = JSON.parse(selectedJob.referenceImageIds);
      return ids.map((id) => imageById.get(id)).filter(Boolean) as ImageAsset[];
    } catch { return []; }
  })();

  // ── Reference candidates for the regen panel ──
  const referenceCandidates = (() => {
    if (!selectedJob) return [];
    const seen = new Set<string>();
    const candidates: { id: string; label: string; imageUrl: string; role: string; isBase: boolean }[] = [];

    const add = (asset: ImageAsset | undefined, label: string, isBase = false) => {
      if (!asset || seen.has(asset.id)) return;
      seen.add(asset.id);
      candidates.push({ id: asset.id, label, imageUrl: asset.imageUrl || `/api/images/${asset.relativePath || ''}`, role: asset.role, isBase });
    };

    // Original input image
    const inputAsset = images.find((img) => img.id === selectedJob.inputImageId);
    const isInputBase = regenInputSource === 'original';
    add(inputAsset, '原图', isInputBase);

    // Current result image
    const outputAsset = images.find((img) => img.id === selectedJob.outputImageId);
    const isOutputBase = regenInputSource === 'current_result';
    add(outputAsset, '当前结果', isOutputBase);

    // Project reference images
    images.filter((img) => img.role === 'reference').forEach((img) => add(img, `参考: ${img.filename}`));

    // Other successful results
    succeededJobs
      .filter((j) => j.id !== selectedJob.id && j.outputImageId)
      .forEach((j) => {
        const asset = imageById.get(j.outputImageId!);
        add(asset, `结果: ${j.inputFilename}`);
      });

    // Extra user uploads
    extraUploads.forEach((img) => add(img, `上传: ${img.filename}`));

    return candidates;
  })();

  // ── Initialize regen state ──
  const openRegen = () => {
    if (!selectedJob) return;
    setRegenPrompt(selectedJob.prompt || '');
    setRegenInputSource('original');
    setRegenProviderId(selectedJob.providerId || selectableProviders[0]?.id || '');
    setExtraUploads([]);

    // Default base = original → exclude original from refs
    const baseId = selectedJob.inputImageId;
    const hasOutput = !!selectedJob.outputImageId;
    const defaultRefs: string[] = [];

    if (hasOutput && selectedJob.outputImageId && selectedJob.outputImageId !== baseId) {
      defaultRefs.push(selectedJob.outputImageId);
    }

    try {
      const existingRefs: string[] = JSON.parse(selectedJob.referenceImageIds || '[]');
      for (const rid of existingRefs) {
        if (rid !== baseId && !defaultRefs.includes(rid)) defaultRefs.push(rid);
      }
    } catch { /* ignore parse errors */ }

    setSelectedReferenceIds(defaultRefs);
    setRegenOpen(true);
  };

  const handleInputSourceChange = (source: 'original' | 'current_result') => {
    if (!selectedJob) return;
    const newBaseId = source === 'current_result' ? selectedJob.outputImageId : selectedJob.inputImageId;
    const oldBaseId = regenInputSource === 'current_result' ? selectedJob.outputImageId : selectedJob.inputImageId;

    setRegenInputSource(source);
    setSelectedReferenceIds((prev) => {
      // Remove new base from refs; optionally add old base as reference
      const next = prev.filter((id) => id !== newBaseId);
      if (oldBaseId && oldBaseId !== newBaseId && !next.includes(oldBaseId)) {
        next.push(oldBaseId);
      }
      return next;
    });
  };

  const toggleReference = (imageId: string) => {
    // Base image cannot be toggled as reference
    if (imageId === baseImageId) return;
    setSelectedReferenceIds((prev) =>
      prev.includes(imageId) ? prev.filter((id) => id !== imageId) : [...prev, imageId]
    );
  };

  const handleUploaded = (asset: ImageAsset) => {
    setExtraUploads((prev) => [...prev, asset]);
    setSelectedReferenceIds((prev) => prev.includes(asset.id) ? prev : [...prev, asset.id]);
  };

  const handleSubmitRegen = () => {
    if (!selectedJob) return;
    if (!regenPrompt.trim()) { alert('请输入提示词'); return; }
    // Normalize: ensure base image is NOT in reference list
    const normalizedRefIds = selectedReferenceIds.filter((id) => id !== baseImageId);
    onRegenerate(selectedJob.id, {
      prompt: regenPrompt.trim(),
      inputSource: regenInputSource,
      referenceImageIds: normalizedRefIds,
      providerId: selectedProviderId || undefined,
    });
    setRegenOpen(false);
  };

  const hasOutput = selectedJob?.outputImageId && imageById.has(selectedJob.outputImageId);
  const selectedJobKind = selectedJob ? getResultJobKind(selectedJob) : 'empty';
  const selectedJobHasResult = !!selectedJob && selectedJobKind === 'succeeded' && !!selectedJob.outputFilename;
  const selectedJobIsFailed = selectedJobKind === 'failed';
  const isFirst = selectedIndex <= 0;
  const isLast = selectedIndex === selectableJobs.length - 1;

  return (
    <div className="rounded-[18px] border border-hairline bg-surface-subtle p-4">
      {displayedJobs.length === 0 && (succeededJobs.length === 0 && failedJobs.length === 0) ? (
        <div className="flex flex-col items-center py-12 text-center text-ink-tertiary">
          <Icon name="image" size={34} className="mb-2" />
          <p>暂无生成的图片</p>
        </div>
      ) : (
        <>
          {/* ── Status filter toggle ── */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => { setStatusFilter('all'); setSelectedJobId(null); }}
              className={`btn-sm text-xs ${statusFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            >
              全部 ({counts.succeeded}/{counts.total})
            </button>
            {failedJobs.length > 0 && (
              <button
                onClick={() => { setStatusFilter('failed'); setSelectedJobId(null); }}
                className={`btn-sm text-xs ${statusFilter === 'failed' ? 'btn-primary bg-fail hover:bg-fail' : 'btn-secondary'}`}
              >
                失败 ({failedJobs.length})
              </button>
            )}
          </div>

          {displayedJobs.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center text-ink-tertiary">
              <Icon name={statusFilter === 'failed' ? 'check' : 'image'} size={34} className="mb-2" />
              <p>{statusFilter === 'failed' ? '暂无失败的生成任务' : '暂无成功生成的图片'}</p>
            </div>
          ) : (
            /* ── Grid (light workbench style) ── */
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {displayedJobs.map((job) => {
                const mark = getMark(job);
                const kind = getResultJobKind(job);
                const isFailed = kind === 'failed';
                const isSucceeded = kind === 'succeeded';
                const failedMessage =
                  job.status === 'succeeded'
                    ? '生成任务已成功，但输出文件或图片引用缺失'
                    : job.errorMessage || '未知错误';
                const sceneReference = job.outputImageId ? sceneReferenceByImageId?.get(job.outputImageId) : undefined;
                const sceneReferenceLabel = getSceneReferenceBadgeLabel(sceneReference);
                const selectableIndex = selectableJobs.findIndex((candidate) => candidate.id === job.id);
                const handleOpen = () => {
                  if (selectableIndex >= 0) setSelectedJobId(job.id);
                };
                return (
                  <div key={job.id} onClick={handleOpen}
                    className={`card group overflow-hidden transition-all duration-200 ${
                      selectableIndex >= 0 ? 'cursor-pointer hover:ring-1' : 'cursor-default'
                    } ${
                      isFailed ? 'border-fail/30 hover:ring-fail/40' : 'hover:border-accent/35 hover:ring-accent/15'
                    } ${mark === 'discard' ? 'opacity-40' : ''}`}>
                    <div className="relative aspect-square bg-surface-subtle">
                      {isFailed ? (
                        <div className="flex h-full w-full flex-col items-center justify-center bg-fail-tint p-2">
                          <Icon name="alert" size={24} className="mb-1 text-fail" />
                          <span className="line-clamp-3 text-center text-[10px] text-fail">{failedMessage}</span>
                        </div>
                      ) : isSucceeded ? (
                        <img src={`/api/images/outputs/${job.outputFilename}`} alt={job.inputFilename} className="w-full h-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-surface-subtle p-3 text-center">
                          {kind === 'queued' ? (
                            <Icon name="logs" size={24} className="text-ink-tertiary" />
                          ) : (
                            <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                          )}
                          <div className="text-xs font-medium text-ink-secondary">
                            {kind === 'queued' ? '排队中' : kind === 'checking' ? '待确认' : '生成中'}
                          </div>
                          <div className="text-[10px] text-ink-tertiary">
                            {kind === 'queued' ? '等待并发空位' : kind === 'checking' ? '等待补抓结果' : '图片完成后会自动出现'}
                          </div>
                        </div>
                      )}
                      {/* Status dot (Apple Photos-style) */}
                      <span className="absolute right-1.5 top-1.5 z-10">
                        <JobStatusDot status={job.status} />
                      </span>
                      {sceneReference && (
                        <span
                          className="scene-ref-badge"
                          title={`${sceneReferenceLabel}${sceneReference.imageFilename ? ` · ${sceneReference.imageFilename}` : ''}`}
                        >
                          <Icon name="check" size={12} />
                          <span className="scene-ref-badge-text">{sceneReferenceLabel}</span>
                        </span>
                      )}
                      {mark && isSucceeded && (
                        <span className={`pill absolute left-1 top-1 ${
                          mark === 'available' ? 'bg-ok-tint text-ok' : mark === 'rework' ? 'bg-warn-tint text-warn' : 'bg-idle-tint text-idle'}`}>
                          {{ available: '可用', rework: '返工', discard: '废弃' }[mark]}
                        </span>
                      )}
                    </div>
                    <div className="p-2">
                      <div className="truncate text-xs text-ink-secondary">{job.inputFilename}</div>
                      {isFailed && job.errorMessage && (
                        <div className="mt-0.5 truncate text-[10px] text-fail" title={job.errorMessage}>{job.errorMessage}</div>
                      )}
                      {isFailed && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRetry(job.id);
                          }}
                          className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-accent hover:underline"
                        >
                          <Icon name="retry" size={10} />
                          重试
                        </button>
                      )}
                      {!isSucceeded && !isFailed && (
                        <div className="mt-0.5 truncate text-[10px] text-ink-tertiary">{job.status}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Fullscreen viewer (Apple Photos dark style) ── */}
          {selectedJob && selectedIndex >= 0 && (
            <div className="theme-dark fixed inset-0 bg-black/95 z-50 flex flex-col"
              onClick={() => { setSelectedJobId(null); setRegenOpen(false); }}>
              <div className="flex flex-1 min-h-0 overflow-hidden"
                onClick={(e) => e.stopPropagation()}>

                {/* Body: images + sidebar */}
                <div className="flex overflow-hidden flex-1 min-h-0">
                  {/* Main image area */}
                  <div className="flex-1 flex flex-col min-w-0 overflow-y-auto p-6">
                    {/* Regenerate panel (overlay above images when open) */}
                    {regenOpen && (
                      <div className="mb-4 space-y-4 rounded-xl bg-surface-subtle p-4 border border-hairline">
                        <h4 className="text-sm font-semibold text-ink">重新生成设置</h4>

                        {/* Base image selector */}
                        <div>
                          <div className="mb-2 text-xs font-medium text-ink-secondary">编辑底图</div>
                          <div className="flex gap-2">
                            <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${
                              regenInputSource === 'original' ? 'border-accent bg-run-tint text-accent' : 'border-hairline bg-surface text-ink-secondary hover:border-accent/40'}`}>
                              <input type="radio" name="inputSource" value="original" checked={regenInputSource === 'original'}
                                onChange={() => handleInputSourceChange('original')} className="sr-only" />原图
                            </label>
                            <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${
                              regenInputSource === 'current_result' ? 'border-accent bg-run-tint text-accent' : 'border-hairline bg-surface text-ink-secondary hover:border-accent/40'} ${!hasOutput ? 'opacity-40 cursor-not-allowed' : ''}`}>
                              <input type="radio" name="inputSource" value="current_result" checked={regenInputSource === 'current_result'}
                                onChange={() => handleInputSourceChange('current_result')} disabled={!hasOutput} className="sr-only" />当前结果
                            </label>
                          </div>
                          <p className="mt-1 text-xs text-ink-tertiary">
                            {regenInputSource === 'current_result' ? '基于当前生成结果继续编辑' : '基于原始输入图重新生成'}
                          </p>
                        </div>

                        {selectableProviders.length > 0 && (
                          <div>
                            <label className="mb-1 block text-xs font-medium text-ink-secondary">供应商 / 模型</label>
                            <select
                              value={selectedProviderId}
                              onChange={(e) => setRegenProviderId(e.target.value)}
                              className="input-field text-sm"
                            >
                              {selectableProviders.map((provider) => (
                                <option key={provider.id} value={provider.id}>
                                  {provider.name} ({provider.model})
                                </option>
                              ))}
                            </select>
                            <p className="mt-1 text-xs text-ink-tertiary">
                              本次重新生成会使用：{selectedProvider?.model || selectedJob.model || '原任务模型'}
                            </p>
                          </div>
                        )}

                        {/* Send order preview */}
                        <div>
                          <div className="mb-2 text-xs font-medium text-ink-secondary">本次发送顺序</div>
                          <div className="space-y-1 rounded border border-hairline bg-surface p-2 text-xs">
                            <div className="flex items-center gap-2 text-ink">
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-run-tint text-[10px] font-bold text-accent">1</span>
                              <span>底图：{regenInputSource === 'current_result' ? '当前结果' : '原图'}</span>
                            </div>
                            {selectedReferenceIds.filter((id) => id !== baseImageId).map((refId, idx) => {
                              const asset = imageById.get(refId);
                              return (
                                <div key={refId} className="flex items-center gap-2 text-ink-secondary">
                                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-subtle text-[10px]">{idx + 2}</span>
                                  <span className="truncate">参考：{asset?.filename || refId.slice(0, 8)}</span>
                                </div>
                              );
                            })}
                            {selectedReferenceIds.filter((id) => id !== baseImageId).length === 0 && (
                              <div className="pl-7 text-ink-tertiary">仅底图，无参考图</div>
                            )}
                          </div>
                        </div>

                        {/* Reference selector */}
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-medium text-ink-secondary">参考图</span>
                            <span className="text-xs text-ink-tertiary">已选 {selectedReferenceIds.filter((id) => id !== baseImageId).length} 张</span>
                            <InlineUploader projectId={projectId} onUploaded={handleUploaded} />
                          </div>
                          <p className="mb-2 text-xs text-ink-tertiary">图1 是底图，后面的图只作为参考。请在提示词里描述要改什么，不需要写图1/图2。</p>
                          {referenceCandidates.length === 0 ? (
                            <p className="text-xs text-ink-tertiary italic">无可选参考图</p>
                          ) : (
                            <div className="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 gap-2">
                              {referenceCandidates.map((candidate) => {
                                const isBase = candidate.id === baseImageId;
                                const isSelected = !isBase && selectedReferenceIds.includes(candidate.id);
                                return (
                                  <div key={candidate.id}
                                    onClick={() => toggleReference(candidate.id)}
                                    className={`relative rounded-lg border-2 overflow-hidden transition-all ${
                                      isBase
                                        ? 'border-accent/30 bg-run-tint cursor-default'
                                        : isSelected
                                        ? 'border-accent ring-1 ring-accent/30 cursor-pointer'
                                        : 'border-hairline hover:border-accent/40 cursor-pointer'
                                    }`}>
                                    <div className="aspect-square bg-surface-subtle">
                                      <HoverZoomImage
                                        src={candidate.imageUrl}
                                        alt={candidate.label}
                                        className={`w-full h-full object-cover ${isBase ? 'opacity-60' : ''}`}
                                      />
                                    </div>
                                    <div className="p-1">
                                      <div className="truncate text-[9px] text-ink-secondary">{candidate.label}</div>
                                      {isBase && <div className="text-[8px] font-medium text-accent">图1 底图</div>}
                                    </div>
                                    {isSelected && (
                                      <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white"><Icon name="check" size={12} /></div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Prompt */}
                        <div>
                          <div className="mb-1 text-xs font-medium text-ink-secondary">提示词</div>
                          <textarea value={regenPrompt} onChange={(e) => setRegenPrompt(e.target.value)}
                            rows={3} className="input-field font-mono text-sm" placeholder="输入新的提示词..." />
                        </div>

                        <div className="flex gap-2">
                          <button onClick={() => setRegenOpen(false)} className="btn-secondary btn-sm">取消</button>
                          <button onClick={handleSubmitRegen} disabled={!regenPrompt.trim()} className="btn-primary btn-sm">创建并开始重新生成</button>
                        </div>
                      </div>
                    )}

                    {/* Before/After images — dark viewer focus */}
                    <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 md:grid-cols-2">
                      <div className="flex flex-col min-h-0">
                        <div className="mb-2 text-xs text-ink-tertiary">原图</div>
                        <div className="flex-1 flex items-center justify-center min-h-0">
                          {(() => {
                            const inputAsset = images.find((img) => img.id === selectedJob.inputImageId);
                            const url = getImageUrl(inputAsset);
                            return url ? (
                              <img src={url} alt="原图" className="max-w-full max-h-full object-contain rounded-lg" />
                            ) : (
                              <div className="text-sm text-ink-tertiary">原图不可用</div>
                            );
                          })()}
                        </div>
                      </div>
                      <div className="flex flex-col min-h-0">
                        <div className="mb-2 text-xs text-ink-tertiary">结果</div>
                        <div className="flex-1 flex items-center justify-center min-h-0">
                          {selectedJob.outputFilename ? (
                            <img src={`/api/images/outputs/${selectedJob.outputFilename}`} alt="结果" className="max-w-full max-h-full object-contain rounded-lg" />
                          ) : selectedJob.status === 'failed' ? (
                            <div className="flex aspect-square w-full max-w-sm flex-col items-center justify-center rounded-lg border border-fail/30 bg-fail-tint p-4">
                              <Icon name="alert" size={24} className="mb-1 text-fail" />
                              <span className="text-center text-xs text-fail">{selectedJob.errorMessage || '生成失败'}</span>
                            </div>
                          ) : (
                            <div className="text-sm text-ink-tertiary">结果不可用</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Generation context sidebar */}
                  <GenerationContextPanel job={selectedJob} referenceImages={usedReferenceImages} />
                </div>
              </div>

              {/* ── Viewer header bar (Apple Photos style: translucent, minimal) ── */}
              <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3"
                onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-3 min-w-0">
                  <h3 className="font-medium text-sm truncate max-w-[320px] text-white/90">{selectedJob.inputFilename}</h3>
                  <span className="text-xs text-white/50 shrink-0">{selectedIndex + 1} / {selectableJobs.length}</span>
                </div>
                <button onClick={() => { setSelectedJobId(null); setRegenOpen(false); }}
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors"
                  title="关闭" aria-label="关闭">
                  <Icon name="close" size={16} />
                </button>
              </div>

              {/* ── Arrow overlays (Apple Photos style: large, translucent circles) ── */}
              {!isFirst && (
                <button onClick={(e) => { e.stopPropagation(); goPrev(); }}
                  className="absolute left-3 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 transition-all hover:bg-white/20 hover:scale-105"
                  title="上一张" aria-label="上一张">
                  <Icon name="chevron-left" size={24} />
                </button>
              )}
              {!isLast && (
                <button onClick={(e) => { e.stopPropagation(); goNext(); }}
                  className="absolute right-3 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 transition-all hover:bg-white/20 hover:scale-105"
                  title="下一张" aria-label="下一张">
                  <Icon name="chevron-right" size={24} />
                </button>
              )}

              {/* ── Viewer footer actions (Apple Photos style: translucent bar) ── */}
              <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-t border-white/10 px-4 py-3"
                onClick={(e) => e.stopPropagation()}>
                <button onClick={goPrev} disabled={isFirst} className="btn-secondary btn-sm"><Icon name="chevron-left" size={14} /> 上一张</button>
                <button onClick={goNext} disabled={isLast} className="btn-secondary btn-sm">下一张 <Icon name="chevron-right" size={14} /></button>
                <span className="mx-1 text-white/20">|</span>
                {selectedJobHasResult ? (
                  <>
                    <button onClick={() => handleMark('available')} className="btn-secondary btn-sm text-ok"><Icon name="check" size={14} /> 可用</button>
                    <button onClick={() => handleMark('rework')} className="btn-secondary btn-sm text-warn"><Icon name="retry" size={14} /> 待返工</button>
                    <button onClick={() => handleMark('discard')} className="btn-secondary btn-sm text-fail"><Icon name="trash" size={14} /> 废弃</button>
                    <span className="mx-1 text-white/20">|</span>
                    <button onClick={openRegen} className="btn-secondary btn-sm text-accent"><Icon name="retry" size={14} /> 重新生成</button>
                  </>
                ) : selectedJobIsFailed ? (
                  <button onClick={() => onRetry(selectedJob.id)} className="btn-secondary btn-sm text-accent"><Icon name="retry" size={14} /> 重试</button>
                ) : null}
                {selectedJobHasResult && onSetSceneRef && selectedJob.outputImageId && (
                  selectedSceneReference
                    ? (
                      <span
                        className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-ok"
                        title={`${getSceneReferenceBadgeLabel(selectedSceneReference)}${selectedSceneReference.imageFilename ? ` · ${selectedSceneReference.imageFilename}` : ''}`}
                      >
                        <Icon name="check" size={13} />
                        <span className="truncate">{`已设为：${selectedSceneReference.name}`}</span>
                      </span>
                    )
                    : <button onClick={() => onSetSceneRef(selectedJob.id, selectedJob.outputImageId!)} className="btn-secondary btn-sm text-accent"><Icon name="video" size={14} /> 设为场景参考图</button>
                )}
                {selectedJobHasResult && selectedJob.outputFilename && (
                  <a href={`/api/images/outputs/${selectedJob.outputFilename}`} download className="btn-primary btn-sm sm:ml-auto"><Icon name="download" size={14} /> 下载</a>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
