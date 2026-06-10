'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

type HoverPreviewState = {
  src: string;
  title: string;
  x: number;
  y: number;
} | null;

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

export type RegeneratePayload = {
  prompt: string;
  inputSource: 'original' | 'current_result';
  referenceImageIds: string[];
};

interface Props {
  jobs: Job[];
  images: ImageAsset[];
  onRetry: (jobId: string) => void;
  onMark: (jobId: string, mark: string) => void;
  onRegenerate: (jobId: string, payload: RegeneratePayload) => void;
  onSetSceneRef?: (jobId: string, imageAssetId: string) => void;
  projectId?: string;
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
    <label className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800 cursor-pointer">
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleChange} className="hidden" />
      {uploading ? '上传中…' : '+ 添加参考图'}
    </label>
  );
}

/** ── Hover image preview overlay ── */
function HoverImagePreview({ preview }: { preview: HoverPreviewState }) {
  if (!preview) return null;

  const maxWidth = 280;
  const maxHeight = 220;
  const gap = 14;
  const left = Math.min(preview.x + gap, window.innerWidth - maxWidth - 12);
  const top = Math.min(preview.y + gap, window.innerHeight - maxHeight - 12);

  return (
    <div
      className="fixed z-[80] pointer-events-none rounded-lg border border-gray-700 bg-gray-900/95 p-2 shadow-2xl"
      style={{ left, top, maxWidth }}
    >
      <img
        src={preview.src}
        alt={preview.title}
        className="block max-h-[220px] max-w-[280px] rounded object-contain"
      />
      <div className="mt-1 max-w-[260px] truncate text-[10px] text-gray-200">
        {preview.title}
      </div>
    </div>
  );
}

/** ── Generation context sidebar ── */
function GenerationContextPanel({
  job, referenceImages, providerName, onHoverPreview,
}: {
  job: Job;
  referenceImages: ImageAsset[];
  providerName?: string;
  onHoverPreview: (state: HoverPreviewState) => void;
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
    <aside className="w-64 shrink-0 border-l border-gray-100 p-3 overflow-y-auto text-xs">
      <h4 className="font-medium text-gray-700 mb-3">生成上下文</h4>

      {/* Reference images */}
      <div className="mb-4">
        <div className="text-gray-500 mb-1.5">参考图</div>
        {referenceImages.length === 0 ? (
          <p className="text-gray-400 italic">无参考图</p>
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
                onMouseEnter={(e) => img.imageUrl && onHoverPreview({ src: img.imageUrl, title: img.filename, x: e.clientX, y: e.clientY })}
                onMouseMove={(e) => img.imageUrl && onHoverPreview({ src: img.imageUrl, title: img.filename, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => onHoverPreview(null)}
                onFocus={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (img.imageUrl) onHoverPreview({ src: img.imageUrl, title: img.filename, x: rect.right, y: rect.top });
                }}
                onBlur={() => onHoverPreview(null)}
              >
                <img
                  src={img.imageUrl || ''}
                  alt={img.filename}
                  className="w-full aspect-square object-cover rounded border border-gray-200 hover:border-blue-400 transition-colors"
                />
                <div className="text-[9px] text-gray-400 truncate mt-0.5">{img.filename}</div>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Prompt */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-gray-500">提示词</span>
          {job.prompt && (
            <button onClick={handleCopyPrompt} className="text-[10px] text-blue-500 hover:text-blue-700">
              {copied ? '已复制 ✓' : '复制'}
            </button>
          )}
        </div>
        <div className="bg-gray-50 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-gray-600 leading-relaxed">
          {job.prompt || <span className="text-gray-400 italic">无提示词</span>}
        </div>
      </div>

      {/* Parameters */}
      <div>
        <div className="text-gray-500 mb-1.5">参数</div>
        <div className="space-y-1 text-gray-500">
          {providerName && <div>供应商: <span className="text-gray-700">{providerName}</span></div>}
          {job.model && <div>模型: <span className="text-gray-700">{job.model}</span></div>}
          {job.size && <div>尺寸: <span className="text-gray-700">{job.size}</span></div>}
          {job.quality && <div>质量: <span className="text-gray-700">{job.quality}</span></div>}
          {job.revision != null && <div>版本: <span className="text-gray-700">r{job.revision}</span></div>}
        </div>
      </div>
    </aside>
  );
}

export default function ResultGallery({ jobs, images, onMark, onRegenerate, onSetSceneRef, projectId }: Props) {
  const succeededJobs = jobs.filter((j) => j.status === 'succeeded' && j.outputFilename);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [regenInputSource, setRegenInputSource] = useState<'original' | 'current_result'>('original');
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [extraUploads, setExtraUploads] = useState<ImageAsset[]>([]);
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState>(null);
  const selectedJob = selectedIndex != null ? succeededJobs[selectedIndex] : null;

  const getImageUrl = (asset: ImageAsset | undefined): string | null => asset?.imageUrl || null;
  const getMark = (job: Job): string | null => job.reviewMark || null;

  const goPrev = useCallback(() => {
    setSelectedIndex((i) => (i != null ? Math.max(0, i - 1) : null));
  }, []);
  const goNext = useCallback(() => {
    setSelectedIndex((i) => (i != null ? Math.min(succeededJobs.length - 1, i + 1) : null));
  }, [succeededJobs.length]);

  useEffect(() => {
    if (selectedIndex == null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedIndex(null);
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedIndex, goPrev, goNext]);

  const handleMark = (mark: string) => { if (!selectedJob) return; onMark(selectedJob.id, mark); };

  // ── Current base image ID ──
  const baseImageId = useMemo(() => {
    if (!selectedJob) return null;
    return regenInputSource === 'current_result' ? selectedJob.outputImageId ?? null : selectedJob.inputImageId;
  }, [selectedJob, regenInputSource]);

  // ── Image lookup ──
  const imageById = useMemo(() => new Map(images.map((img) => [img.id, img])), [images]);

  // ── Reference images used in the current job (for sidebar) ──
  const usedReferenceImages = useMemo(() => {
    if (!selectedJob || !selectedJob.referenceImageIds) return [];
    try {
      const ids: string[] = JSON.parse(selectedJob.referenceImageIds);
      return ids.map((id) => imageById.get(id)).filter(Boolean) as ImageAsset[];
    } catch { return []; }
  }, [selectedJob, imageById]);

  // ── Reference candidates for the regen panel ──
  const referenceCandidates = useMemo(() => {
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
  }, [selectedJob, regenInputSource, images, succeededJobs, extraUploads, imageById]);

  // ── Initialize regen state ──
  const openRegen = useCallback(() => {
    if (!selectedJob) return;
    setRegenPrompt(selectedJob.prompt || '');
    setRegenInputSource('original');
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
  }, [selectedJob]);

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
    });
    setRegenOpen(false);
  };

  const hasOutput = selectedJob?.outputImageId && imageById.has(selectedJob.outputImageId);
  const isFirst = selectedIndex === 0;
  const isLast = selectedIndex === succeededJobs.length - 1;

  return (
    <div>
      {succeededJobs.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-2">🖼️</div>
          <p>暂无成功生成的图片</p>
        </div>
      ) : (
        <>
          {/* ── Grid ── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {succeededJobs.map((job, idx) => {
              const mark = getMark(job);
              return (
                <div key={job.id} onClick={() => setSelectedIndex(idx)}
                  className={`card overflow-hidden cursor-pointer group transition-all hover:ring-2 hover:ring-blue-400 ${mark === 'discard' ? 'opacity-40' : ''}`}>
                  <div className="aspect-square relative bg-gray-100">
                    <img src={`/api/images/outputs/${job.outputFilename}`} alt={job.inputFilename} className="w-full h-full object-cover" />
                    {mark && (
                      <span className={`absolute top-1 left-1 text-xs px-1.5 py-0.5 rounded ${
                        mark === 'available' ? 'bg-green-500 text-white' : mark === 'rework' ? 'bg-yellow-500 text-white' : 'bg-gray-500 text-white'}`}>
                        {{ available: '可用', rework: '返工', discard: '废弃' }[mark]}
                      </span>
                    )}
                  </div>
                  <div className="p-2"><div className="text-xs text-gray-500 truncate">{job.inputFilename}</div></div>
                </div>
              );
            })}
          </div>

          {/* ── Modal ── */}
          {selectedJob && selectedIndex != null && (
            <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
              onClick={() => { setSelectedIndex(null); setRegenOpen(false); setHoverPreview(null); }}>
              <div className="bg-white rounded-xl max-w-[68rem] w-full max-h-[90vh] overflow-hidden flex flex-col"
                onClick={(e) => e.stopPropagation()}>

                <HoverImagePreview preview={hoverPreview} />

                {/* Header */}
                <div className="p-4 border-b flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-3">
                    <h3 className="font-medium text-sm truncate max-w-[300px]">{selectedJob.inputFilename}</h3>
                    <span className="text-xs text-gray-400">{selectedIndex + 1} / {succeededJobs.length}</span>
                  </div>
                  <button onClick={() => { setSelectedIndex(null); setRegenOpen(false); setHoverPreview(null); }}
                    className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
                </div>

                {/* Body: images + sidebar */}
                <div className="flex overflow-hidden flex-1 min-h-0">
                  {/* Main image area */}
                  <div className="flex-1 p-4 overflow-y-auto">
                    {/* Regenerate panel (above images when open) */}
                    {regenOpen && (
                      <div className="mb-4 p-4 bg-purple-50 rounded-lg space-y-4">
                        <h4 className="text-sm font-semibold text-purple-900">重新生成设置</h4>

                        {/* Base image selector */}
                        <div>
                          <div className="text-xs font-medium text-gray-600 mb-2">编辑底图</div>
                          <div className="flex gap-2">
                            <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${
                              regenInputSource === 'original' ? 'border-purple-400 bg-purple-100 text-purple-800' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>
                              <input type="radio" name="inputSource" value="original" checked={regenInputSource === 'original'}
                                onChange={() => handleInputSourceChange('original')} className="sr-only" />原图
                            </label>
                            <label className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${
                              regenInputSource === 'current_result' ? 'border-purple-400 bg-purple-100 text-purple-800' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'} ${!hasOutput ? 'opacity-40 cursor-not-allowed' : ''}`}>
                              <input type="radio" name="inputSource" value="current_result" checked={regenInputSource === 'current_result'}
                                onChange={() => handleInputSourceChange('current_result')} disabled={!hasOutput} className="sr-only" />当前结果
                            </label>
                          </div>
                          <p className="text-xs text-gray-400 mt-1">
                            {regenInputSource === 'current_result' ? '基于当前生成结果继续编辑' : '基于原始输入图重新生成'}
                          </p>
                        </div>

                        {/* Send order preview */}
                        <div>
                          <div className="text-xs font-medium text-gray-600 mb-2">本次发送顺序</div>
                          <div className="bg-white rounded border border-gray-200 p-2 space-y-1 text-xs">
                            <div className="flex items-center gap-2 text-gray-700">
                              <span className="w-5 h-5 rounded bg-purple-100 text-purple-700 flex items-center justify-center text-[10px] font-bold shrink-0">1</span>
                              <span>底图：{regenInputSource === 'current_result' ? '当前结果' : '原图'}</span>
                            </div>
                            {selectedReferenceIds.filter((id) => id !== baseImageId).map((refId, idx) => {
                              const asset = imageById.get(refId);
                              return (
                                <div key={refId} className="flex items-center gap-2 text-gray-500">
                                  <span className="w-5 h-5 rounded bg-gray-100 text-gray-500 flex items-center justify-center text-[10px] shrink-0">{idx + 2}</span>
                                  <span className="truncate">参考：{asset?.filename || refId.slice(0, 8)}</span>
                                </div>
                              );
                            })}
                            {selectedReferenceIds.filter((id) => id !== baseImageId).length === 0 && (
                              <div className="text-gray-400 pl-7">仅底图，无参考图</div>
                            )}
                          </div>
                        </div>

                        {/* Reference selector */}
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-medium text-gray-600">参考图</span>
                            <span className="text-xs text-gray-400">已选 {selectedReferenceIds.filter((id) => id !== baseImageId).length} 张</span>
                            <InlineUploader projectId={projectId} onUploaded={handleUploaded} />
                          </div>
                          <p className="text-xs text-gray-400 mb-2">图1 是底图，后面的图只作为参考。请在提示词里描述要改什么，不需要写图1/图2。</p>
                          {referenceCandidates.length === 0 ? (
                            <p className="text-xs text-gray-400 italic">无可选参考图</p>
                          ) : (
                            <div className="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 gap-2">
                              {referenceCandidates.map((candidate) => {
                                const isBase = candidate.id === baseImageId;
                                const isSelected = !isBase && selectedReferenceIds.includes(candidate.id);
                                return (
                                  <div key={candidate.id}
                                    onClick={() => toggleReference(candidate.id)}
                                    onMouseEnter={(e) => candidate.imageUrl && setHoverPreview({ src: candidate.imageUrl, title: candidate.label, x: e.clientX, y: e.clientY })}
                                    onMouseMove={(e) => candidate.imageUrl && setHoverPreview({ src: candidate.imageUrl, title: candidate.label, x: e.clientX, y: e.clientY })}
                                    onMouseLeave={() => setHoverPreview(null)}
                                    className={`relative rounded-lg border-2 overflow-hidden transition-all ${
                                      isBase
                                        ? 'border-purple-300 bg-purple-50 cursor-default'
                                        : isSelected
                                        ? 'border-purple-500 ring-1 ring-purple-300 cursor-pointer'
                                        : 'border-gray-200 hover:border-gray-300 cursor-pointer'
                                    }`}>
                                    <div className="aspect-square bg-gray-100">
                                      <img src={candidate.imageUrl} alt={candidate.label} className={`w-full h-full object-cover ${isBase ? 'opacity-60' : ''}`} />
                                    </div>
                                    <div className="p-1">
                                      <div className="text-[9px] text-gray-500 truncate">{candidate.label}</div>
                                      {isBase && <div className="text-[8px] text-purple-600 font-medium">图1 底图</div>}
                                    </div>
                                    {isSelected && (
                                      <div className="absolute top-1 right-1 w-5 h-5 bg-purple-500 text-white rounded-full flex items-center justify-center text-xs">✓</div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Prompt */}
                        <div>
                          <div className="text-xs font-medium text-gray-600 mb-1">提示词</div>
                          <textarea value={regenPrompt} onChange={(e) => setRegenPrompt(e.target.value)}
                            rows={3} className="input-field font-mono text-sm" placeholder="输入新的提示词..." />
                        </div>

                        <div className="flex gap-2">
                          <button onClick={() => setRegenOpen(false)} className="btn-secondary btn-sm">取消</button>
                          <button onClick={handleSubmitRegen} disabled={!regenPrompt.trim()} className="btn-primary btn-sm">创建并开始重新生成</button>
                        </div>
                      </div>
                    )}

                    {/* Before/After images */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-gray-500 mb-1">原图</div>
                        {(() => {
                          const inputAsset = images.find((img) => img.id === selectedJob.inputImageId);
                          const url = getImageUrl(inputAsset);
                          return url ? <img src={url} alt="原图" className="w-full rounded-lg border" />
                            : <div className="text-gray-400 text-sm">原图不可用</div>;
                        })()}
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-1">结果</div>
                        <img src={`/api/images/outputs/${selectedJob.outputFilename}`} alt="结果" className="w-full rounded-lg border" />
                      </div>
                    </div>
                  </div>

                  {/* Generation context sidebar */}
                  <GenerationContextPanel job={selectedJob} referenceImages={usedReferenceImages} onHoverPreview={setHoverPreview} />
                </div>

                {/* Arrow overlays */}
                {!isFirst && (
                  <button onClick={goPrev}
                    className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 hover:bg-black/60 text-white rounded-full flex items-center justify-center text-2xl transition-colors z-10"
                    title="上一张 (←)">‹</button>
                )}
                {!isLast && (
                  <button onClick={goNext}
                    className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 hover:bg-black/60 text-white rounded-full flex items-center justify-center text-2xl transition-colors z-10"
                    title="下一张 (→)">›</button>
                )}

                {/* Footer actions */}
                <div className="p-4 border-t flex gap-2 flex-wrap items-center shrink-0">
                  <button onClick={goPrev} disabled={isFirst} className="btn-secondary btn-sm">‹ 上一张</button>
                  <button onClick={goNext} disabled={isLast} className="btn-secondary btn-sm">下一张 ›</button>
                  <span className="text-gray-300 mx-1">|</span>
                  <button onClick={() => handleMark('available')} className="btn-secondary btn-sm text-green-700">✅ 可用</button>
                  <button onClick={() => handleMark('rework')} className="btn-secondary btn-sm text-yellow-700">🔄 待返工</button>
                  <button onClick={() => handleMark('discard')} className="btn-secondary btn-sm text-red-700">🗑️ 废弃</button>
                  <span className="text-gray-300 mx-1">|</span>
                  <button onClick={openRegen} className="btn-secondary btn-sm text-purple-700">🔄 重新生成</button>
                  {onSetSceneRef && selectedJob.outputImageId && (
                    <button onClick={() => onSetSceneRef(selectedJob.id, selectedJob.outputImageId!)}
                      className="btn-secondary btn-sm text-blue-700">🎬 设为场景参考图</button>
                  )}
                  <a href={`/api/images/outputs/${selectedJob.outputFilename}`} download className="btn-primary btn-sm ml-auto">下载</a>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
