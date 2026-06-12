'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import ImageUploader from '@/components/ImageUploader';

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
  draft: '草稿', generating: '生成中', reviewing: '审核中', approved: '已通过', video_ready: '待生成视频',
};

export default function ShotSetPanel({ projectId, images, jobs, onApplyScene, onImagesUploaded, onShotChanged, showUploader = true, showCreateControls = true }: Props) {
  const [sets, setSets] = useState<ShotSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [loadingShots, setLoadingShots] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [redoPrompt, setRedoPrompt] = useState('');
  const [redoing, setRedoing] = useState(false);
  const [sceneRefInfo, setSceneRefInfo] = useState<{ name: string; imageUrl: string } | null>(null);
  const expandedIdRef = useRef<string | null>(null);

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

  const loadShots = useCallback(async (setId: string, silent = false) => {
    if (!silent) setLoadingShots(true);
    try {
      const res = await fetch(`/api/shot-sets/${setId}`);
      const data = await res.json();
      // Race guard using ref — avoids stale-closure from useCallback
      if (expandedIdRef.current !== setId) return;
      if (data.shots) setShots(data.shots);
      if (data.sceneRefImageUrl) {
        setSceneRefInfo({ name: data.sceneRefName || '场景参考', imageUrl: data.sceneRefImageUrl });
      } else {
        setSceneRefInfo(null);
      }
    } catch { /* ignore */ }
    finally { if (!silent) setLoadingShots(false); }
  }, []);

  const handleExpand = (setId: string) => {
    if (expandedId === setId) { setExpandedId(null); expandedIdRef.current = null; return; }
    setExpandedId(setId);
    expandedIdRef.current = setId;
    loadShots(setId);
  };

  const handleDelete = async (setId: string) => {
    if (!confirm('确定删除此分镜组？')) return;
    await fetch(`/api/shot-sets/${setId}`, { method: 'DELETE' });
    if (expandedId === setId) setExpandedId(null);
    await loadSets();
  };

  // ── Shot preview + redo ──────────────────────────────────────────────
  const openPreview = (idx: number) => {
    setPreviewIndex(idx);
    setRedoPrompt(shots[idx]?.jobPrompt || '');
    setRedoing(false);
  };
  const closePreview = () => { setPreviewIndex(null); setRedoing(false); };
  const goPreview = (delta: number) => {
    setPreviewIndex((prev) => {
      if (prev === null || shots.length === 0) return prev;
      return Math.min(shots.length - 1, Math.max(0, prev + delta));
    });
  };

  // Sync redoPrompt whenever previewIndex changes
  useEffect(() => {
    if (previewIndex === null) return;
    const t = setTimeout(() => setRedoPrompt(shots[previewIndex]?.jobPrompt || ''), 0);
    return () => clearTimeout(t);
  }, [previewIndex, shots]);

  // Keyboard navigation while preview is open
  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPreviewIndex(null); setRedoing(false); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        setPreviewIndex((prev) => {
          if (prev === null) return null;
          return Math.min(shots.length - 1, Math.max(0, prev + delta));
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIndex, shots]);

  // Poll shots while any is generating or while the preview is open
  useEffect(() => {
    if (!expandedId) return;
    const anyActive = shots.some((s) => s.jobStatus === 'pending' || s.jobStatus === 'running');
    if (!anyActive && previewIndex === null) return;
    const t = setInterval(() => { loadShots(expandedId, true); }, 2000);
    return () => clearInterval(t);
  }, [expandedId, shots, previewIndex, loadShots]);

  const handleRedo = async () => {
    if (previewIndex === null) return;
    const shot = shots[previewIndex];
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
      const patchRes = await fetch(`/api/shot-sets/${expandedId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId: shot.id, latestJobId: data.newJobId }),
      });
      if (!patchRes.ok) { alert('更新分镜任务关联失败'); return; }
      await onShotChanged?.();
      if (expandedId) await loadShots(expandedId, true);
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
          <button onClick={openCreate} className="btn-secondary btn-sm text-xs">+ 创建分镜组</button>
        )}
      </div>

      {showCreateControls && isCreating && (
        <div className="mb-4 p-3 bg-gray-50 rounded-lg space-y-2">
          <div>
            <label className="text-xs text-gray-500">分镜组名称</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="input-field text-sm" placeholder="例如: 卧室场景分镜 1-6" />
          </div>
          <div>
            <label className="text-xs text-gray-500">选择分镜图（1-9 张，拖选顺序即分镜顺序）</label>
            <div className="grid grid-cols-5 sm:grid-cols-6 gap-2 mt-1">
              {images.filter((img) => img.role === 'input' && img.usage === 'shot_source').map((img) => (
                <div key={img.id} onClick={() => toggleImage(img.id)}
                  className={`relative rounded border-2 cursor-pointer overflow-hidden ${
                    selectedImageIds.includes(img.id) ? 'border-purple-500' : 'border-gray-200 hover:border-gray-300'
                  }`}>
                  <div className="aspect-square bg-gray-100">
                    {img.imageUrl && <img src={img.imageUrl} alt={img.filename} className="w-full h-full object-cover" />}
                  </div>
                  {selectedImageIds.includes(img.id) && (
                    <div className="absolute top-1 left-1 w-5 h-5 bg-purple-500 text-white rounded-full flex items-center justify-center text-[10px] font-bold">
                      {selectedImageIds.indexOf(img.id) + 1}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-1">已选 {selectedImageIds.length}/9 张，点击顺序即为分镜顺序</p>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={!newName.trim() || selectedImageIds.length === 0 || saving}
              className="btn-primary btn-sm text-xs">{saving ? '创建中...' : '创建'}</button>
            <button onClick={closeCreate} className="btn-secondary btn-sm text-xs">取消</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">加载中...</p>
      ) : sets.length === 0 ? (
        <p className="text-sm text-gray-400">暂无分镜组。选择 1-9 张原始分镜图创建分镜组，配合场景参考图批量生成。</p>
      ) : (
        <div className="space-y-2">
          {sets.map((set) => (
            <div key={set.id}>
              <div className="flex items-center gap-3 p-2 hover:bg-gray-50 rounded cursor-pointer" onClick={() => handleExpand(set.id)}>
                <span className="text-xs text-gray-400">{expandedId === set.id ? '▼' : '▶'}</span>
                <span className="text-sm font-medium flex-1">{set.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${set.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                  {STATUS_LABELS[set.status] || set.status}
                </span>
                <span className="text-xs text-gray-400">{set.shotCount} 张 | {set.generatedCount} 已生成 | {set.approvedCount} 可用</span>
                {set.generatedCount > 0 && (
                  <a
                    href={`/api/shot-sets/${set.id}/download`}
                    onClick={(e) => e.stopPropagation()}
                    className="btn-secondary btn-sm text-xs text-blue-600"
                  >
                    下载ZIP
                  </a>
                )}
                {onApplyScene && (
                  <button onClick={(e) => { e.stopPropagation(); onApplyScene(set.id); }}
                    className="btn-primary btn-sm text-xs">生成分镜</button>
                )}
                <button onClick={(e) => { e.stopPropagation(); handleDelete(set.id); }}
                  className="text-xs text-gray-400 hover:text-red-500">删除</button>
              </div>

              {expandedId === set.id && (
                <div className="ml-6 mb-2 p-3 bg-gray-50 rounded-lg">
                  {!loadingShots && sceneRefInfo && (
                    <div className="mb-3 flex items-center gap-3 rounded border bg-white p-2">
                      <img src={sceneRefInfo.imageUrl} alt={sceneRefInfo.name} className="h-12 w-12 rounded border object-cover" />
                      <div>
                        <div className="text-xs text-gray-400">参考场景</div>
                        <div className="text-sm font-medium text-gray-700">{sceneRefInfo.name}</div>
                      </div>
                    </div>
                  )}
                  {loadingShots ? (
                    <p className="text-xs text-gray-400">加载分镜...</p>
                  ) : shots.length === 0 ? (
                    <p className="text-xs text-gray-400">无分镜数据</p>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                      {shots.map((shot, idx) => (
                        <div key={shot.id} onClick={() => openPreview(idx)}
                          className="border rounded overflow-hidden bg-white cursor-pointer hover:border-purple-300 hover:shadow-sm transition">
                          <div className="text-[10px] text-gray-400 px-2 pt-1">分镜 {shot.indexNum}</div>
                          <div className="grid grid-cols-2 gap-px">
                            <div>
                              <div className="text-[8px] text-gray-400 text-center">原图</div>
                              <div className="aspect-square bg-gray-100">
                                {(shot.sourceImageUrl || getImageUrl(shot.sourceImageId)) && (
                                  <img src={shot.sourceImageUrl || getImageUrl(shot.sourceImageId)} alt="原图" className="w-full h-full object-cover" />
                                )}
                              </div>
                            </div>
                            <div>
                              <div className="text-[8px] text-gray-400 text-center">结果</div>
                              <div className="aspect-square bg-gray-100">
                                {(shot.generatedImageUrl || (shot.latestGeneratedImageId ? getImageUrl(shot.latestGeneratedImageId) : null)) ? (
                                  <img src={shot.generatedImageUrl || getImageUrl(shot.latestGeneratedImageId!)} alt="结果" className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400">
                                    {shot.jobStatus === 'running' ? '生成中' : shot.jobStatus === 'failed' ? '失败' : shot.jobStatus === 'succeeded' ? '生成完成' : shot.latestJobId ? (getJobStatusFallback(shot.latestJobId) === 'running' ? '生成中' : '等待中') : '-'}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="px-2 pb-1 text-[10px] text-gray-400 truncate">{shot.sourceFilename}</div>
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {previewIndex !== null && shots[previewIndex] && (() => {
        const shot = shots[previewIndex];
        const sourceUrl = shot.sourceImageUrl || getImageUrl(shot.sourceImageId);
        const genUrl = shot.generatedImageUrl || (shot.latestGeneratedImageId ? getImageUrl(shot.latestGeneratedImageId) : '');
        const generating = shot.jobStatus === 'pending' || shot.jobStatus === 'running';
        const canRedo = !!shot.latestJobId && REDOABLE_STATUSES.has(shot.jobStatus || '');
        const isFirst = previewIndex === 0;
        const isLast = previewIndex === shots.length - 1;
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" onClick={closePreview}>
            <div className="flex max-h-[90vh] w-full max-w-[64rem] flex-col overflow-hidden rounded-xl bg-white" onClick={(e) => e.stopPropagation()}>
              {/* Header — title + count + close only (no nav, matches ResultGallery) */}
              <div className="flex shrink-0 items-center justify-between border-b p-4">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-medium">分镜 {shot.indexNum}</h3>
                  <span className="text-xs text-gray-400">{previewIndex + 1} / {shots.length}</span>
                  {generating && <span className="text-xs text-blue-500">生成中…</span>}
                </div>
                <button onClick={closePreview} className="text-xl leading-none text-gray-400 hover:text-gray-600">×</button>
              </div>

              {/* Image area — with overlay arrows (matches ResultGallery) */}
              <div className="relative overflow-y-auto p-4">
                <div className="relative grid grid-cols-2 gap-4">
                  {!isFirst && (
                    <button onClick={() => goPreview(-1)}
                      className="absolute -left-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 hover:bg-black/60 text-white rounded-full flex items-center justify-center text-2xl transition-colors z-10"
                      title="上一个 (←)">‹</button>
                  )}
                  {!isLast && (
                    <button onClick={() => goPreview(1)}
                      className="absolute -right-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/40 hover:bg-black/60 text-white rounded-full flex items-center justify-center text-2xl transition-colors z-10"
                      title="下一个 (→)">›</button>
                  )}
                  <div>
                    <div className="mb-1 text-xs text-gray-500">原图</div>
                    {sourceUrl ? <img src={sourceUrl} alt="原图" className="w-full rounded-lg border" /> : <div className="text-sm text-gray-400">原图不可用</div>}
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-gray-500">结果</div>
                    {genUrl ? <img src={genUrl} alt="结果" className="w-full rounded-lg border" /> : <div className="flex aspect-square items-center justify-center rounded-lg border bg-gray-50 text-sm text-gray-400">{generating ? '生成中…' : '暂无结果'}</div>}
                  </div>
                </div>

                {/* Redo area */}
                <div className="mt-4 border-t pt-3">
                  <label className="text-xs text-gray-500">重做提示词</label>
                  <textarea value={redoPrompt} onChange={(e) => setRedoPrompt(e.target.value)} rows={4} className="input-field mt-1 font-mono text-xs" placeholder="编辑提示词后点重新生成" />
                  <div className="mt-2 flex items-center gap-2">
                    <button onClick={handleRedo} disabled={redoing || !canRedo || !redoPrompt.trim()} className="btn-primary btn-sm text-xs">{redoing ? '提交中…' : '重新生成'}</button>
                    {!canRedo && <span className="text-[11px] text-gray-400">{shot.latestJobId ? '任务生成中，完成后可重做' : '该分镜尚未生成，无法重做'}</span>}
                  </div>
                </div>
              </div>

              {/* Bottom nav bar (matches ResultGallery footer) */}
              <div className="shrink-0 border-t p-3 flex items-center gap-2">
                <button onClick={() => goPreview(-1)} disabled={isFirst} className="btn-secondary btn-sm text-xs disabled:opacity-40">‹ 上一张</button>
                <button onClick={() => goPreview(1)} disabled={isLast} className="btn-secondary btn-sm text-xs disabled:opacity-40">下一张 ›</button>
                <span className="text-gray-300 mx-1">|</span>
                <button onClick={closePreview} className="btn-secondary btn-sm text-xs text-gray-500">关闭</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
