'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import HoverZoomImage from '@/components/HoverZoomImage';
import VideoGenerationPreview from '@/components/VideoGenerationPreview';
import VideoGenerationResults from '@/components/VideoGenerationResults';
import { Icon } from '@/components/ui/Icon';

interface VideoProvider {
  id: string;
  name: string;
  type: string;
  defaultModel: string;
  defaultDurationSec: number;
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
  const [motionRows, setMotionRows] = useState<Array<{ key: string; prompt: string; templateId: string; providerId: string; durationSec: number }>>([]);
  const perShotMotionCache = useRef<Map<string, typeof motionRows>>(new Map());
  const [creating, setCreating] = useState(false);
  const [videoPreviewJobId, setVideoPreviewJobId] = useState<string | null>(null);
  const previewSuppressedRef = useRef(false);

  const defaultProviderId = providers.length > 0 ? providers[0].id : '';
  const defaultDuration = 5;
  const storageKey = `creative-studio:video-shot-set:${projectId}`;

  const makeEmptyRow = (): { key: string; prompt: string; templateId: string; providerId: string; durationSec: number } => ({
    key: crypto.randomUUID(), prompt: '', templateId: '', providerId: defaultProviderId, durationSec: defaultDuration,
  });

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

  // Backfill empty providerId in motion rows once providers arrive.  This
  // handles the race where loadShotsForSet auto-selects a shot and creates
  // a row with defaultProviderId = '' before /api/providers/video resolves.
  useEffect(() => {
    if (providers.length === 0) return;
    const firstId = providers[0].id;
    setMotionRows((rows) => {
      if (rows.some((r) => !r.providerId)) {
        return rows.map((r) => (r.providerId ? r : { ...r, providerId: firstId }));
      }
      return rows;
    });
  }, [providers]);

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
          setSelectedShot(loadedShots[0].id);
          setMotionRows([makeEmptyRow()]);
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
    setSelectedSetId(setId);
    selectedSetIdRef.current = setId;
    setSelectedShot(null);
    setMotionRows([]);
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
        // Auto-start video queue when pending jobs are detected
        if (data.jobs.some((j: { status: string }) => j.status === 'pending')) {
          ensureVideoQueueRunning(projectId);
        }
      }
    } catch { /* ignore */ }
  };

  // Poll video job status every 3s while any job is still active
  const hasActiveVideoJobs = useMemo(
    () => videoJobs.some((j) => j.status === 'pending' || j.status === 'running'),
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
        perShotMotionCache.current.set(selectedShot, motionRows);
      }
      setSelectedShot(shotId);
      // Restore cached rows or start fresh
      const cached = perShotMotionCache.current.get(shotId);
      setMotionRows(cached ? [...cached] : [makeEmptyRow()]);
    }
  };

  const addMotionRow = () => setMotionRows((rows) => {
    return [...rows, makeEmptyRow()];
  });
  const removeMotionRow = (idx: number) =>
    setMotionRows((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== idx)));
  const updateRowPrompt = (idx: number, value: string) =>
    setMotionRows((rows) => rows.map((r, i) => (i === idx ? { ...r, prompt: value } : r)));
  const updateRowTemplate = (idx: number, templateId: string) =>
    setMotionRows((rows) => rows.map((r, i) => {
      if (i !== idx) return r;
      const oldTmpl = r.templateId ? templates.find((t) => t.id === r.templateId) : null;
      const newTmpl = templates.find((t) => t.id === templateId);
      // Update prompt when: prompt is empty (first selection), or the current
      // prompt matches the old template exactly (auto-filled, not user-edited).
      // Preserve prompts that the user has manually written.
      const isAutoFilled = !r.prompt.trim() || (oldTmpl ? r.prompt.trim() === oldTmpl.prompt.trim() : false);
      const nextPrompt = (isAutoFilled && newTmpl) ? newTmpl.prompt : r.prompt;
      return { ...r, templateId, prompt: nextPrompt };
    }));
  const updateRowProvider = (idx: number, providerId: string) =>
    setMotionRows((rows) => rows.map((r, i) => (i === idx ? { ...r, providerId } : r)));
  const updateRowDuration = (idx: number, raw: number) =>
    setMotionRows((rows) => rows.map((r, i) => {
      if (i !== idx) return r;
      const v = Number.isFinite(raw) && raw > 0 ? raw : 5;
      return { ...r, durationSec: Math.max(2, Math.min(15, v)) };
    }));

  const handleCreateVideos = async (shotId: string) => {
    const items = motionRows
      .map((r) => ({
        prompt: r.prompt.trim(),
        templateId: r.templateId || null,
        providerId: r.providerId,
        durationSec: r.durationSec,
      }))
      .filter((r) => r.prompt.length > 0);
    if (items.length === 0) { alert('请至少填写一条描述提示词'); return; }
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
        setMotionRows([makeEmptyRow()]);
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
        <div className="panel-col">
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

          {/* Motion form */}
          {selectedShot && (
            <>
              <div className="space-y-3">
                {motionRows.map((row, idx) => (
                  <div key={row.key} className="video-motion-card">
                    <span className="video-motion-label">描述 {idx + 1}</span>

                    <select
                      value={row.providerId}
                      onChange={(e) => updateRowProvider(idx, e.target.value)}
                      className="input-field video-control"
                    >
                      {providers.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                    </select>

                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={row.templateId}
                        onChange={(e) => updateRowTemplate(idx, e.target.value)}
                        className="input-field video-control"
                      >
                        <option value="">模板（可选）</option>
                        {templates.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
                      </select>
                      <input
                        type="number" min={2} max={15}
                        value={row.durationSec}
                        onChange={(e) => updateRowDuration(idx, Number(e.target.value))}
                        className="input-field video-control text-center"
                        title="秒数"
                      />
                    </div>

                    <textarea
                      value={row.prompt}
                      onChange={(e) => updateRowPrompt(idx, e.target.value)}
                      rows={3}
                      className="input-field video-prompt-field"
                      placeholder="运镜描述（提示词）"
                    />

                    <button
                      onClick={() => removeMotionRow(idx)}
                      disabled={motionRows.length <= 1}
                      className="video-motion-delete"
                      title="删除该描述"
                    ><Icon name="trash" size={12} /></button>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <button onClick={addMotionRow} className="btn-secondary btn-sm w-full video-add-action">
                  <Icon name="plus" size={12} /> 添加描述
                </button>
                <button
                  onClick={() => handleCreateVideos(selectedShot)}
                  disabled={creating || motionRows.every((r) => !r.prompt.trim())}
                  className="btn-primary btn-sm w-full video-create-action"
                >
                  {creating
                    ? '创建中...'
                    : `生成 ${motionRows.filter((r) => r.prompt.trim()).length} 条视频`}
                </button>
              </div>
            </>
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
            onNavigate={(jobId) => {
              previewSuppressedRef.current = false;
              setVideoPreviewJobId(jobId);
            }}
            onClose={() => {
              previewSuppressedRef.current = true;
              setVideoPreviewJobId(null);
            }}
          />
        </div>

        {/* ═══ RIGHT: Result cards ═══ */}
        <div className="panel-col">
          <VideoGenerationResults
            videoJobs={videoJobs}
            onPreview={(jobId) => {
              if (videoPreviewJobId === jobId) {
                previewSuppressedRef.current = true;
                setVideoPreviewJobId(null);
              } else {
                previewSuppressedRef.current = false;
                setVideoPreviewJobId(jobId);
              }
            }}
            onRetry={handleRetry}
            onResumePoll={handleResumePoll}
            activePreviewJobId={videoPreviewJobId}
          />
        </div>
      </div>

      {safeShots.length === 0 && (
        <p className="text-xs text-ink-tertiary mt-3">分镜组中没有分镜。</p>
      )}
    </div>
  );
}
