'use client';

import { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import HoverZoomImage from '@/components/HoverZoomImage';

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

  // Per-shot form state (one active shot at a time)
  const [selectedShot, setSelectedShot] = useState<string | null>(null);
  const [motionRows, setMotionRows] = useState<Array<{ key: string; prompt: string; templateId: string; providerId: string; durationSec: number }>>([]);
  const perShotMotionCache = useRef<Map<string, typeof motionRows>>(new Map());
  const [creating, setCreating] = useState(false);
  const [videoPreviewJobId, setVideoPreviewJobId] = useState<string | null>(null);

  const defaultProviderId = providers.length > 0 ? providers[0].id : '';
  const defaultDuration = 5;

  const makeEmptyRow = (): { key: string; prompt: string; templateId: string; providerId: string; durationSec: number } => ({
    key: uuidv4(), prompt: '', templateId: '', providerId: defaultProviderId, durationSec: defaultDuration,
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
    if (setId) loadShotsForSet(setId);
  };

  const effectiveSetId = shotSetId || selectedSetId;
  const effectiveShots = shots || selectedSetShots;
  const safeShots = effectiveShots || [];

  const refreshJobs = async () => {
    if (!effectiveSetId) return;
    try {
      const res = await fetch(`/api/shot-sets/${effectiveSetId}/video-jobs`);
      const data = await res.json().catch(() => ({ jobs: [] }));
      if (data.jobs) setVideoJobs(data.jobs);
    } catch { /* ignore */ }
  };

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
      const tmpl = templates.find((t) => t.id === templateId);
      const nextPrompt = !r.prompt.trim() && tmpl ? tmpl.prompt : r.prompt;
      return { ...r, templateId, prompt: nextPrompt };
    }));
  const updateRowProvider = (idx: number, providerId: string) =>
    setMotionRows((rows) => rows.map((r, i) => (i === idx ? { ...r, providerId } : r)));
  const updateRowDuration = (idx: number, durationSec: number) =>
    setMotionRows((rows) => rows.map((r, i) => (i === idx ? { ...r, durationSec } : r)));

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

  if (loading) return <p className="text-xs text-gray-400">加载视频功能...</p>;
  if (!effectiveSetId && !shotSetId) {
    // Top-level: show shot set selector
    return (
      <div>
        <div className="mb-3">
          <label className="text-xs text-gray-500">选择分镜组</label>
          <select value={selectedSetId} onChange={(e) => handleSelectSet(e.target.value)} className="input-field text-sm">
            <option value="">-- 选择分镜组 --</option>
            {availableSets.map((s) => (<option key={s.id} value={s.id}>{s.name} ({s.shotCount} 张)</option>))}
          </select>
          {availableSets.length === 0 && <p className="text-xs text-gray-400 mt-1">暂无分镜组，请先在分镜生成中创建。</p>}
        </div>
        {!selectedSetId && <p className="text-xs text-gray-400">选择一个分镜组后可以创建视频任务。</p>}
      </div>
    );
  }

  return (
    <div className="mt-3 min-w-0 max-w-full rounded-lg bg-gray-50 p-3">
      <h4 className="text-sm font-medium mb-3 text-gray-700">🎬 视频生成</h4>

      {/* Per-shot panels */}
      {safeShots.map((shot) => {
        const shotVideos = videoJobs.filter((j) => j.shotId === shot.id);
        return (
          <div key={shot.id} className="mb-3 min-w-0 max-w-full rounded border bg-white p-3">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-xs font-medium text-gray-500">分镜 {shot.indexNum}</span>
              {shot.imageUrl && (
                <HoverZoomImage
                  src={shot.imageUrl}
                  alt={`Shot ${shot.indexNum}`}
                  className="w-10 h-10 object-cover rounded border cursor-pointer hover:border-purple-300 transition-colors"
                />
              )}
            </div>

            {/* Create video form — each row is one horizontal "描述" line */}
            {selectedShot === shot.id ? (
              <div className="mb-2 min-w-0 max-w-full space-y-2">
                {motionRows.map((row, idx) => (
                  <div key={row.key} className="flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded border bg-gray-50 px-2 py-1.5">
                    <span className="text-[10px] text-gray-400 whitespace-nowrap shrink-0">描述 {idx + 1}</span>
                    <select
                      value={row.providerId}
                      onChange={(e) => updateRowProvider(idx, e.target.value)}
                      className="input-field w-24 max-w-full shrink-0 text-xs"
                    >
                      <option value="">供应商</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <select
                      value={row.templateId}
                      onChange={(e) => updateRowTemplate(idx, e.target.value)}
                      className="input-field w-32 max-w-full shrink-0 text-xs"
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
                      onChange={(e) => updateRowDuration(idx, Math.max(2, Math.min(15, Number(e.target.value) || 5)))}
                      className="input-field w-14 max-w-full shrink-0 text-center text-xs"
                      title="秒数"
                    />
                    <input
                      type="text"
                      value={row.prompt}
                      onChange={(e) => updateRowPrompt(idx, e.target.value)}
                      className="input-field min-w-0 flex-[1_1_18rem] text-xs font-mono"
                      placeholder="运镜描述（提示词）"
                    />
                    <button
                      onClick={() => removeMotionRow(idx)}
                      disabled={motionRows.length <= 1}
                      className="shrink-0 px-1 text-base leading-none text-gray-400 hover:text-red-500 disabled:opacity-30"
                      title="删除该描述"
                    >−</button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={addMotionRow} className="btn-secondary btn-sm text-xs">+ 描述</button>
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
              <button onClick={() => activate(shot.id)} className="btn-secondary btn-sm text-xs mb-2">+ 描述</button>
            )}

            {/* Existing video jobs for this shot */}
            {shotVideos.length > 0 && (
              <div className="space-y-1 mt-1">
                {shotVideos.map((job) => (
                  <div key={job.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded bg-gray-50 p-1.5 text-xs">
                    <span className={`status-badge status-${job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' ? 'failed' : job.status === 'running' ? 'running' : 'pending'}`}>
                      {job.status === 'succeeded' ? '✅' : job.status === 'failed' ? '❌' : job.status === 'running' ? '⏳' : job.status === 'pending' ? '📋' : '⚠️'}
                    </span>
                    <div className="min-w-0 flex-1 truncate">
                      <div className="text-gray-600">
                        {job.providerName || '-'} / {job.templateName || '自定义'} / {job.durationSec}s
                      </div>
                      {job.prompt && (
                        <div className="text-[10px] text-gray-400 truncate" title={job.prompt}>
                          {job.prompt}
                        </div>
                      )}
                    </div>
                    {job.status === 'succeeded' && job.filename && (
                      <>
                        <a href={`/api/videos/videos/${encodeURIComponent(job.filename)}`} download className="text-blue-600 hover:underline">下载</a>
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); setVideoPreviewJobId(videoPreviewJobId === job.id ? null : job.id); }}
                          className="text-[10px] text-purple-600 hover:text-purple-800 cursor-pointer ml-1"
                        >
                          {videoPreviewJobId === job.id ? '收起' : '预览'}
                        </button>
                      </>
                    )}
                    {job.status === 'needs_check' && (
                      <button onClick={() => handleResumePoll(job.id)} className="text-purple-600 hover:underline">补抓结果</button>
                    )}
                    {(job.status === 'failed' || job.status === 'canceled') && (
                      <button onClick={() => handleRetry(job.id)} className="text-blue-600 hover:underline">重试</button>
                    )}
                    {job.errorMessage && (
                      <span className="text-red-400 text-[10px] break-words">{job.errorMessage}</span>
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
        <p className="text-xs text-gray-400">分镜组中没有分镜。</p>
      )}
    </div>
  );
}
