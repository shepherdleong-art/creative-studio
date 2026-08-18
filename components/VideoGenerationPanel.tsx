'use client';

import { useState, useEffect, useRef, useMemo, useCallback, type DragEvent as ReactDragEvent } from 'react';
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

function releaseDraftTailFrameAssets(
  rowGroups: Iterable<VideoMotionRow[]>,
  protectedIds: ReadonlySet<string> = new Set(),
): void {
  for (const assetId of collectVideoMotionTailImageIds(rowGroups)) {
    if (protectedIds.has(assetId)) continue;
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

const FREE_HEAD_FRAME_DRAG_KEY = '__free-head-frame__';

export default function VideoGenerationPanel({ projectId, shotSetId, shots }: Props) {
  const [providers, setProviders] = useState<VideoProvider[]>([]);
  const [templates, setTemplates] = useState<MotionTemplate[]>([]);
  const [videoJobs, setVideoJobs] = useState<VideoJob[]>([]);
  const [loading, setLoading] = useState(true);

  // Shot set selection (for top-level Panel 4)
  const [availableSets, setAvailableSets] = useState<Array<{ id: string; name: string; shotCount: number; kind?: string }>>([]);
  const [deletingSet, setDeletingSet] = useState(false);
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
  const creatingRef = useRef(false);
  const [headFrameBusy, setHeadFrameBusy] = useState(false);
  const [freeHeadFrameSlotOpen, setFreeHeadFrameSlotOpen] = useState(false);
  const [deletingShot, setDeletingShot] = useState(false);
  const mountedRef = useRef(true);
  const pendingCreationTailIdsRef = useRef<Set<string>>(new Set());
  const tailFrameDragDepthRef = useRef<Map<string, number>>(new Map());
  const [tailFrameDragRowKey, setTailFrameDragRowKey] = useState<string | null>(null);
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

  useEffect(() => {
    mountedRef.current = true;
    const motionCache = perShotMotionCache.current;
    const tailFrameDragDepth = tailFrameDragDepthRef.current;
    return () => {
      mountedRef.current = false;
      tailFrameDragDepth.clear();
      releaseDraftTailFrameAssets([
        motionRowsRef.current,
        ...motionCache.values(),
      ], pendingCreationTailIdsRef.current);
      selectedShotRef.current = null;
      motionRowsRef.current = [];
      motionCache.clear();
    };
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
  const loadAvailableSets = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/shot-sets`);
    const data = await res.json();
    return Array.isArray(data)
      ? data as Array<{ id: string; name: string; shotCount: number; kind?: string }>
      : [];
  }, [projectId]);

  useEffect(() => {
    if (shotSetId) return; // Already have a specific set
    let active = true;
    (async () => {
      try {
        const sets = await loadAvailableSets();
        if (active) setAvailableSets(sets);
      } catch { /* ignore */ }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [loadAvailableSets, shotSetId]);

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
        } else {
          replaceSelectedShot(null);
          replaceActiveMotionRows([]);
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
    if (creatingRef.current) return;
    releaseDraftTailFrameAssets([
      motionRowsRef.current,
      ...perShotMotionCache.current.values(),
    ]);
    setSelectedSetId(setId);
    selectedSetIdRef.current = setId;
    replaceSelectedShot(null);
    replaceActiveMotionRows([]);
    setFreeHeadFrameSlotOpen(false);
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

  // 下拉里的「自由素材工位」用一个固定的哨兵值。真正的 shotSetId 要等
  // 后端 get-or-create 之后才知道(D15:一个项目一个)。
  const FREE_SET_OPTION = '__free__';

  const handleSelectFreeSet = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/free-shot-set`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert('打开自由素材工位失败：' + (data.error || `HTTP ${res.status}`)); return; }
      try { setAvailableSets(await loadAvailableSets()); } catch { /* ignore */ }
      handleSelectSet(String(data.id));
    } catch (err) {
      alert('打开自由素材工位失败：' + String(err));
    }
  };

  const selectedSetMeta = availableSets.find((set) => set.id === selectedSetId);
  const isFreeSet = selectedSetMeta?.kind === 'free';
  const canDeleteSelectedSet = !shotSetId && isFreeSet;
  const selectorLocked = creating || deletingSet || headFrameBusy;

  const handleDeleteFreeSet = async () => {
    if (!canDeleteSelectedSet || !selectedSetMeta || selectorLocked) return;
    // 记住目标 id:删除是异步的,期间用户可能已经切到别的组。
    const targetId = selectedSetId;
    const confirmed = window.confirm(
      `删除自由素材工位「${selectedSetMeta.name}」？\n\n` +
      '· 视频文件保留在本地磁盘上，不会被删除\n' +
      '· 已经登记到批量生产素材库的视频会继续保留\n' +
      '· 尚未登记的视频将无法再登记，也不再出现在第 5 步智能混剪里\n' +
      '· 这个操作不可撤销',
    );
    if (!confirmed) return;
    setDeletingSet(true);
    try {
      const res = await fetch(`/api/shot-sets/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // 还有任务没跑完时服务端返回 409(D14),把原因原样告诉用户。
        alert('删除失败：' + (data.error || `HTTP ${res.status}`));
        return;
      }
      // 只有当前仍停在被删的那个组时才清空选择,否则会把用户刚切过去的
      // 新组一起清掉。selectedSetIdRef 在 handleSelectSet 里是同步更新的。
      if (selectedSetIdRef.current === targetId) handleSelectSet('');
      try { setAvailableSets(await loadAvailableSets()); } catch { /* ignore */ }
    } catch (err) {
      alert('删除失败：' + String(err));
    } finally {
      setDeletingSet(false);
    }
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

  /**
   * 自由素材工位专用：上传一张图并作为新的一「张」加进工位。
   * 上传走和尾帧同一条 /api/upload，只是 usage 用 video_source(D6)，
   * 这样它不会跑到第 2 步的原始分镜图宫格里。
   */
  const handleAppendFreeShot = async (file: File) => {
    if (!effectiveSetId || headFrameBusy || creatingRef.current) return;
    const targetSetId = effectiveSetId;
    setHeadFrameBusy(true);
    let uploadedId: string | null = null;
    try {
      const formData = new FormData();
      formData.append('files', file);
      formData.append('role', 'input');
      formData.append('projectId', projectId);
      formData.append('usage', 'video_source');
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json().catch(() => ({})) as {
        error?: string;
        files?: Array<{ id: string }>;
      };
      if (!uploadRes.ok) throw new Error(uploadData.error || `HTTP ${uploadRes.status}`);
      const uploaded = uploadData.files?.[0];
      if (!uploaded) throw new Error('上传接口没有返回图片');
      uploadedId = uploaded.id;

      const appendRes = await fetch(`/api/shot-sets/${encodeURIComponent(targetSetId)}/shots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageId: uploaded.id }),
      });
      const appendData = await appendRes.json().catch(() => ({}));
      if (!appendRes.ok) throw new Error(appendData.error || `HTTP ${appendRes.status}`);

      // 重新拉一次分镜列表，新的一张会作为最后一个 tab 出现并自动选中。
      await loadShotsForSet(targetSetId);
      const newShotId = String(appendData.shotId);
      if (selectedSetIdRef.current === targetSetId) {
        replaceSelectedShot(newShotId);
        replaceActiveMotionRows([makeEmptyRow()]);
        setFreeHeadFrameSlotOpen(false);
      }
      try { setAvailableSets(await loadAvailableSets()); } catch { /* keep the active workspace usable */ }
    } catch (error) {
      // 挂载失败就把刚上传的图删掉，不留孤儿资源（和尾帧同一套处理）。
      if (uploadedId) {
        await fetch(`/api/images/${encodeURIComponent(uploadedId)}`, { method: 'DELETE' }).catch(() => undefined);
      }
      alert('添加图片失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setHeadFrameBusy(false);
    }
  };

  // D21：只有 failed / canceled 不算数。和服务端 DISCARDABLE_VIDEO_JOB_STATUSES
  // 必须保持一致；服务端仍会再判一次，这里只是把按钮先禁掉。
  const DISCARDABLE_JOB_STATUSES = new Set(['failed', 'canceled']);
  const canDeleteShot = (shotId: string) =>
    Boolean(isFreeSet) && !videoJobs.some((job) => job.shotId === shotId && !DISCARDABLE_JOB_STATUSES.has(job.status));

  const handleDeleteFreeShot = async (shotId: string) => {
    if (!effectiveSetId || !canDeleteShot(shotId) || deletingShot || creatingRef.current) return;
    if (!window.confirm('删掉这张图？它下面还没生成过视频，删了不影响其他图。')) return;
    setDeletingShot(true);
    try {
      const res = await fetch(
        `/api/shot-sets/${encodeURIComponent(effectiveSetId)}/shots/${encodeURIComponent(shotId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 前端算完到点下去这段时间里任务可能已经跑起来了，服务端会返回 409。
        alert('删除失败：' + (data.error || `HTTP ${res.status}`));
        return;
      }
      // best-effort 清掉上传的图片资源。还被别处引用时接口会返回 409，忽略即可。
      // —— 和尾帧的 deleteTailFrameAsset 同一套处理。
      if (data.sourceImageId) {
        await fetch(`/api/images/${encodeURIComponent(String(data.sourceImageId))}`, { method: 'DELETE' })
          .catch(() => undefined);
      }
      perShotMotionCache.current.delete(shotId);
      await loadShotsForSet(effectiveSetId);
      try { setAvailableSets(await loadAvailableSets()); } catch { /* keep the active workspace usable */ }
    } catch (err) {
      alert('删除失败：' + String(err));
    } finally {
      setDeletingShot(false);
    }
  };

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
    if (creatingRef.current) return;
    const leavingFreeHeadFrameSlot = Boolean(
      isFreeSet && freeHeadFrameSlotOpen && selectedShot === null,
    );
    tailFrameDragDepthRef.current.clear();
    setTailFrameDragRowKey(null);
    if (selectedShot !== shotId) {
      // Save current rows before switching away
      if (selectedShot) {
        perShotMotionCache.current.set(selectedShot, motionRowsRef.current);
      }
      replaceSelectedShot(shotId);
      // Restore cached rows or start fresh
      const cached = perShotMotionCache.current.get(shotId);
      replaceActiveMotionRows(cached ? [...cached] : [makeEmptyRow()]);
      if (leavingFreeHeadFrameSlot) {
        previewSuppressedRef.current = false;
        setVideoPreviewJobId(
          videoJobs.find((j) => (
            j.shotId === shotId && j.status === 'succeeded' && j.filename
          ))?.id || null,
        );
      }
    }
  };

  // “添加图片”只创建一个客户端空槽位，不直接打开系统文件选择器。
  // 空槽位没有 sourceImageId，不能提前写入 shots；图片拖入或在首帧格点击
  // 选择成功后，handleAppendFreeShot 才把它转成正式 shot。
  const activateFreeHeadFrameSlot = () => {
    if (creatingRef.current || headFrameBusy) return;
    tailFrameDragDepthRef.current.clear();
    setTailFrameDragRowKey(null);
    if (selectedShot) {
      perShotMotionCache.current.set(selectedShot, motionRowsRef.current);
    }
    setFreeHeadFrameSlotOpen(true);
    replaceSelectedShot(null);
    replaceActiveMotionRows([]);
    previewSuppressedRef.current = true;
    setVideoPreviewJobId(null);
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
    if (creatingRef.current) return;
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

  const clearTailFrameDragState = (rowKey: string) => {
    tailFrameDragDepthRef.current.delete(rowKey);
    setTailFrameDragRowKey((current) => current === rowKey ? null : current);
  };

  const handleTailFrameDragEnter = (
    event: ReactDragEvent<HTMLElement>,
    rowKey: string,
    enabled: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (!enabled) {
      event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.dataTransfer.dropEffect = 'copy';
    const nextDepth = (tailFrameDragDepthRef.current.get(rowKey) ?? 0) + 1;
    tailFrameDragDepthRef.current.set(rowKey, nextDepth);
    setTailFrameDragRowKey(rowKey);
  };

  const handleTailFrameDragOver = (
    event: ReactDragEvent<HTMLElement>,
    enabled: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
  };

  const handleTailFrameDragLeave = (
    event: ReactDragEvent<HTMLElement>,
    rowKey: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const nextDepth = Math.max(0, (tailFrameDragDepthRef.current.get(rowKey) ?? 1) - 1);
    if (nextDepth === 0) clearTailFrameDragState(rowKey);
    else tailFrameDragDepthRef.current.set(rowKey, nextDepth);
  };

  const handleTailFrameDrop = (
    event: ReactDragEvent<HTMLElement>,
    shotId: string | null,
    rowKey: string,
    enabled: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    clearTailFrameDragState(rowKey);
    if (!enabled || !shotId) return;
    const file = Array.from(event.dataTransfer.files).find((candidate) =>
      ['image/png', 'image/jpeg', 'image/webp'].includes(candidate.type),
    );
    if (!file) {
      updateRowsForShot(shotId, rowKey, (row) => ({
        ...row,
        tailUploadState: 'failed',
        tailUploadError: '请拖入 PNG、JPEG 或 WebP 图片',
      }));
      return;
    }
    void handleTailFrameUpload(shotId, rowKey, file);
  };

  const handleFreeHeadFrameDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearTailFrameDragState(FREE_HEAD_FRAME_DRAG_KEY);
    if (headFrameBusy || creating) return;
    const file = Array.from(event.dataTransfer.files).find((candidate) =>
      ['image/png', 'image/jpeg', 'image/webp'].includes(candidate.type),
    );
    if (!file) {
      alert('请拖入 PNG、JPEG 或 WebP 图片');
      return;
    }
    void handleAppendFreeShot(file);
  };

  const handleTailFrameRemove = async (shotId: string, rowKey: string) => {
    if (creatingRef.current) return;
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
    const submittedTailIds = new Set(items.flatMap((item) => item.tailImageId ? [item.tailImageId] : []));
    pendingCreationTailIdsRef.current = submittedTailIds;
    creatingRef.current = true;
    setCreating(true);
    try {
      const res = await fetch(`/api/shot-sets/${effectiveSetId}/video-jobs/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shotId, items }),
      });
      const data = await res.json();
      if (res.ok) {
        if (mountedRef.current) {
          await refreshJobs();
          perShotMotionCache.current.delete(shotId);
          replaceActiveMotionRows([makeEmptyRow()]);
        }
      } else {
        if (mountedRef.current) alert('创建视频任务失败: ' + (data.error || '未知错误'));
        else for (const assetId of submittedTailIds) await deleteTailFrameAsset(assetId).catch(() => undefined);
      }
    } catch (err) {
      if (mountedRef.current) alert('创建失败: ' + String(err));
      else for (const assetId of submittedTailIds) await deleteTailFrameAsset(assetId).catch(() => undefined);
    } finally {
      pendingCreationTailIdsRef.current = new Set();
      creatingRef.current = false;
      if (mountedRef.current) setCreating(false);
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
  const storyboardSets = availableSets.filter((s) => s.kind !== 'free');
  const freeSet = availableSets.find((s) => s.kind === 'free');

  const shotSetSelector = !shotSetId ? (
    <div className="mb-4">
      <label className="label">选择分镜组</label>
      <div className="flex items-center gap-2">
        <select
          value={selectedSetId}
          onChange={(e) => {
            const value = e.target.value;
            if (value === FREE_SET_OPTION) { void handleSelectFreeSet(); return; }
            handleSelectSet(value);
          }}
          className="input-field text-sm"
          disabled={selectorLocked}
        >
          <option value="">-- 选择分镜组 --</option>
          {storyboardSets.map((s) => (<option key={s.id} value={s.id}>{s.name} ({s.shotCount} 张)</option>))}
          {/* D15:一个项目一个自由工位。已经建过就直接列出来,没建过用哨兵值,
              选中时才 get-or-create。 */}
          {freeSet
            ? <option value={freeSet.id}>＋ 自由素材工位（{freeSet.shotCount} 张）</option>
            : <option value={FREE_SET_OPTION}>＋ 自由素材工位（直接传图做视频）</option>}
        </select>
        {canDeleteSelectedSet && (
          <button
            type="button"
            onClick={handleDeleteFreeSet}
            disabled={selectorLocked}
            className="icon-btn text-ink-tertiary hover:text-fail"
            title="删除这个自由素材工位"
            aria-label="删除这个自由素材工位"
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
      {availableSets.length === 0 && (
        <p className="mt-1 text-xs text-ink-tertiary">
          还没有分镜组。可以在分镜生成里创建，也可以直接选「自由素材工位」传图做视频。
        </p>
      )}
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
  const pendingFreeShotIndex = safeShots.reduce(
    (maxIndex, shot) => Math.max(maxIndex, shot.indexNum),
    0,
  ) + 1;
  const freeHeadFrameSlotSelected = Boolean(
    isFreeSet
    && selectedShot === null
    && (safeShots.length === 0 || freeHeadFrameSlotOpen),
  );
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
            {(safeShots.length > 0 || isFreeSet) && (
              <div className="shot-tab-row">
                {safeShots.map((shot) => (
                  <button
                    key={shot.id}
                    type="button"
                    onClick={() => activate(shot.id)}
                    disabled={creating}
                    className={`shot-tab-item ${selectedShot === shot.id ? 'active' : ''}`}
                  >
                    {isFreeSet ? `图 ${shot.indexNum}` : `分镜 ${shot.indexNum}`}
                  </button>
                ))}
                {isFreeSet && freeHeadFrameSlotOpen && (
                  <button
                    type="button"
                    onClick={activateFreeHeadFrameSlot}
                    disabled={headFrameBusy || creating}
                    className={`shot-tab-item ${freeHeadFrameSlotSelected ? 'active' : ''}`}
                    title="等待拖入首帧图片"
                  >
                    图 {pendingFreeShotIndex}
                  </button>
                )}
                {isFreeSet && (
                  <button
                    type="button"
                    onClick={activateFreeHeadFrameSlot}
                    disabled={headFrameBusy || creating}
                    className={`shot-tab-item shot-tab-add ${headFrameBusy ? 'is-busy' : ''}`}
                    title={freeHeadFrameSlotOpen ? '回到待添加图片槽位' : '增加一个空图片槽位'}
                  >
                    <Icon name="plus" size={13} />
                    {headFrameBusy ? '上传中…' : '添加图片'}
                  </button>
                )}
              </div>
            )}
            {isFreeSet && selectedShot && (
              <div className="free-shot-actions">
                <span>当前：图 {selectedShotData?.indexNum}</span>
                <button
                  type="button"
                  onClick={() => void handleDeleteFreeShot(selectedShot)}
                  disabled={!canDeleteShot(selectedShot) || deletingShot || creating}
                  title={canDeleteShot(selectedShot)
                    ? '删掉这张图'
                    : '这张图已经生成过视频了，不能删除'}
                  className="free-shot-delete"
                >
                  <Icon name="trash" size={12} /> {deletingShot ? '删除中…' : '删掉这张图'}
                </button>
              </div>
            )}
          </div>

          {/* Motion form — scrollable independently */}
          {freeHeadFrameSlotSelected && (
            <div className="panel-scroll-area">
              <div className="space-y-3">
                <div className="video-motion-card">
                  <span className="video-motion-label">描述 1</span>

                  <div className="video-frame-pair" data-testid="video-frame-pair">
                    <label
                      className={`video-frame-tile video-frame-empty ${headFrameBusy ? 'is-busy' : ''} ${tailFrameDragRowKey === FREE_HEAD_FRAME_DRAG_KEY ? 'is-dragging' : ''}`}
                      aria-live="polite"
                      onDragEnter={(event) => handleTailFrameDragEnter(event, FREE_HEAD_FRAME_DRAG_KEY, !headFrameBusy && !creating)}
                      onDragOver={(event) => handleTailFrameDragOver(event, !headFrameBusy && !creating)}
                      onDragLeave={(event) => handleTailFrameDragLeave(event, FREE_HEAD_FRAME_DRAG_KEY)}
                      onDrop={handleFreeHeadFrameDrop}
                    >
                      <span className="video-frame-empty-icon">
                        <Icon name="image" size={25} />
                        <span><Icon name="plus" size={10} /></span>
                      </span>
                      <strong>{headFrameBusy ? '上传中…' : '添加首帧图'}</strong>
                      <small>点击或拖入</small>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="sr-only"
                        disabled={headFrameBusy || creating}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = '';
                          if (file) void handleAppendFreeShot(file);
                        }}
                      />
                      {tailFrameDragRowKey === FREE_HEAD_FRAME_DRAG_KEY && (
                        <span className="video-frame-drop-overlay" role="status">
                          <Icon name="upload" size={19} />
                          <strong>松开添加首帧</strong>
                        </span>
                      )}
                    </label>

                    <div className="video-frame-bridge" aria-hidden="true">
                      <Icon name="chevron-right" size={18} />
                    </div>

                    <div className="video-frame-tile video-frame-empty is-disabled">
                      <span className="video-frame-empty-icon"><Icon name="image" size={25} /></span>
                      <strong>先添加首帧</strong>
                      <small>添加后可选</small>
                    </div>
                  </div>

                  {/* 这三块继续占据原位置；没有真实 shot 前禁用，不提交草稿。 */}
                  <select className="input-field video-control" disabled>
                    <option>选择视频供应商</option>
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <select className="input-field video-control" disabled>
                      <option>模板（可选）</option>
                    </select>
                    <input className="input-field video-control text-center" value={5} disabled readOnly />
                  </div>
                  <textarea
                    className="input-field video-prompt-field"
                    placeholder="运镜描述（提示词）"
                    disabled
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button className="btn-secondary btn-sm w-full video-add-action" disabled>
                  <Icon name="plus" size={12} /> 添加描述
                </button>
                <div>
                  <label className="label generation-label">并发数</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={videoConcurrency}
                    onChange={(event) => handleVideoConcurrencyChange(Number(event.target.value))}
                    className="input-field generation-control generation-number"
                  />
                  <p className="generation-helper">失败或限流时调回 1。</p>
                </div>
                <button className="btn-primary btn-sm w-full video-create-action" disabled>
                  生成 0 条视频
                </button>
              </div>
            </div>
          )}
          {selectedShot && (
            <div className="panel-scroll-area">
              <div className="space-y-3">
                {motionRows.map((row, idx) => {
                  const tailCapability = getRowTailCapability(row);
                  const tailIssue = getVideoMotionRowIssue(row, tailCapability);
                  const tailBusy = row.tailUploadState === 'uploading' || row.tailUploadState === 'deleting';
                  const tailDropEnabled = tailCapability?.supported === true && !tailBusy && !creating;
                  const tailDragging = tailFrameDragRowKey === row.key;
                  const tailDropHandlers = {
                    onDragEnter: (event: ReactDragEvent<HTMLElement>) => handleTailFrameDragEnter(event, row.key, tailDropEnabled),
                    onDragOver: (event: ReactDragEvent<HTMLElement>) => handleTailFrameDragOver(event, tailDropEnabled),
                    onDragLeave: (event: ReactDragEvent<HTMLElement>) => handleTailFrameDragLeave(event, row.key),
                    onDrop: (event: ReactDragEvent<HTMLElement>) => handleTailFrameDrop(event, selectedShot, row.key, tailDropEnabled),
                  };
                  return (
                  <div key={row.key} className="video-motion-card">
                    <span className="video-motion-label">描述 {idx + 1}</span>

                    <div className="video-frame-pair" data-testid="video-frame-pair">
                      <div className="video-frame-tile video-frame-source">
                        {selectedShotData?.imageUrl ? (
                          <HoverZoomImage
                            src={selectedShotData.imageUrl}
                            alt={`分镜 ${selectedShotData.indexNum} 首帧`}
                            className="video-frame-image"
                            zoomMaxWidth={520}
                            zoomMaxHeight={390}
                          />
                        ) : (
                          <div className="video-frame-placeholder">
                            <Icon name="image" size={22} />
                            <span>首帧不可用</span>
                          </div>
                        )}
                        <span className="video-frame-chip">首帧</span>
                      </div>

                      <div className="video-frame-bridge" aria-hidden="true">
                        <Icon name="chevron-right" size={18} />
                      </div>

                      {row.tailImageId ? (
                        <div
                          className={`video-frame-tile video-frame-tail ${tailDragging ? 'is-dragging' : ''}`}
                          aria-live="polite"
                          {...tailDropHandlers}
                        >
                          {row.tailImageUrl ? (
                            <HoverZoomImage
                              src={row.tailImageUrl}
                              alt="尾帧预览"
                              className="video-frame-image"
                              zoomMaxWidth={520}
                              zoomMaxHeight={390}
                            />
                          ) : (
                            <div className="video-frame-placeholder">
                              <Icon name="image" size={22} />
                              <span className="max-w-full truncate px-2">{row.tailImageName || '已添加尾帧'}</span>
                            </div>
                          )}
                          <span className="video-frame-chip">尾帧</span>
                          <div className="video-frame-actions">
                            {tailCapability?.supported && (
                              <label className="video-frame-action">
                                <Icon name="upload" size={12} />
                                更换
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp"
                                  className="sr-only"
                                  disabled={tailBusy || creating}
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
                              disabled={tailBusy || creating}
                              className="video-frame-action video-frame-remove"
                              title="移除尾帧"
                              aria-label="移除尾帧"
                            >
                              <Icon name="close" size={12} />
                            </button>
                          </div>
                          {tailBusy && (
                            <div className="video-frame-busy">
                              {row.tailUploadState === 'deleting' ? '移除中…' : '更换中…'}
                            </div>
                          )}
                          {tailDragging && (
                            <div className="video-frame-drop-overlay" role="status">
                              <Icon name="upload" size={19} />
                              <strong>松开替换尾帧</strong>
                            </div>
                          )}
                        </div>
                      ) : tailCapability?.supported ? (
                        <label
                          className={`video-frame-tile video-frame-empty ${tailBusy ? 'is-busy' : ''} ${tailDragging ? 'is-dragging' : ''}`}
                          aria-live="polite"
                          {...tailDropHandlers}
                        >
                          <span className="video-frame-empty-icon">
                            <Icon name="image" size={25} />
                            <span><Icon name="plus" size={10} /></span>
                          </span>
                          <strong>{row.tailUploadState === 'uploading' ? '上传中…' : '添加尾帧图'}</strong>
                          <small>可选 · 点击或拖入</small>
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="sr-only"
                            disabled={tailBusy || creating}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (file && selectedShot) void handleTailFrameUpload(selectedShot, row.key, file);
                            }}
                          />
                          {tailDragging && (
                            <span className="video-frame-drop-overlay" role="status">
                              <Icon name="upload" size={19} />
                              <strong>松开添加尾帧</strong>
                            </span>
                          )}
                        </label>
                      ) : (
                        <div className="video-frame-tile video-frame-empty is-disabled" {...tailDropHandlers}>
                          <span className="video-frame-empty-icon"><Icon name="image" size={25} /></span>
                          <strong>暂不支持尾帧</strong>
                          <small>切换支持的模型后可添加</small>
                        </div>
                      )}
                    </div>

                    {tailIssue && (row.tailImageId || row.tailUploadState === 'failed') && (
                      <p className="video-tail-frame-warning" role="status">
                        <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                        {tailIssue}
                      </p>
                    )}

                    <select
                      value={getRowProviderId(row)}
                      onChange={(e) => updateRowProvider(row.key, e.target.value)}
                      className="input-field video-control"
                      disabled={creating || configuredProviders.length === 0}
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
                        disabled={creating}
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
                        disabled={creating}
                      />
                    </div>

                    <textarea
                      value={row.prompt}
                      onChange={(e) => updateRowPrompt(row.key, e.target.value)}
                      rows={3}
                      className="input-field video-prompt-field"
                      placeholder="运镜描述（提示词）"
                      disabled={creating}
                    />

                    <button
                      onClick={() => removeMotionRow(row.key)}
                      disabled={creating || motionRows.length <= 1}
                      className="video-motion-delete"
                      title="删除该描述"
                    ><Icon name="trash" size={12} /></button>
                  </div>
                  );
                })}
              </div>

              <div className="flex flex-col gap-2">
                <button onClick={addMotionRow} disabled={creating} className="btn-secondary btn-sm w-full video-add-action">
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
            placeholderText={freeHeadFrameSlotSelected
              ? '添加首帧图后开始生成'
              : safeShots.length > 0 ? '选择左侧分镜并生成视频' : '暂无分镜'}
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

      {safeShots.length === 0 && !isFreeSet && (
        <p className="text-xs text-ink-tertiary mt-3">分镜组中没有分镜。</p>
      )}
    </div>
  );
}
