'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import HoverZoomImage from '@/components/HoverZoomImage';
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

const VIDEO_STATUS_LABELS: Record<string, string> = {
  succeeded: '完成',
  failed: '失败',
  running: '运行中',
  pending: '等待',
  needs_check: '待补抓',
  canceled: '已取消',
};

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
  const loadShotsForSet = async (setId: string) => {
    try {
      const res = await fetch(`/api/shot-sets/${setId}`);
      const data = await res.json();
      if (data.shots && selectedSetIdRef.current === setId) {
        setSelectedSetShots(data.shots.map((s: { id: string; indexNum: number; sourceImageId: string; latestGeneratedImageId?: string; sourceImageUrl?: string; generatedImageUrl?: string }) => ({
          id: s.id, indexNum: s.indexNum, sourceImageId: s.sourceImageId,
          latestGeneratedImageId: s.latestGeneratedImageId,
          imageUrl: s.generatedImageUrl || s.sourceImageUrl || '',
        })));
      }
      // Load video jobs
      const jobRes = await fetch(`/api/shot-sets/${setId}/video-jobs`);
      const jobData = await jobRes.json().catch(() => ({ jobs: [] }));
      if (jobData.jobs && selectedSetIdRef.current === setId) setVideoJobs(jobData.jobs);
    } catch { /* ignore */ }
  };

  const handleSelectSet = (setId: string) => {
    setSelectedSetId(setId);
    selectedSetIdRef.current = setId;
    setSelectedShot(null);
    setMotionRows([]);
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

  // Index video jobs by shotId for O(1) lookup (avoid O(N*M) per render)
  const videoJobsByShot = useMemo(() => {
    const map = new Map<string, VideoJob[]>();
    for (const j of videoJobs) {
      const arr = map.get(j.shotId);
      if (arr) arr.push(j);
      else map.set(j.shotId, [j]);
    }
    return map;
  }, [videoJobs]);

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
    if (items.some((r) => !r.providerId)) { alert('每行都需要选择供应商'); return; }
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

  return (
    <div className="mt-3 min-w-0 max-w-full rounded-lg bg-surface-subtle p-3">
      <h4 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink"><Icon name="video" size={15} /> 视频生成</h4>
      {shotSetSelector}

      {/* Per-shot panels */}
      {safeShots.map((shot) => {
        const shotVideos = videoJobsByShot.get(shot.id) || [];
        return (
          <div key={shot.id} className="mb-4 min-w-0 max-w-full rounded-[18px] border border-hairline bg-white p-4">
            <div className="mb-3 flex flex-wrap items-start gap-4">
              <span className="mt-2 min-w-16 text-xs font-medium text-ink-secondary">分镜 {shot.indexNum}</span>
              {shot.imageUrl && (
                <HoverZoomImage
                  src={shot.imageUrl}
                  alt={`Shot ${shot.indexNum}`}
                  className="h-36 w-56 max-w-full cursor-pointer rounded-[18px] border border-hairline bg-surface-subtle object-cover shadow-sm transition-colors hover:border-accent/40"
                  zoomMaxWidth={520}
                  zoomMaxHeight={390}
                />
              )}
            </div>

            {/* Create video form — each row is one horizontal "描述" line */}
            {selectedShot === shot.id ? (
              <div className="mb-2 min-w-0 max-w-full space-y-2">
                {motionRows.map((row, idx) => (
                  <div key={row.key} className="grid min-w-0 max-w-full grid-cols-[auto_minmax(5.5rem,1fr)_minmax(5.5rem,1fr)_minmax(5.5rem,1fr)_minmax(16rem,3fr)_2.5rem] items-start gap-2 rounded border border-hairline bg-surface-subtle px-2 py-1.5 max-xl:grid-cols-[auto_minmax(5.5rem,1fr)_minmax(5.5rem,1fr)_minmax(5.5rem,1fr)_2.5rem] max-xl:[&_.motion-prompt]:col-span-full max-sm:grid-cols-1">
                    <span className="shrink-0 whitespace-nowrap text-[10px] text-ink-tertiary">描述 {idx + 1}</span>
                    <select
                      value={row.providerId}
                      onChange={(e) => updateRowProvider(idx, e.target.value)}
                      className="input-field !w-full text-xs h-9"
                    >
                      <option value="">供应商</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <select
                      value={row.templateId}
                      onChange={(e) => updateRowTemplate(idx, e.target.value)}
                      className="input-field !w-full text-xs h-9"
                    >
                      <option value="">模板（可选）</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={2}
                      max={15}
                      value={row.durationSec}
                      onChange={(e) => updateRowDuration(idx, Number(e.target.value))}
                      className="input-field !w-full text-center text-xs h-9"
                      title="秒数"
                    />
                    <textarea
                      value={row.prompt}
                      onChange={(e) => updateRowPrompt(idx, e.target.value)}
                      rows={3}
                      className="motion-prompt input-field min-h-[4.75rem] min-w-0 !w-full resize-y text-xs font-mono leading-relaxed"
                      placeholder="运镜描述（提示词）"
                    />
                    <button
                      onClick={() => removeMotionRow(idx)}
                      disabled={motionRows.length <= 1}
                      className="icon-btn h-8 w-8 shrink-0 justify-self-end rounded-full border border-hairline bg-white text-ink-secondary hover:border-fail/30 hover:bg-fail-tint hover:text-fail disabled:cursor-not-allowed disabled:bg-transparent disabled:text-ink-tertiary disabled:opacity-35 max-sm:justify-self-start"
                      title="删除该描述"
                    ><Icon name="trash" size={14} /></button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={addMotionRow} className="btn-secondary btn-sm text-xs"><Icon name="plus" size={13} /> 描述</button>
                  <button
                    onClick={() => handleCreateVideos(shot.id)}
                    disabled={creating || motionRows.every((r) => !r.prompt.trim())}
                    className="btn-primary btn-sm text-xs"
                  >
                    {creating
                      ? '创建中...'
                      : `并发生成 ${motionRows.filter((r) => r.prompt.trim()).length} 条视频`}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => activate(shot.id)} className="btn-secondary btn-sm text-xs mb-2"><Icon name="plus" size={13} /> 描述</button>
            )}

            {/* Existing video jobs for this shot */}
            {shotVideos.length > 0 && (
              <div className="space-y-1 mt-1">
                {shotVideos.map((job) => (
                  <div key={job.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded bg-surface-subtle p-1.5 text-xs">
                    <span className={`status-badge status-${job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' ? 'failed' : job.status === 'running' ? 'running' : 'pending'}`}>
                      {VIDEO_STATUS_LABELS[job.status] || job.status}
                    </span>
                    <div className="min-w-0 flex-1 truncate">
                      <div className="text-ink-secondary">
                        {job.providerName || '-'} / {job.templateName || '自定义'} / {job.durationSec}s
                      </div>
                      {job.prompt && (
                        <div className="truncate text-[10px] text-ink-tertiary" title={job.prompt}>
                          {job.prompt}
                        </div>
                      )}
                    </div>
                    {job.status === 'succeeded' && job.filename && (
                      <>
                        <a href={`/api/videos/videos/${encodeURIComponent(job.filename)}`} download className="link-accent inline-flex items-center gap-1 text-xs"><Icon name="download" size={12} /> 下载</a>
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); setVideoPreviewJobId(videoPreviewJobId === job.id ? null : job.id); }}
                          className="link-accent inline-flex items-center gap-1 text-xs"
                        >
                          {videoPreviewJobId === job.id ? '收起' : '预览'}
                        </button>
                      </>
                    )}
                    {job.status === 'needs_check' && (
                      <button onClick={() => handleResumePoll(job.id)} className="link-accent text-xs">补抓结果</button>
                    )}
                    {(job.status === 'failed' || job.status === 'canceled') && (
                      <button onClick={() => handleRetry(job.id)} className="link-accent text-xs">重试</button>
                    )}
                    {job.errorMessage && (
                      <span className="break-words text-[10px] text-fail">{job.errorMessage}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Video preview — rendered outside the row so the element is in the DOM when shown */}
            {videoPreviewJobId && shotVideos.find((j) => j.id === videoPreviewJobId)?.filename && (
              <div className="mt-2">
                <video
                  controls
                  className="max-w-[400px] max-h-[300px] rounded border"
                  src={`/api/videos/videos/${encodeURIComponent(shotVideos.find((j) => j.id === videoPreviewJobId)!.filename!)}`}
                />
              </div>
            )}
          </div>
        );
      })}

      {safeShots.length === 0 && (
        <p className="text-xs text-ink-tertiary">分镜组中没有分镜。</p>
      )}
    </div>
  );
}
