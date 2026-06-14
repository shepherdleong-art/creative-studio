'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ImageUploader from '@/components/ImageUploader';
import HoverZoomImage from '@/components/HoverZoomImage';
import { Icon } from '@/components/ui/Icon';

interface Shot {
  id: string;
  indexNum: number;
  sourceImageId: string;
  sourceFilename: string;
  sourceImageUrl?: string;
  latestGeneratedImageId?: string;
  generatedFilename?: string;
  generatedImageUrl?: string;
  latestJobId?: string;
  jobStatus?: string;
  jobPrompt?: string;
  reviewMark?: string;
}

const REDOABLE_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'needs_check']);
const ACTIVE_JOB_STATUSES = new Set(['pending', 'running', 'retrying', 'needs_check']);

interface ShotSet {
  id: string;
  name: string;
  productCode: string;
  category: string;
  shotCount: number;
  generatedCount: number;
  approvedCount: number;
  status: string;
  sceneReferenceId?: string;
  createdAt: string;
}

interface Props {
  projectId: string;
  images: Array<{ id: string; imageUrl?: string; filename: string; role: string; usage?: string }>;
  jobs?: Array<{ id: string; status: string; outputImageId?: string }>;
  onApplyScene?: (shotSetId: string) => void;
  onImagesUploaded?: () => void;
  onShotChanged?: () => void | Promise<void>;
  showUploader?: boolean;
  showCreateControls?: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', generating: '生成中', completed: '已完成', reviewing: '审核中', approved: '已通过', video_ready: '待生成视频',
};

export default function ShotSetPanel({ projectId, images, jobs, onApplyScene, onImagesUploaded, onShotChanged, showUploader = true, showCreateControls = true }: Props) {
  const [sets, setSets] = useState<ShotSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [shotsBySet, setShotsBySet] = useState<Record<string, Shot[]>>({});
  const [loadingShotSetIds, setLoadingShotSetIds] = useState<string[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewSetId, setPreviewSetId] = useState<string | null>(null);
  const [redoPrompt, setRedoPrompt] = useState('');
  const [redoPromptEdited, setRedoPromptEdited] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [sceneRefInfoBySet, setSceneRefInfoBySet] = useState<Record<string, { name: string; imageUrl: string } | null>>({});
  const expandedIdsRef = useRef<Set<string>>(new Set());

  const loadSets = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/shot-sets`);
      const data = await res.json();
      if (Array.isArray(data)) setSets(data);
    } catch { /* ignore */ }
    return undefined;
  }, [projectId]);

  useEffect(() => {
    let active = true;
    (async () => {
      await loadSets();
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [loadSets]);

  // ── Load shots for a set (declared before the fingerprint effect that references it) ──
  const loadShots = useCallback(async (setId: string, silent = false) => {
    if (!silent) setLoadingShotSetIds((prev) => (prev.includes(setId) ? prev : [...prev, setId]));
    try {
      const res = await fetch(`/api/shot-sets/${setId}`);
      const data = await res.json();
      if (!expandedIdsRef.current.has(setId)) return;
      setShotsBySet((prev) => ({ ...prev, [setId]: data.shots || [] }));
      if (data.sceneRefImageUrl) {
        setSceneRefInfoBySet((prev) => ({
          ...prev,
          [setId]: { name: data.sceneRefName || '场景参考', imageUrl: data.sceneRefImageUrl },
        }));
      } else {
        setSceneRefInfoBySet((prev) => ({ ...prev, [setId]: null }));
      }
    } catch { /* ignore */ }
    finally {
      if (!silent) setLoadingShotSetIds((prev) => prev.filter((id) => id !== setId));
    }
  }, []);

  // Re-fetch shot set list when the parent's jobs list changes (e.g. after a
  // job completes and loadProject() refreshes project data).  This keeps the
  // generatedCount / shot-status badges in sync without remounting the panel.
  const jobsFingerprint = useMemo(
    () => (jobs || []).map((j) => `${j.id}:${j.status}:${j.outputImageId || ''}`).join(','),
    [jobs]
  );
  useEffect(() => {
    (async () => {
      await loadSets();
      // Also refetch expanded shot sets so generated images appear immediately
      Array.from(expandedIdsRef.current).forEach((setId) => {
        loadShots(setId, true);
      });
    })();
  }, [jobsFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => { setIsCreating(true); setNewName(''); setSelectedImageIds([]); };
  const closeCreate = () => { setIsCreating(false); setNewName(''); setSelectedImageIds([]); };

  const handleCreate = async () => {
    if (!newName.trim() || selectedImageIds.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shot-sets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), shotImageIds: selectedImageIds }),
      });
      if (res.ok) { closeCreate(); await loadSets(); }
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const toggleImage = (imgId: string) => {
    setSelectedImageIds((prev) =>
      prev.includes(imgId) ? prev.filter((id) => id !== imgId) : prev.length < 9 ? [...prev, imgId] : prev
    );
  };

  const handleExpand = (setId: string) => {
    if (expandedIdsRef.current.has(setId)) {
      const next = expandedIds.filter((id) => id !== setId);
      expandedIdsRef.current = new Set(next);
      setExpandedIds(next);
      if (previewSetId === setId) closePreview();
      return;
    }
    const next = [...expandedIds, setId];
    expandedIdsRef.current = new Set(next);
    setExpandedIds(next);
    loadShots(setId);
  };

  const handleDelete = async (setId: string) => {
    if (!confirm('确定删除此分镜组？')) return;
    await fetch(`/api/shot-sets/${setId}`, { method: 'DELETE' });
    const next = expandedIds.filter((id) => id !== setId);
    expandedIdsRef.current = new Set(next);
    setExpandedIds(next);
    if (previewSetId === setId) closePreview();
    await loadSets();
  };

  // ── Shot preview + redo ──────────────────────────────────────────────
  const previewShots = useMemo(() => (previewSetId ? (shotsBySet[previewSetId] || []) : []), [previewSetId, shotsBySet]);
  const previewSceneRefInfo = previewSetId ? sceneRefInfoBySet[previewSetId] : null;

  const openPreview = (setId: string, idx: number) => {
    const nextShots = shotsBySet[setId] || [];
    setPreviewSetId(setId);
    setPreviewIndex(idx);
    setRedoPrompt(nextShots[idx]?.jobPrompt || '');
    setRedoPromptEdited(false);
    setRedoing(false);
  };
  const closePreview = () => { setPreviewIndex(null); setPreviewSetId(null); setRedoing(false); };
  const goPreview = (delta: number) => {
    setPreviewIndex((prev) => {
      if (prev === null || previewShots.length === 0) return prev;
      return Math.min(previewShots.length - 1, Math.max(0, prev + delta));
    });
  };

  // Sync redoPrompt on shot change, but never overwrite user edits
  useEffect(() => {
    if (previewIndex === null) return;
    if (redoPromptEdited) return;
    const t = setTimeout(() => setRedoPrompt(previewShots[previewIndex]?.jobPrompt || ''), 0);
    return () => clearTimeout(t);
  }, [previewIndex, previewShots, redoPromptEdited]);

  // Keyboard navigation while preview is open
  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPreviewIndex(null); setPreviewSetId(null); setRedoing(false); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        setPreviewIndex((prev) => {
          if (prev === null) return null;
          return Math.min(previewShots.length - 1, Math.max(0, prev + delta));
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIndex, previewShots]);

  // Poll shots while any job is still active (pending, running, retrying, needs_check)
  useEffect(() => {
    const activeSetIds = expandedIds.filter((setId) =>
      (shotsBySet[setId] || []).some((s) => ACTIVE_JOB_STATUSES.has(s.jobStatus || ''))
    );
    if (activeSetIds.length === 0) return;
    const t = setInterval(() => {
      activeSetIds.forEach((setId) => { loadShots(setId, true); });
    }, 2000);
    return () => clearInterval(t);
  }, [expandedIds, shotsBySet, loadShots]);

  const handleRedo = async () => {
    if (previewIndex === null || !previewSetId) return;
    const shot = previewShots[previewIndex];
    if (!shot?.latestJobId) { alert('该分镜还没有可重做的生成任务'); return; }
    if (!redoPrompt.trim()) { alert('请填写提示词'); return; }
    if (!REDOABLE_STATUSES.has(shot.jobStatus || '')) { alert('当前任务尚在生成中，请稍后再重做'); return; }
    setRedoing(true);
    try {
      const res = await fetch(`/api/jobs/${shot.latestJobId}/regenerate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: redoPrompt.trim(), markOriginal: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.newJobId) { alert('重做失败: ' + (data.error || '未知错误')); return; }
      // Repoint the shot to the new job, then kick the queue
      const patchRes = await fetch(`/api/shot-sets/${previewSetId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId: shot.id, latestJobId: data.newJobId }),
      });
      if (!patchRes.ok) { alert('更新分镜任务关联失败'); return; }
      await onShotChanged?.();
      await loadShots(previewSetId, true);
    } catch (err) {
      alert('重做失败: ' + String(err));
    } finally {
      setRedoing(false);
    }
  };

  const getImageUrl = (assetId: string) => images.find((img) => img.id === assetId)?.imageUrl || '';
  // Fallback: look up job status; prefer shot.jobStatus from API, only query if missing
  const getJobStatusFallback = (jobId?: string) => jobId ? jobs?.find((j) => j.id === jobId)?.status : undefined;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">新分镜图</h2>
          {showUploader && (
            <ImageUploader role="input" usage="shot_source" label="" maxFiles={9}
              files={[]} onUploaded={async () => { await onImagesUploaded?.(); await loadSets(); }} onRemove={() => {}}
              preprocessEnabled={true} targetMaxSide={1536} jpegQuality={85} projectId={projectId} />
          )}
        </div>
        {showCreateControls && (
          <button onClick={openCreate} className="btn-secondary btn-sm text-xs"><Icon name="plus" size={13} /> 创建分镜组</button>
        )}
      </div>

      {showCreateControls && isCreating && (
        <div className="mb-4 space-y-2 rounded-lg bg-surface-subtle p-3">
          <div>
            <label className="label">分镜组名称</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="input-field text-sm" placeholder="例如: 卧室场景分镜 1-6" />
          </div>
          <div>
            <label className="label">选择分镜图（1-9 张，拖选顺序即分镜顺序）</label>
            <div className="grid grid-cols-5 sm:grid-cols-6 gap-2 mt-1">
              {images.filter((img) => img.role === 'input' && img.usage === 'shot_source').map((img) => (
                <div key={img.id} onClick={() => toggleImage(img.id)}
                  className={`relative rounded border-2 cursor-pointer overflow-hidden ${
                    selectedImageIds.includes(img.id) ? 'border-accent' : 'border-hairline hover:border-accent/40'
                  }`}>
                  <div className="aspect-square bg-surface-subtle">
                    {img.imageUrl && <img src={img.imageUrl} alt={img.filename} className="w-full h-full object-cover" />}
                  </div>
                  {selectedImageIds.includes(img.id) && (
                    <div className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-white">
                      {selectedImageIds.indexOf(img.id) + 1}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-ink-tertiary">已选 {selectedImageIds.length}/9 张，点击顺序即为分镜顺序</p>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={!newName.trim() || selectedImageIds.length === 0 || saving}
              className="btn-primary btn-sm text-xs">{saving ? '创建中...' : '创建'}</button>
            <button onClick={closeCreate} className="btn-secondary btn-sm text-xs">取消</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-ink-tertiary">加载中...</p>
      ) : sets.length === 0 ? (
        <p className="text-sm text-ink-tertiary">暂无分镜组。选择 1-9 张原始分镜图创建分镜组，配合场景参考图批量生成。</p>
      ) : (
        <div className="space-y-2">
          {sets.map((set) => {
            const expanded = expandedIds.includes(set.id);
            const setShots = shotsBySet[set.id] || [];
            const loadingShots = loadingShotSetIds.includes(set.id);
            const sceneRefInfo = sceneRefInfoBySet[set.id];
            const displayStatus = set.shotCount > 0 && set.generatedCount >= set.shotCount ? 'completed' : set.status;
            return (
            <div key={set.id}>
              <div className="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-surface-subtle" onClick={() => handleExpand(set.id)}>
                <Icon name="chevron-right" size={13} className={`text-ink-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`} />
                <span className="text-sm font-medium flex-1">{set.name}</span>
                <span className={`pill ${displayStatus === 'approved' || displayStatus === 'completed' ? 'status-succeeded' : 'status-pending'}`}>
                  {STATUS_LABELS[displayStatus] || displayStatus}
                </span>
                <span className="text-xs text-ink-tertiary">{set.shotCount} 张 | {set.generatedCount} 已生成 | {set.approvedCount} 可用</span>
                {set.generatedCount > 0 && (
                  <a
                    href={`/api/shot-sets/${set.id}/download`}
                    onClick={(e) => e.stopPropagation()}
                    className="btn-secondary btn-sm text-xs text-accent"
                  >
                    <Icon name="download" size={13} /> 下载ZIP
                  </a>
                )}
                {onApplyScene && (
                  <button onClick={(e) => { e.stopPropagation(); onApplyScene(set.id); }}
                    className="btn-primary btn-sm text-xs">生成分镜</button>
                )}
                <button onClick={(e) => { e.stopPropagation(); handleDelete(set.id); }}
                  className="icon-btn text-ink-tertiary hover:text-fail" title="删除" aria-label="删除"><Icon name="trash" size={13} /></button>
              </div>

              {expanded && (
                <div className="mb-2 ml-6 rounded-lg bg-surface-subtle p-3">
                  {!loadingShots && sceneRefInfo && (
                    <div className="mb-3 flex items-center gap-3 rounded border border-hairline bg-white p-2">
                      <HoverZoomImage
                        src={sceneRefInfo.imageUrl}
                        alt={sceneRefInfo.name}
                        className="h-12 w-12 cursor-zoom-in rounded border border-hairline object-cover transition-colors hover:border-accent/40"
                        zoomMaxWidth={420}
                        zoomMaxHeight={320}
                      />
                      <div>
                        <div className="text-xs text-ink-tertiary">参考场景</div>
                        <div className="text-sm font-medium text-ink">{sceneRefInfo.name}</div>
                      </div>
                    </div>
                  )}
                  {loadingShots ? (
                    <p className="text-xs text-ink-tertiary">加载分镜...</p>
                  ) : setShots.length === 0 ? (
                    <p className="text-xs text-ink-tertiary">无分镜数据</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
                      {setShots.map((shot, idx) => (
                        <div key={shot.id} onClick={() => openPreview(set.id, idx)}
                          className="cursor-pointer overflow-hidden rounded border border-hairline bg-white transition hover:border-accent/40 hover:shadow-[0_8px_28px_rgba(0,0,0,.08)]">
                          <div className="px-3 pt-2 text-xs text-ink-tertiary">分镜 {shot.indexNum}</div>
                          <div className="grid grid-cols-2 gap-px">
                            <div>
                              <div className="text-center text-[10px] text-ink-tertiary">原图</div>
                              <div className="aspect-[4/3] bg-surface-subtle">
                                {(shot.sourceImageUrl || getImageUrl(shot.sourceImageId)) && (
                                  <img src={shot.sourceImageUrl || getImageUrl(shot.sourceImageId)} alt="原图" className="w-full h-full object-cover" />
                                )}
                              </div>
                            </div>
                            <div>
                              <div className="text-center text-[10px] text-ink-tertiary">结果</div>
                              <div className="aspect-[4/3] bg-surface-subtle">
                                {(shot.generatedImageUrl || (shot.latestGeneratedImageId ? getImageUrl(shot.latestGeneratedImageId) : null)) ? (
                                  <img src={shot.generatedImageUrl || getImageUrl(shot.latestGeneratedImageId!)} alt="结果" className="w-full h-full object-cover" />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center text-[10px] text-ink-tertiary">
                                    {shot.jobStatus === 'running' ? '生成中' : shot.jobStatus === 'failed' ? '失败' : shot.jobStatus === 'succeeded' ? '生成完成' : shot.latestJobId ? (getJobStatusFallback(shot.latestJobId) === 'running' ? '生成中' : '等待中') : '-'}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="truncate px-3 py-2 text-[11px] text-ink-tertiary">{shot.sourceFilename}</div>
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {previewIndex !== null && previewShots[previewIndex] && (() => {
        const shot = previewShots[previewIndex];
        const sourceUrl = shot.sourceImageUrl || getImageUrl(shot.sourceImageId);
        const genUrl = shot.generatedImageUrl || (shot.latestGeneratedImageId ? getImageUrl(shot.latestGeneratedImageId) : '');
        const refUrl = previewSceneRefInfo?.imageUrl || '';
        const generating = shot.jobStatus === 'pending' || shot.jobStatus === 'running';
        const canRedo = !!shot.latestJobId && REDOABLE_STATUSES.has(shot.jobStatus || '');
        const isFirst = previewIndex === 0;
        const isLast = previewIndex === previewShots.length - 1;
        return (
          <div className="theme-dark fixed inset-0 z-[100] flex flex-col overflow-hidden bg-black/95" onClick={closePreview}>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
              {/* Header — title + count + close only (no nav, matches ResultGallery) */}
              <div className="flex shrink-0 items-center justify-between border-b border-white/10 p-4">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-medium text-ink">分镜 {shot.indexNum}</h3>
                  <span className="text-xs text-ink-tertiary">{previewIndex + 1} / {previewShots.length}</span>
                  {generating && <span className="text-xs text-accent">生成中…</span>}
                </div>
                <button onClick={closePreview} className="flex items-center justify-center w-8 h-8 rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors" title="关闭" aria-label="关闭"><Icon name="close" size={16} /></button>
              </div>

              {/* Image area — with overlay arrows (matches ResultGallery) */}
              <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_18rem]">
                <div className={`relative grid min-w-0 gap-6 overflow-y-auto overflow-x-hidden p-6 ${refUrl ? 'grid-cols-1 xl:grid-cols-3' : 'grid-cols-1 md:grid-cols-2'}`}>
                  {!isFirst && (
                    <button onClick={() => goPreview(-1)}
                      className="absolute -left-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 transition-all hover:bg-white/20 hover:scale-105"
                      title="上一个"><Icon name="chevron-left" size={22} /></button>
                  )}
                  {!isLast && (
                    <button onClick={() => goPreview(1)}
                      className="absolute -right-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 transition-all hover:bg-white/20 hover:scale-105"
                      title="下一个"><Icon name="chevron-right" size={22} /></button>
                  )}
                  <div className="min-w-0">
                    <div className="mb-1 text-xs text-ink-tertiary">原图</div>
                    {sourceUrl ? <img src={sourceUrl} alt="原图" className="max-h-[72vh] max-w-full rounded-lg border border-hairline object-contain" /> : <div className="text-sm text-ink-tertiary">原图不可用</div>}
                  </div>
                  {refUrl && (
                    <div className="min-w-0">
                      <div className="mb-1 text-xs text-ink-tertiary">参考图</div>
                      <img src={refUrl} alt={previewSceneRefInfo?.name || '参考图'} className="max-h-[72vh] max-w-full rounded-lg border border-hairline object-contain" />
                      {previewSceneRefInfo?.name && (
                        <div className="mt-1 truncate text-[11px] text-ink-tertiary" title={previewSceneRefInfo.name}>{previewSceneRefInfo.name}</div>
                      )}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="mb-1 text-xs text-ink-tertiary">结果</div>
                    {genUrl ? <img src={genUrl} alt="结果" className="max-h-[72vh] max-w-full rounded-lg border border-hairline object-contain" /> : <div className="flex aspect-square items-center justify-center rounded-lg border border-hairline bg-surface-subtle text-sm text-ink-tertiary">{generating ? '生成中…' : '暂无结果'}</div>}
                  </div>
                </div>

                <aside className="hidden overflow-y-auto border-l border-white/10 bg-black/55 p-4 lg:block">
                  <h4 className="mb-4 text-sm font-semibold text-white/90">生成上下文</h4>
                  <div className="mb-5 space-y-4">
                    <section>
                      <div className="mb-1 text-xs font-medium text-white/50">分镜</div>
                      <div className="text-sm text-white/85">分镜 {shot.indexNum}</div>
                      <div className="mt-1 text-xs text-white/45">{previewIndex + 1} / {previewShots.length}</div>
                    </section>
                    <section>
                      <div className="mb-1 text-xs font-medium text-white/50">状态</div>
                      <span className={`status-badge status-${generating ? 'running' : shot.jobStatus === 'failed' ? 'failed' : shot.jobStatus === 'succeeded' ? 'succeeded' : 'pending'}`}>
                        {generating ? '生成中' : shot.jobStatus === 'succeeded' ? '成功' : shot.jobStatus === 'failed' ? '失败' : shot.jobStatus || '等待'}
                      </span>
                    </section>
                    <section>
                      <div className="mb-1 text-xs font-medium text-white/50">参考图</div>
                      <div className="text-xs leading-relaxed text-white/75">{previewSceneRefInfo?.name || '无参考图'}</div>
                    </section>
                  </div>

                  {/* Redo area */}
                  <div className="border-t border-white/10 pt-4">
                  <label className="label">重做提示词</label>
                  <textarea value={redoPrompt} onChange={(e) => { setRedoPrompt(e.target.value); setRedoPromptEdited(true); }} rows={8} className="input-field mt-1 font-mono text-xs leading-relaxed" placeholder="编辑提示词后点重新生成" />
                  <div className="mt-3 flex flex-col items-stretch gap-2">
                    <button onClick={handleRedo} disabled={redoing || !canRedo || !redoPrompt.trim()} className="btn-primary btn-sm w-full text-xs">{redoing ? '提交中…' : '重新生成'}</button>
                    {!canRedo && <span className="text-[11px] text-ink-tertiary">{shot.latestJobId ? '任务生成中，完成后可重做' : '该分镜尚未生成，无法重做'}</span>}
                  </div>
                  </div>
                </aside>
              </div>

              {/* Bottom nav bar (matches ResultGallery footer) */}
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/10 p-3">
                <button onClick={() => goPreview(-1)} disabled={isFirst} className="btn-secondary btn-sm text-xs disabled:opacity-40"><Icon name="chevron-left" size={13} /> 上一张</button>
                <button onClick={() => goPreview(1)} disabled={isLast} className="btn-secondary btn-sm text-xs disabled:opacity-40">下一张 <Icon name="chevron-right" size={13} /></button>
                <span className="mx-1 text-white/20">|</span>
                <button onClick={handleRedo} disabled={redoing || !canRedo || !redoPrompt.trim()} className="btn-secondary btn-sm text-xs text-accent"><Icon name="retry" size={13} /> {redoing ? '提交中…' : '重新生成'}</button>
                {genUrl && <a href={genUrl} download className="btn-primary btn-sm text-xs sm:ml-auto"><Icon name="download" size={13} /> 下载</a>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
