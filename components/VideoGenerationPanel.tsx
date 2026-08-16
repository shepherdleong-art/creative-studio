'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import HoverZoomImage from '@/components/HoverZoomImage';
import VideoGenerationPreview from '@/components/VideoGenerationPreview';
import VideoGenerationResults from '@/components/VideoGenerationResults';
import { Icon } from '@/components/ui/Icon';
import {
  collectVideoMotionTailImageIds,
  createVideoMotionRow,
  getVideoMotionRowIssue,
  removeVideoMotionRowByKey,
  updateVideoMotionRowByKey,
  type VideoMotionRow,
  type VideoTailFrameCapability,
} from '@/components/video-tail-frame-state';

function releaseDraftTailFrameAssets(rowGroups: Iterable<VideoMotionRow[]>): void {
  for (const assetId of collectVideoMotionTailImageIds(rowGroups)) {
    fetch(`/api/images/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => undefined);
  }
}

interface VideoProvider {
  id: string;
  name: string;
  type: string;
  defaultModel: string;
  defaultDurationSec: number;
  configured?: boolean;
  missing?: string[];
  tailFrameCapability?: VideoTailFrameCapability;
}

interface MotionTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

interface VideoJob {
  id: string;
  shotId: string;
  providerId: string;
  model: string;
  templateId: string | null;
  prompt: string;
  durationSec: number;
  status: string;
  providerTaskId?: string;
  providerStatus?: string;
  filename?: string;
  localVideoPath?: string;
  errorMessage?: string;
  providerName?: string;
  templateName?: string;
  posterImageUrl?: string;
  tailImageId?: string | null;
}

interface Props {
  projectId: string;
  shotSetId?: string;
  shots?: Array<{
    id: string;
    indexNum: number;
    sourceImageId: string;
    latestGeneratedImageId?: string;
    imageUrl?: string;
  }>;
}

export default function VideoGenerationPanel({ projectId, shotSetId, shots }: Props) {
  const [providers, setProviders] = useState<VideoProvider[]>([]);
  const [templates, setTemplates] = useState<MotionTemplate[]>([]);
  const [videoJobs, setVideoJobs] = useState<VideoJob[]>([]);
  const [loading, setLoading] = useState(true);

  // Shot set selection (for top-level Panel 4)
  const [availableSets, setAvailableSets] = useState<Array<{ id: string; name: string; shotCount: number }>>([]);
  const [selectedSetId, setSelectedSetId] = useState<string>(shotSetId || '');
  const selectedSetIdRef = useRef<string>(shotSetId || '');
  const [selectedSetShots, setSelectedSetShots] = useState<typeof shots>(shots);
  const restoredSetRef = useRef(false);

  // Per-shot form state (one active shot at a time)
  const [selectedShot, setSelectedShot] = useState<string | null>(null);
  const selectedShotRef = useRef<string | null>(null);
  const [motionRows, setMotionRows] = useState<VideoMotionRow[]>([]);
  const motionRowsRef = useRef<VideoMotionRow[]>([]);
  const perShotMotionCache = useRef<Map<string, typeof motionRows>>(new Map());
  const [creating, setCreating] = useState(false);
  const [videoPreviewJobId, setVideoPreviewJobId] = useState<string | null>(null);
  const [videoPreviewPlaySignal, setVideoPreviewPlaySignal] = useState(0);
  const previewSuppressedRef = useRef(false);
  const [videoConcurrency, setVideoConcurrency] = useState(10);

  const selectVideoPreview = (jobId: string) => {
    previewSuppressedRef.current = false;
    setVideoPreviewJobId(jobId);
    setVideoPreviewPlaySignal((v) => v + 1);
  };

  const defaultDuration = 5;
  const storageKey = `creative-studio:video-shot-set:${projectId}`;
  const configuredProviders = providers.filter((provider) => provider.configured !== false);

  // Effective provider id for a row: fall back to a preferred provider
  // when the row was created before providers had loaded.
  // 偏好可灵（kling）：团队的主力视频模型，避免每次手动切换。
  const preferredProvider = configuredProviders.find((provider) =>
    /kling/i.test(provider.defaultModel ?? '') || /kling/i.test(provider.name ?? ''),
  ) ?? configuredProviders[0];
  const getRowProviderId = (row: { providerId: string }): string =>
    (row.providerId && configuredProviders.some((provider) => provider.id === row.providerId))
      ? row.providerId
      : preferredProvider?.id || '';
  const getRowTailCapability = (row: { providerId: string }): VideoTailFrameCapability | undefined =>
    providers.find((provider) => provider.id === getRowProviderId(row))?.tailFrameCapability;

  const makeEmptyRow = (): VideoMotionRow => createVideoMotionRow(crypto.randomUUID(), defaultDuration);

  const replaceSelectedShot = (shotId: string | null) => {
    selectedShotRef.current = shotId;
    setSelectedShot(shotId);
  };

  const replaceActiveMotionRows = (rows: VideoMotionRow[]) => {
    motionRowsRef.current = rows;
    setMotionRows(rows);
  };

  useEffect(() => () => {
    releaseDraftTailFrameAssets([
      motionRowsRef.current,
      ...perShotMotionCache.current.values(),
    ]);
    selectedShotRef.current = null;
    motionRowsRef.current = [];
    perShotMotionCache.current.clear();
  }, []);

  const updateRowsForShot = (
    shotId: string,
    rowKey: string,
    update: (row: VideoMotionRow) => VideoMotionRow,
  ): boolean => {
    const isActive = selectedShotRef.current === shotId;
    const currentRows = isActive ? motionRowsRef.current : perShotMotionCache.current.get(shotId);
    if (!currentRows) return false;
    const result = updateVideoMotionRowByKey(currentRows, rowKey, update);
    if (!result.updated) return false;
    if (isActive) replaceActiveMotionRows(result.rows);
    else perShotMotionCache.current.set(shotId, result.rows);
    return true;
  };

  // Load providers and templates once
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [provRes, tmplRes] = await Promise.all([
          fetch('/api/providers/video'), fetch('/api/video-prompt-templates'),
        ]);
        const provData = await provRes.json().catch(() => []);
        const tmplData = await tmplRes.json().catch(() => []);
        if (!active) return;
        if (Array.isArray(provData)) setProviders(provData);
        if (Array.isArray(tmplData)) setTemplates(tmplData);
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, []);

  // Load project video concurrency once
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}`);
        const data = await res.json();
        if (active && Number.isFinite(Number(data.videoConcurrency))) {
          setVideoConcurrency(Math.max(1, Math.min(10, Math.floor(Number(data.videoConcurrency)))));
        }
      } catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, [projectId]);

  const handleVideoConcurrencyChange = (value: number) => {
    const clamped = Math.max(1, Math.min(10, Math.floor(value) || 1));
    setVideoConcurrency(clamped);
    fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoConcurrency: clamped }),
    }).catch(() => { /* best-effort */ });
  };

  // Load shot sets for selector
  useEffect(() => {
    if (shotSetId) return; // Already have a specific set
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shot-sets`);
        const data = await res.json();
        if (active && Array.isArray(data)) setAvailableSets(data);
      } catch { /* ignore */ }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [projectId, shotSetId]);

  // Load shots when set is selected (with race guard)
  const getDefaultPreviewJobId = (jobs: VideoJob[]) =>
    jobs.find((j) => j.status === 'succeeded' && j.filename)?.id || null;

  const syncPreviewSelection = (jobs: VideoJob[]) => {
    setVideoPreviewJobId((current) => {
      if (current && jobs.some((j) => j.id === current && j.status === 'succeeded' && j.filename)) return current;
      if (previewSuppressedRef.current) return null;
      return getDefaultPreviewJobId(jobs);
    });
  };

  const loadShotsForSet = async (setId: string) => {
    try {
      const res = await fetch(`/api/shot-sets/${setId}`);
      const data = await res.json();
      if (data.shots && selectedSetIdRef.current === setId) {
        const loadedShots = data.shots.map((s: { id: string; indexNum: number; sourceImageId: string; latestGeneratedImageId?: string; sourceImageUrl?: string; generatedImageUrl?: string }) => ({
          id: s.id, indexNum: s.indexNum, sourceImageId: s.sourceImageId,
          latestGeneratedImageId: s.latestGeneratedImageId,
          imageUrl: s.generatedImageUrl || s.sourceImageUrl || '',
        }));
        setSelectedSetShots(loadedShots);
        if (loadedShots.length > 0) {
          replaceSelectedShot(loadedShots[0].id);
          replaceActiveMotionRows([makeEmptyRow()]);
        }
      }
      // Load video jobs
      const jobRes = await fetch(`/api/shot-sets/${setId}/video-jobs`);
      const jobData = await jobRes.json().catch(() => ({ jobs: [] }));
      if (jobData.jobs && selectedSetIdRef.current === setId) {
        setVideoJobs(jobData.jobs);
        syncPreviewSelection(jobData.jobs);
      }
    } catch { /* ignore */ }
  };

  const handleSelectSet = (setId: string) => {
    releaseDraftTailFrameAssets([
      motionRowsRef.current,
      ...perShotMotionCache.current.values(),
    ]);
    setSelectedSetId(setId);
    selectedSetIdRef.current = setId;
    replaceSelectedShot(null);
    replaceActiveMotionRows([]);
    previewSuppressedRef.current = false;
    setVideoPreviewJobId(null);
    // Clear per-shot motion cache — switching sets resets all motion form state
    perShotMotionCache.current.clear();
    setSelectedSetShots(undefined);
    setVideoJobs([]);
    if (!shotSetId) {
      if (setId) window.localStorage.setItem(storageKey, setId);
      else window.localStorage.removeItem(storageKey);
    }
    if (setId) loadShotsForSet(setId);
  };

  // Restore the last selected shot set after tab remounts.
  useEffect(() => {
    if (shotSetId || restoredSetRef.current || availableSets.length === 0 || selectedSetIdRef.current) return;
    restoredSetRef.current = true;
    const storedSetId = window.localStorage.getItem(storageKey);
    if (storedSetId && availableSets.some((set) => set.id === storedSetId)) {
      const timer = window.setTimeout(() => handleSelectSet(storedSetId), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
    // handleSelectSet intentionally stays out of deps; this one-shot restore is guarded by refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSets, shotSetId, storageKey]);

  const effectiveSetId = shotSetId || selectedSetId;
  const effectiveShots = shots || selectedSetShots;
  const safeShots = effectiveShots || [];

  const ensureVideoQueueRunning = async (projectIdToUse: string) => {
    try {
      await fetch(`/api/projects/${projectIdToUse}/video-run`, { method: 'POST' });
    } catch { /* best-effort */ }
  };

  const refreshJobs = async () => {
    if (!effectiveSetId) return;
    try {
      const res = await fetch(`/api/shot-sets/${effectiveSetId}/video-jobs`);
      const data = await res.json().catch(() => ({ jobs: [] }));
      if (data.jobs) {
        setVideoJobs(data.jobs);
        syncPreviewSelection(data.jobs);
        // Auto-start video queue when pending jobs are detected; needs_check
        // jobs are also resumed automatically (they hold a remote task_id and
        // must not be left behind just because a poll window elapsed).
        if (data.jobs.some((j: { status: string }) => j.status === 'pending' || j.status === 'needs_check')) {
          ensureVideoQueueRunning(projectId);
        }
      }
    } catch { /* ignore */ }
  };

  // Poll video job status every 3s while any job is still active. needs_check
  // is included: those jobs hold a remote task_id and the queue resumes them.
  const hasActiveVideoJobs = useMemo(
    () => videoJobs.some((j) => j.status === 'pending' || j.status === 'running' || j.status === 'needs_check'),
    [videoJobs]
  );
  useEffect(() => {
    if (!effectiveSetId || !hasActiveVideoJobs) return;
    const t = setInterval(() => { refreshJobs(); }, 3000);
    return () => clearInterval(t);
    // refreshJobs intentionally stable, effectiveSetId already handled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSetId, hasActiveVideoJobs]);

  // Switch the active shot, preserving per-shot 运镜 rows
  const activate = (shotId: string) => {
    if (selectedShot !== shotId) {
      // Save current rows before switching away
      if (selectedShot) {
        perShotMotionCache.current.set(selectedShot, motionRowsRef.current);
      }
      replaceSelectedShot(shotId);
      // Restore cached rows or start fresh
      const cached = perShotMotionCache.current.get(shotId);
      replaceActiveMotionRows(cached ? [...cached] : [makeEmptyRow()]);
    }
  };

  const addMotionRow = () => replaceActiveMotionRows([...motionRowsRef.current, makeEmptyRow()]);
  const removeMotionRow = (rowKey: string) => {
    if (motionRowsRef.current.length <= 1) return;
    const removed = motionRowsRef.current.find((row) => row.key === rowKey);
    replaceActiveMotionRows(removeVideoMotionRowByKey(motionRowsRef.current, rowKey));
    if (removed?.tailImageId) {
      fetch(`/api/images/${encodeURIComponent(removed.tailImageId)}`, { method: 'DELETE' }).catch(() => undefined);
    }
  };
  const updateRowPrompt = (rowKey: string, value: string) => {
    const result = updateVideoMotionRowByKey(motionRowsRef.current, rowKey, (row) => ({ ...row, prompt: value }));
    replaceActiveMotionRows(result.rows);
  };
  const updateRowTemplate = (rowKey: string, templateId: string) => {
    const result = updateVideoMotionRowByKey(motionRowsRef.current, rowKey, (r) => {
      const oldTmpl = r.templateId ? templates.find((t) => t.id === r.templateId) : null;
      const newTmpl = templates.find((t) => t.id === templateId);
      // Update prompt when: prompt is empty (first selection), or the current
      // prompt matches the old template exactly (auto-filled, not user-edited).
      // Preserve prompts that the user has manually written.
      const isAutoFilled = !r.prompt.trim() || (oldTmpl ? r.prompt.trim() === oldTmpl.prompt.trim() : false);
      const nextPrompt = (isAutoFilled && newTmpl) ? newTmpl.prompt : r.prompt;
      return { ...r, templateId, prompt: nextPrompt };
    });
    replaceActiveMotionRows(result.rows);
  };
  const updateRowProvider = (rowKey: string, providerId: string) => {
    const result = updateVideoMotionRowByKey(motionRowsRef.current, rowKey, (row) => ({ ...row, providerId }));
    replaceActiveMotionRows(result.rows);
  };
  const updateRowDuration = (rowKey: string, raw: number) => {
    const result = updateVideoMotionRowByKey(motionRowsRef.current, rowKey, (r) => {
      const v = Number.isFinite(raw) && raw > 0 ? raw : 5;
      return { ...r, durationSec: Math.max(2, Math.min(15, v)) };
    });
    replaceActiveMotionRows(result.rows);
  };

  const deleteTailFrameAsset = async (assetId: string): Promise<void> => {
    const response = await fetch(`/api/images/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || `HTTP ${response.status}`);
    }
  };

  const handleTailFrameUpload = async (shotId: string, rowKey: string, file: File) => {
    const currentRows = selectedShotRef.current === shotId
      ? motionRowsRef.current
      : perShotMotionCache.current.get(shotId);
    const previousTailId = currentRows?.find((row) => row.key === rowKey)?.tailImageId ?? null;
    if (!updateRowsForShot(shotId, rowKey, (row) => ({
      ...row,
      tailUploadState: 'uploading',
      tailUploadError: null,
    }))) return;

    let uploadedId: string | null = null;
    try {
      const formData = new FormData();
      formData.append('files', file);
      formData.append('role', 'input');
      formData.append('projectId', projectId);
      formData.append('usage', 'video_tail_frame');
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        files?: Array<{ id: string; filename: string; imageUrl: string }>;
      };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const uploaded = data.files?.[0];
      if (!uploaded) throw new Error('上传接口没有返回尾帧图片');
      uploadedId = uploaded.id;

      const attached = updateRowsForShot(shotId, rowKey, (row) => ({
        ...row,
        tailImageId: uploaded.id,
        tailImageUrl: uploaded.imageUrl,
        tailImageName: uploaded.filename,
        tailUploadState: 'idle',
        tailUploadError: null,
      }));
      if (!attached) {
        await deleteTailFrameAsset(uploaded.id).catch(() => undefined);
        return;
      }
      if (previousTailId && previousTailId !== uploaded.id) {
        await deleteTailFrameAsset(previousTailId).catch(() => undefined);
      }
    } catch (error) {
      if (uploadedId) await deleteTailFrameAsset(uploadedId).catch(() => undefined);
      updateRowsForShot(shotId, rowKey, (row) => ({
        ...row,
        tailUploadState: 'failed',
        tailUploadError: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const handleTailFrameRemove = async (shotId: string, rowKey: string) => {
    const currentRows = selectedShotRef.current === shotId
      ? motionRowsRef.current
      : perShotMotionCache.current.get(shotId);
    const tailImageId = currentRows?.find((row) => row.key === rowKey)?.tailImageId;
    if (!tailImageId) return;
    updateRowsForShot(shotId, rowKey, (row) => ({
      ...row,
      tailUploadState: 'deleting',
      tailUploadError: null,
    }));
    try {
      await deleteTailFrameAsset(tailImageId);
      updateRowsForShot(shotId, rowKey, (row) => ({
        ...row,
        tailImageId: null,
        tailImageUrl: null,
        tailImageName: null,
        tailUploadState: 'idle',
        tailUploadError: null,
      }));
    } catch (error) {
      updateRowsForShot(shotId, rowKey, (row) => ({
        ...row,
        tailUploadState: 'failed',
        tailUploadError: `移除尾帧失败：${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  };

  const handleCreateVideos = async (shotId: string) => {
    const blockedRow = motionRows.find((row) => getVideoMotionRowIssue(row, getRowTailCapability(row)));
    if (blockedRow) {
      alert(getVideoMotionRowIssue(blockedRow, getRowTailCapability(blockedRow)));
      return;
    }
    const items = motionRows
      .map((r) => ({
        prompt: r.prompt.trim(),
        templateId: r.templateId || null,
        providerId: getRowProviderId(r),
        durationSec: r.durationSec,
        tailImageId: r.tailImageId,
      }))
      .filter((r) => r.prompt.length > 0);
    if (items.length === 0) { alert('请至少填写一条描述提示词'); return; }
    if (configuredProviders.length === 0) { alert('请先配置视频供应商'); return; }
    setCreating(true);
    try {
      const res = await fetch(`/api/shot-sets/${effectiveSetId}/video-jobs/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId, items }),
      });
      const data = await res.json();
      if (res.ok) {
        await refreshJobs();
        perShotMotionCache.current.delete(shotId);
        replaceActiveMotionRows([makeEmptyRow()]);
      } else {
        alert('创建视频任务失败: ' + (data.error || '未知错误'));
      }
    } catch (err) {
      alert('创建失败: ' + String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleRetry = async (jobId: string) => {
    try {
      const res = await fetch(`/api/video-jobs/${jobId}/retry`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert('重试失败: ' + (data.error || `HTTP ${res.status}`)); return; }
      await refreshJobs();
    } catch (err) {
      alert('重试失败: ' + String(err));
    }
  };

  const handleResumePoll = async (jobId: string) => {
    try {
      const res = await fetch(`/api/video-jobs/${jobId}/resume-poll`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert('补抓失败: ' + (data.error || `HTTP ${res.status}`)); return; }
      await refreshJobs();
    } catch (err) {
      alert('补抓失败: ' + String(err));
    }
  };

  const handleCancelVideoJob = async (jobId: string) => {
    try {
      const res = await fetch(`/api/video-jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert('取消失败: ' + (data.error || `HTTP ${res.status}`)); return; }
      await refreshJobs();
    } catch (err) {
      alert('取消失败: ' + String(err));
    }
  };

  if (loading) return <p className="text-xs text-ink-tertiary">加载视频功能...</p>;
  const shotSetSelector = !shotSetId ? (
    <div className="mb-4">
      <label className="label">选择分镜组</label>
      <select value={selectedSetId} onChange={(e) => handleSelectSet(e.target.value)} className="input-field text-sm">
        <option value="">-- 选择分镜组 --</option>
        {availableSets.map((s) => (<option key={s.id} value={s.id}>{s.name} ({s.shotCount} 张)</option>))}
      </select>
      {availableSets.length === 0 && <p className="mt-1 text-xs text-ink-tertiary">暂无分镜组，请先在分镜生成中创建。</p>}
    </div>
  ) : null;

  if (!effectiveSetId && !shotSetId) {
    // Top-level: show shot set selector
    return (
      <div>
        {shotSetSelector}
        {!selectedSetId && <p className="text-xs text-ink-tertiary">选择一个分镜组后可以创建视频任务。</p>}
      </div>
    );
  }

  const selectedShotData = safeShots.find((s) => s.id === selectedShot);
  const previewVideoUrl = (() => {
    if (!videoPreviewJobId) return null;
    const job = videoJobs.find((j) => j.id === videoPreviewJobId);
    if (!job?.filename) return null;
    return `/api/videos/videos/${encodeURIComponent(job.filename)}`;
  })();
  const previewPosterUrl = videoPreviewJobId
    ? videoJobs.find((j) => j.id === videoPreviewJobId)?.posterImageUrl || null
    : null;

  return (
    <div className="mt-3 min-w-0 max-w-full">
      {shotSetSelector}

      <div className="video-workspace">
        {/* ═══ LEFT: Shot selector + params ═══ */}
        <div className="panel-col left-col">
          <div className="panel-col-header">
            {/* Shot tabs */}
            {safeShots.length > 0 && (
              <div className="shot-tab-row">
                {safeShots.map((shot) => (
                  <button
                    key={shot.id}
                    type="button"
                    onClick={() => activate(shot.id)}
                    className={`shot-tab-item ${selectedShot === shot.id ? 'active' : ''}`}
                  >
                    分镜 {shot.indexNum}
                  </button>
                ))}
              </div>
            )}

            {/* Source image preview */}
            {selectedShotData?.imageUrl ? (
              <HoverZoomImage
                src={selectedShotData.imageUrl}
                alt={`分镜 ${selectedShotData.indexNum}`}
                className="w-full aspect-[4/3] cursor-pointer rounded-lg border border-hairline object-cover bg-surface-subtle transition-colors hover:border-accent/40"
                zoomMaxWidth={520}
                zoomMaxHeight={390}
              />
            ) : selectedShotData ? (
              <div className="flex aspect-[4/3] items-center justify-center rounded-lg border border-hairline bg-surface-subtle text-xs text-ink-tertiary">
                源图不可用
              </div>
            ) : safeShots.length > 0 ? (
              <div className="flex aspect-[4/3] items-center justify-center rounded-lg border border-hairline bg-surface-subtle text-xs text-ink-tertiary">
                请选择一个分镜
              </div>
            ) : null}
          </div>

          {/* Motion form — scrollable independently */}
          {selectedShot && (
            <div className="panel-scroll-area">
              <div className="space-y-3">
                {motionRows.map((row, idx) => {
                  const tailCapability = getRowTailCapability(row);
                  const tailIssue = getVideoMotionRowIssue(row, tailCapability);
                  const tailBusy = row.tailUploadState === 'uploading' || row.tailUploadState === 'deleting';
                  return (
                  <div key={row.key} className="video-motion-card">
                    <span className="video-motion-label">描述 {idx + 1}</span>

                    <select
                      value={getRowProviderId(row)}
                      onChange={(e) => updateRowProvider(row.key, e.target.value)}
                      className="input-field video-control"
                      disabled={configuredProviders.length === 0}
                    >
                      {providers.length === 0 && <option value="">暂无供应商</option>}
                      {providers.length > 0 && configuredProviders.length === 0 && <option value="">暂无可用供应商</option>}
                      {providers.map((p) => (
                        <option key={p.id} value={p.id} disabled={p.configured === false}>
                          {p.name}{p.configured === false ? '（未配置）' : ''}
                        </option>
                      ))}
                    </select>
                    {providers.some((p) => p.configured === false) && (
                      <p className="text-[11px] leading-4 text-ink-tertiary">
                        未配置的视频供应商需要先补齐环境变量。
                      </p>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={row.templateId}
                        onChange={(e) => updateRowTemplate(row.key, e.target.value)}
                        className="input-field video-control"
                      >
                        <option value="">模板（可选）</option>
                        {templates.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
                      </select>
                      <input
                        type="number" min={2} max={15}
                        value={row.durationSec}
                        onChange={(e) => updateRowDuration(row.key, Number(e.target.value))}
                        className="input-field video-control text-center"
                        title="秒数"
                      />
                    </div>

                    <div className="rounded-lg border border-hairline bg-surface-subtle p-2">
                      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] leading-4">
                        <span className="font-medium text-ink-secondary">尾帧（可选）</span>
                        <span className="text-ink-tertiary">首帧使用当前分镜</span>
                      </div>
                      {row.tailImageId ? (
                        <div className="flex h-14 items-center gap-2 rounded-md border border-hairline bg-white p-1.5" aria-live="polite">
                          {row.tailImageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={row.tailImageUrl} alt="尾帧预览" className="h-11 w-11 shrink-0 rounded object-cover" />
                          ) : (
                            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-surface-subtle text-ink-tertiary">
                              <Icon name="image" size={17} />
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-secondary">
                            {tailBusy ? (row.tailUploadState === 'deleting' ? '移除中…' : '更换中…') : (row.tailImageName || '已添加尾帧')}
                          </span>
                          {tailCapability?.supported && (
                            <label className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[10px] text-accent hover:bg-accent/5">
                              更换
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                className="sr-only"
                                disabled={tailBusy}
                                onChange={(event) => {
                                  const file = event.currentTarget.files?.[0];
                                  event.currentTarget.value = '';
                                  if (file && selectedShot) void handleTailFrameUpload(selectedShot, row.key, file);
                                }}
                              />
                            </label>
                          )}
                          <button
                            type="button"
                            onClick={() => selectedShot && void handleTailFrameRemove(selectedShot, row.key)}
                            disabled={tailBusy}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-tertiary transition-colors hover:bg-surface-subtle hover:text-fail disabled:opacity-40"
                            title="移除尾帧"
                            aria-label="移除尾帧"
                          >
                            <Icon name="close" size={13} />
                          </button>
                        </div>
                      ) : tailCapability?.supported ? (
                        <label className={`flex h-14 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-hairline bg-white text-[11px] transition-colors hover:border-accent/40 hover:text-accent ${tailBusy ? 'pointer-events-none opacity-50' : 'text-ink-tertiary'}`} aria-live="polite">
                          <Icon name="upload" size={15} />
                          {row.tailUploadState === 'uploading' ? '上传中…' : '上传尾帧'}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="sr-only"
                            disabled={tailBusy}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (file && selectedShot) void handleTailFrameUpload(selectedShot, row.key, file);
                            }}
                          />
                        </label>
                      ) : (
                        <div className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-hairline bg-white px-2 text-[10px] text-ink-tertiary">
                          <Icon name="image" size={13} />
                          当前模型暂不支持尾帧
                        </div>
                      )}
                      {tailIssue && (row.tailImageId || row.tailUploadState === 'failed') && (
                        <p className="mt-1.5 flex items-start gap-1 rounded bg-warn-tint px-2 py-1 text-[10px] leading-4 text-warn" role="status">
                          <Icon name="alert" size={11} className="mt-0.5 shrink-0" />
                          {tailIssue}
                        </p>
                      )}
                    </div>

                    <textarea
                      value={row.prompt}
                      onChange={(e) => updateRowPrompt(row.key, e.target.value)}
                      rows={3}
                      className="input-field video-prompt-field"
                      placeholder="运镜描述（提示词）"
                    />

                    <button
                      onClick={() => removeMotionRow(row.key)}
                      disabled={motionRows.length <= 1}
                      className="video-motion-delete"
                      title="删除该描述"
                    ><Icon name="trash" size={12} /></button>
                  </div>
                  );
                })}
              </div>

              <div className="flex flex-col gap-2">
                <button onClick={addMotionRow} className="btn-secondary btn-sm w-full video-add-action">
                  <Icon name="plus" size={12} /> 添加描述
                </button>
                <div>
                  <label className="label generation-label">并发数</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={videoConcurrency}
                    onChange={(e) => handleVideoConcurrencyChange(Number(e.target.value))}
                    className="input-field generation-control generation-number"
                  />
                  <p className="generation-helper">失败或限流时调回 1。</p>
                </div>
                <button
                  onClick={() => handleCreateVideos(selectedShot)}
                  disabled={creating
                    || configuredProviders.length === 0
                    || motionRows.every((r) => !r.prompt.trim())
                    || motionRows.some((r) => Boolean(getVideoMotionRowIssue(r, getRowTailCapability(r))))}
                  className="btn-primary btn-sm w-full video-create-action"
                >
                  {creating
                    ? '创建中...'
                    : `生成 ${motionRows.filter((r) => r.prompt.trim()).length} 条视频`}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ═══ CENTER: Video preview ═══ */}
        <div className="panel-col center-col video-preview-col">
          <VideoGenerationPreview
            videoUrl={previewVideoUrl}
            posterUrl={previewPosterUrl}
            placeholderText={safeShots.length > 0 ? '选择左侧分镜并生成视频' : '暂无分镜'}
            videoJobs={videoJobs}
            currentJobId={videoPreviewJobId}
            playSignal={videoPreviewPlaySignal}
            onNavigate={selectVideoPreview}
            onClose={() => {
              previewSuppressedRef.current = true;
              setVideoPreviewJobId(null);
            }}
          />
        </div>

        {/* ═══ RIGHT: Result cards ═══ */}
        <div className="panel-col right-col">
          <div className="panel-scroll-area">
            <VideoGenerationResults
              videoJobs={videoJobs}
              onPreview={selectVideoPreview}
              onRetry={handleRetry}
              onResumePoll={handleResumePoll}
              onCancel={handleCancelVideoJob}
              activePreviewJobId={videoPreviewJobId}
            />
          </div>
        </div>
      </div>

      {safeShots.length === 0 && (
        <p className="text-xs text-ink-tertiary mt-3">分镜组中没有分镜。</p>
      )}
    </div>
  );
}
