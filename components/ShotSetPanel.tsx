'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ImageUploader from '@/components/ImageUploader';
import HoverZoomImage from '@/components/HoverZoomImage';
import { Icon } from '@/components/ui/Icon';
import {
  getRedoFormDefaults,
  getRedoInitKey,
  parseRedoReferenceIds,
  shouldInitializeRedoForm,
} from '@/lib/shot-redo-state';

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
  referenceImageIds?: string;
  providerId?: string;
  model?: string;
  size?: string;
  quality?: string;
  reviewMark?: string;
  resultCandidates?: ShotResultCandidate[];
}

interface ShotResultCandidate {
  shotId: string;
  jobId: string;
  imageAssetId: string;
  createdAt: string;
  filename?: string;
  imageUrl?: string;
  jobStatus?: string;
  jobPrompt?: string;
  referenceImageIds?: string;
  providerId?: string;
  model?: string;
  size?: string;
  quality?: string;
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
  providers?: ImageProvider[];
  images: Array<{ id: string; imageUrl?: string; filename: string; role: string; usage?: string }>;
  jobs?: Array<{ id: string; status: string; outputImageId?: string }>;
  onApplyScene?: (shotSetId: string) => void;
  onImagesUploaded?: () => void;
  onShotChanged?: () => void | Promise<void>;
  showUploader?: boolean;
  showCreateControls?: boolean;
}

interface ImageProvider {
  id: string;
  name: string;
  model: string;
  enabled: number | boolean;
  hasApiKey: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', generating: '生成中', completed: '已完成', reviewing: '审核中', approved: '已通过', video_ready: '待生成视频',
};

function safeParseImageIds(value: string | undefined): string[] {
  return parseRedoReferenceIds(value);
}

export default function ShotSetPanel({ projectId, providers = [], images, jobs, onApplyScene, onImagesUploaded, onShotChanged, showUploader = true, showCreateControls = true }: Props) {
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
  const [redoInputSource, setRedoInputSource] = useState<'original' | 'current_result'>('original');
  const [redoReferenceIds, setRedoReferenceIds] = useState<string[]>([]);
  const [redoProviderId, setRedoProviderId] = useState('');
  const [redoing, setRedoing] = useState(false);
  const [selectingResultId, setSelectingResultId] = useState('');
  const [sceneRefInfoBySet, setSceneRefInfoBySet] = useState<Record<string, { name: string; imageUrl: string } | null>>({});
  const expandedIdsRef = useRef<Set<string>>(new Set());
  const redoInitKeyRef = useRef('');

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
  const selectableProviders = useMemo(
    () => providers.filter((provider) => provider.enabled && provider.hasApiKey),
    [providers]
  );
  const imageById = useMemo(() => new Map(images.map((img) => [img.id, img])), [images]);

  const closePreview = useCallback(() => {
    setPreviewIndex(null);
    setPreviewSetId(null);
    setRedoing(false);
    setSelectingResultId('');
    redoInitKeyRef.current = '';
  }, []);
  const currentPreviewShot = previewIndex !== null ? previewShots[previewIndex] : undefined;

  const getSelectedResultCandidate = useCallback((shot: Shot | undefined): ShotResultCandidate | undefined => {
    if (!shot?.resultCandidates?.length) return undefined;
    return shot.resultCandidates.find((candidate) => candidate.imageAssetId === shot.latestGeneratedImageId)
      || shot.resultCandidates[shot.resultCandidates.length - 1];
  }, []);

  const currentResultCandidate = getSelectedResultCandidate(currentPreviewShot);

  const applyRedoDefaultsFromCandidate = useCallback((candidate: ShotResultCandidate | undefined, shot: Shot, fallbackProviderId: string) => {
    setRedoInputSource('original');
    setRedoReferenceIds(parseRedoReferenceIds(candidate?.referenceImageIds || shot.referenceImageIds).filter((id) => id !== shot.sourceImageId));
    setRedoProviderId(candidate?.providerId || shot.providerId || fallbackProviderId || '');
    setRedoPrompt(candidate?.jobPrompt || shot.jobPrompt || '');
  }, []);

  const initializeRedoForShot = useCallback((setId: string, shot: Shot | undefined) => {
    const nextInitKey = getRedoInitKey(setId, shot);
    if (!shouldInitializeRedoForm(redoInitKeyRef.current, nextInitKey)) return;
    redoInitKeyRef.current = nextInitKey;
    const selectedCandidate = getSelectedResultCandidate(shot);
    if (shot && selectedCandidate) {
      applyRedoDefaultsFromCandidate(selectedCandidate, shot, selectableProviders[0]?.id || '');
      return;
    }
    if (shot) {
      const defaults = getRedoFormDefaults(shot, selectableProviders[0]?.id || '');
      setRedoInputSource(defaults.inputSource);
      setRedoReferenceIds(defaults.referenceIds);
      setRedoProviderId(defaults.providerId);
      setRedoPrompt(defaults.prompt);
      return;
    }
    setRedoPrompt('');
    setRedoInputSource('original');
    setRedoReferenceIds([]);
    setRedoProviderId(selectableProviders[0]?.id || '');
  }, [applyRedoDefaultsFromCandidate, getSelectedResultCandidate, selectableProviders]);

  const openPreview = (setId: string, idx: number) => {
    const nextShots = shotsBySet[setId] || [];
    const shot = nextShots[idx];
    setPreviewSetId(setId);
    setPreviewIndex(idx);
    initializeRedoForShot(setId, shot);
    setRedoing(false);
  };

  const goPreview = useCallback((delta: number) => {
    if (!previewSetId) return;
    setPreviewIndex((prev) => {
      if (prev === null || previewShots.length === 0) return prev;
      const nextIndex = Math.min(previewShots.length - 1, Math.max(0, prev + delta));
      initializeRedoForShot(previewSetId, previewShots[nextIndex]);
      return nextIndex;
    });
  }, [initializeRedoForShot, previewSetId, previewShots]);

  // Keyboard navigation while preview is open
  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closePreview(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        goPreview(delta);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePreview, goPreview, previewIndex]);

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

  const redoBaseImageId = currentPreviewShot
    ? (redoInputSource === 'current_result' ? currentResultCandidate?.imageAssetId || currentPreviewShot.latestGeneratedImageId || '' : currentPreviewShot.sourceImageId)
    : '';
  const selectedRedoProviderId = selectableProviders.some((provider) => provider.id === redoProviderId)
    ? redoProviderId
    : (selectableProviders.some((provider) => provider.id === currentPreviewShot?.providerId)
      ? currentPreviewShot?.providerId || ''
      : selectableProviders[0]?.id || '');
  const selectedRedoProvider = selectableProviders.find((provider) => provider.id === selectedRedoProviderId);
  const redoReferenceCandidates = (() => {
    if (!currentPreviewShot) return [];
    const seen = new Set<string>();
    const candidates: Array<{ id: string; label: string; imageUrl: string; isBase: boolean; sendIndex?: number }> = [];
    const add = (id: string | undefined, label: string, imageUrl?: string) => {
      if (!id || seen.has(id)) return;
      const asset = imageById.get(id);
      const url = imageUrl || asset?.imageUrl || '';
      if (!url) return;
      seen.add(id);
      candidates.push({ id, label, imageUrl: url, isBase: id === redoBaseImageId });
    };
    const addSendItem = (id: string | undefined, label: string, sendIndex: number) => {
      if (!id || seen.has(id)) return;
      const asset = imageById.get(id);
      const url =
        id === currentPreviewShot.sourceImageId ? currentPreviewShot.sourceImageUrl || asset?.imageUrl || ''
        : id === (currentResultCandidate?.imageAssetId || currentPreviewShot.latestGeneratedImageId) ? currentResultCandidate?.imageUrl || currentPreviewShot.generatedImageUrl || asset?.imageUrl || ''
        : asset?.imageUrl || '';
      if (!url) return;
      seen.add(id);
      candidates.push({ id, label, imageUrl: url, isBase: id === redoBaseImageId, sendIndex });
    };

    addSendItem(redoBaseImageId, '图1 底图', 1);
    redoReferenceIds
      .filter((id) => id !== redoBaseImageId)
      .forEach((id, idx) => {
        const label = id === (currentResultCandidate?.imageAssetId || currentPreviewShot.latestGeneratedImageId)
          ? `图${idx + 2} 当前结果`
          : `图${idx + 2} 参考图`;
        addSendItem(id, label, idx + 2);
      });
    add(currentPreviewShot.sourceImageId, '原图', currentPreviewShot.sourceImageUrl);
    safeParseImageIds(currentPreviewShot.referenceImageIds).forEach((id, idx) => add(id, `参考图 ${idx + 1}`));
    currentPreviewShot.resultCandidates?.forEach((candidate, idx) => {
      add(candidate.imageAssetId, candidate.imageAssetId === currentPreviewShot.latestGeneratedImageId ? '当前结果' : `结果 ${idx + 1}`, candidate.imageUrl);
    });
    if (!currentPreviewShot.resultCandidates?.length) {
      add(currentPreviewShot.latestGeneratedImageId, '当前结果', currentPreviewShot.generatedImageUrl);
    }
    images.filter((img) => img.role === 'reference').forEach((img) => add(img.id, img.filename, img.imageUrl));

    return candidates;
  })();

  const handleRedoInputSourceChange = (source: 'original' | 'current_result') => {
    if (!currentPreviewShot) return;
    const selectedResultImageId = currentResultCandidate?.imageAssetId || currentPreviewShot.latestGeneratedImageId;
    const newBaseId = source === 'current_result' ? selectedResultImageId : currentPreviewShot.sourceImageId;
    const oldBaseId = redoInputSource === 'current_result' ? selectedResultImageId : currentPreviewShot.sourceImageId;

    setRedoInputSource(source);
    setRedoReferenceIds((prev) => {
      const next = prev.filter((id) => id !== newBaseId);
      if (oldBaseId && oldBaseId !== newBaseId && !next.includes(oldBaseId)) next.push(oldBaseId);
      return next;
    });
  };

  const toggleRedoReference = (imageId: string) => {
    if (imageId === redoBaseImageId) return;
    setRedoReferenceIds((prev) =>
      prev.includes(imageId) ? prev.filter((id) => id !== imageId) : [...prev, imageId]
    );
  };

  const selectResultCandidate = async (candidate: ShotResultCandidate) => {
    if (selectingResultId) return;
    if (!previewSetId || previewIndex === null || !currentPreviewShot) return;
    if (candidate.imageAssetId === currentPreviewShot.latestGeneratedImageId) {
      applyRedoDefaultsFromCandidate(candidate, currentPreviewShot, selectableProviders[0]?.id || '');
      return;
    }
    const previousShot = currentPreviewShot;
    setSelectingResultId(candidate.imageAssetId);
    setShotsBySet((prev) => {
      const list = prev[previewSetId] || [];
      return {
        ...prev,
        [previewSetId]: list.map((shot) => shot.id === previousShot.id ? {
          ...shot,
          latestGeneratedImageId: candidate.imageAssetId,
          latestJobId: candidate.jobId,
          generatedFilename: candidate.filename,
          generatedImageUrl: candidate.imageUrl,
          jobStatus: candidate.jobStatus || shot.jobStatus,
          jobPrompt: candidate.jobPrompt || '',
          referenceImageIds: candidate.referenceImageIds || '[]',
          providerId: candidate.providerId || shot.providerId,
          model: candidate.model || shot.model,
          size: candidate.size || shot.size,
          quality: candidate.quality || shot.quality,
        } : shot),
      };
    });
    applyRedoDefaultsFromCandidate(candidate, previousShot, selectableProviders[0]?.id || '');
    try {
      const res = await fetch(`/api/shot-sets/${previewSetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId: previousShot.id, selectedImageAssetId: candidate.imageAssetId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert('切换结果失败: ' + (data.error || '未知错误'));
        setShotsBySet((prev) => {
          const list = prev[previewSetId] || [];
          return {
            ...prev,
            [previewSetId]: list.map((shot) => shot.id === previousShot.id ? previousShot : shot),
          };
        });
        return;
      }
      await onShotChanged?.();
    } catch (err) {
      alert('切换结果失败: ' + String(err));
      setShotsBySet((prev) => {
        const list = prev[previewSetId] || [];
        return {
          ...prev,
          [previewSetId]: list.map((shot) => shot.id === previousShot.id ? previousShot : shot),
        };
      });
    } finally {
      setSelectingResultId('');
    }
  };

  const goResultCandidate = (delta: number) => {
    if (!currentPreviewShot?.resultCandidates?.length) return;
    const candidates = currentPreviewShot.resultCandidates;
    const currentIdx = Math.max(0, candidates.findIndex((candidate) => candidate.imageAssetId === currentPreviewShot.latestGeneratedImageId));
    const next = candidates[Math.min(candidates.length - 1, Math.max(0, currentIdx + delta))];
    if (next) selectResultCandidate(next);
  };

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
        body: JSON.stringify({
          prompt: redoPrompt.trim(),
          markOriginal: true,
          inputSource: redoInputSource,
          referenceImageIds: redoReferenceIds.filter((id) => id !== redoBaseImageId),
          providerId: selectedRedoProviderId || undefined,
        }),
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
        const selectedResult = getSelectedResultCandidate(shot);
        const resultCandidates = shot.resultCandidates || [];
        const selectedResultIndex = selectedResult
          ? Math.max(0, resultCandidates.findIndex((candidate) => candidate.imageAssetId === selectedResult.imageAssetId))
          : -1;
        const resultCount = resultCandidates.length;
        const genUrl = selectedResult?.imageUrl || shot.generatedImageUrl || (shot.latestGeneratedImageId ? getImageUrl(shot.latestGeneratedImageId) : '');
        const refUrl = previewSceneRefInfo?.imageUrl || '';
        const generating = shot.jobStatus === 'pending' || shot.jobStatus === 'running';
        const canRedo = !!shot.latestJobId && REDOABLE_STATUSES.has(shot.jobStatus || '');
        const isFirst = previewIndex === 0;
        const isLast = previewIndex === previewShots.length - 1;
        const canGoPrevResult = selectedResultIndex > 0;
        const canGoNextResult = selectedResultIndex >= 0 && selectedResultIndex < resultCandidates.length - 1;
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
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-tertiary">
                      <span>结果</span>
                      {resultCount > 1 && (
                        <span>{selectedResultIndex + 1} / {resultCount}</span>
                      )}
                    </div>
                    <div className="relative">
                      {genUrl ? <img src={genUrl} alt="结果" className="max-h-[72vh] max-w-full rounded-lg border border-hairline object-contain" /> : <div className="flex aspect-square items-center justify-center rounded-lg border border-hairline bg-surface-subtle text-sm text-ink-tertiary">{generating ? '生成中…' : '暂无结果'}</div>}
                      {resultCount > 1 && (
                        <>
                          <button
                            type="button"
                            onClick={() => goResultCandidate(-1)}
                            disabled={!canGoPrevResult || !!selectingResultId}
                            className="absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/85 transition hover:bg-black/65 disabled:opacity-30"
                            title="上一张结果"
                            aria-label="上一张结果"
                          >
                            <Icon name="chevron-left" size={19} />
                          </button>
                          <button
                            type="button"
                            onClick={() => goResultCandidate(1)}
                            disabled={!canGoNextResult || !!selectingResultId}
                            className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/85 transition hover:bg-black/65 disabled:opacity-30"
                            title="下一张结果"
                            aria-label="下一张结果"
                          >
                            <Icon name="chevron-right" size={19} />
                          </button>
                        </>
                      )}
                    </div>
                    {resultCount > 1 && (
                      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                        {resultCandidates.map((candidate, idx) => {
                          const selected = candidate.imageAssetId === selectedResult?.imageAssetId;
                          return (
                            <button
                              key={candidate.imageAssetId}
                              type="button"
                              disabled={!!selectingResultId}
                              onClick={() => selectResultCandidate(candidate)}
                              className={`relative h-16 w-16 shrink-0 overflow-hidden rounded border disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'border-accent' : 'border-white/15 hover:border-accent/50'}`}
                              title={`结果 ${idx + 1}`}
                              aria-label={`选择结果 ${idx + 1}`}
                            >
                              {candidate.imageUrl && <img src={candidate.imageUrl} alt={`结果 ${idx + 1}`} className="h-full w-full object-cover" />}
                              <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] text-white">{idx + 1}</span>
                              {selected && (
                                <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white">
                                  <Icon name="check" size={10} />
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {selectingResultId && <div className="mt-2 text-[11px] text-accent">正在保存当前选择…</div>}
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
                    <div className="space-y-4">
                      <section>
                        <div className="mb-2 text-xs font-medium text-white/50">编辑底图</div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleRedoInputSourceChange('original')}
                            className={`btn-sm flex-1 text-xs ${redoInputSource === 'original' ? 'btn-primary' : 'btn-secondary'}`}
                          >
                            原图
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRedoInputSourceChange('current_result')}
                            disabled={!genUrl}
                            className={`btn-sm flex-1 text-xs ${redoInputSource === 'current_result' ? 'btn-primary' : 'btn-secondary'} ${!genUrl ? 'opacity-40' : ''}`}
                          >
                            当前结果
                          </button>
                        </div>
                      </section>

                      {selectableProviders.length > 0 && (
                        <section>
                          <label className="mb-1 block text-xs font-medium text-white/50">供应商 / 模型</label>
                          <select
                            value={selectedRedoProviderId}
                            onChange={(e) => setRedoProviderId(e.target.value)}
                            className="input-field text-xs"
                          >
                            {selectableProviders.map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.name} ({provider.model})
                              </option>
                            ))}
                          </select>
                          <div className="mt-1 text-[11px] text-white/45">
                            本次使用：{selectedRedoProvider?.model || selectedResult?.model || shot.model || '原任务模型'}
                          </div>
                        </section>
                      )}

                      <section>
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-white/50">参考图</span>
                          <span className="text-[11px] text-white/40">已选 {redoReferenceIds.filter((id) => id !== redoBaseImageId).length}</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {redoReferenceCandidates.map((candidate) => {
                            const isBase = candidate.id === redoBaseImageId;
                            const selected = !isBase && redoReferenceIds.includes(candidate.id);
                            return (
                              <button
                                key={candidate.id}
                                type="button"
                                onClick={() => toggleRedoReference(candidate.id)}
                                className={`relative overflow-hidden rounded border text-left ${isBase ? 'border-accent/50 opacity-60' : selected ? 'border-accent' : 'border-white/15 hover:border-accent/50'}`}
                                title={candidate.label}
                              >
                                <img src={candidate.imageUrl} alt={candidate.label} className="aspect-square w-full object-cover" />
                                <span className="block truncate px-1 py-0.5 text-[9px] text-white/70">{candidate.sendIndex ? candidate.label : isBase ? '底图' : candidate.label}</span>
                                {selected && (
                                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white">
                                    <Icon name="check" size={10} />
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </section>

                      <section>
                        <label className="label">重做提示词</label>
                        <textarea value={redoPrompt} onChange={(e) => setRedoPrompt(e.target.value)} rows={8} className="input-field mt-1 font-mono text-xs leading-relaxed" placeholder="编辑提示词后点重新生成" />
                      </section>

                      <div className="flex flex-col items-stretch gap-2">
                        <button onClick={handleRedo} disabled={redoing || !canRedo || !redoPrompt.trim()} className="btn-primary btn-sm w-full text-xs">{redoing ? '提交中…' : '重新生成'}</button>
                        {!canRedo && <span className="text-[11px] text-ink-tertiary">{shot.latestJobId ? '任务生成中，完成后可重做' : '该分镜尚未生成，无法重做'}</span>}
                      </div>
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
