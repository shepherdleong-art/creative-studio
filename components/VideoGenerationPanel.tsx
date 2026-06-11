'use client';

import { useState, useEffect } from 'react';

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
  const [selectedSetShots, setSelectedSetShots] = useState<typeof shots>(shots);

  // Per-shot form state
  const [selectedShot, setSelectedShot] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(5);
  const [creating, setCreating] = useState(false);

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

  // Load shots when set is selected
  const loadShotsForSet = async (setId: string) => {
    try {
      const res = await fetch(`/api/shot-sets/${setId}`);
      const data = await res.json();
      if (data.shots) {
        setSelectedSetShots(data.shots.map((s: { id: string; indexNum: number; sourceImageId: string; latestGeneratedImageId?: string; sourceImageUrl?: string; generatedImageUrl?: string }) => ({
          id: s.id, indexNum: s.indexNum, sourceImageId: s.sourceImageId,
          latestGeneratedImageId: s.latestGeneratedImageId,
          imageUrl: s.generatedImageUrl || s.sourceImageUrl || '',
        })));
      }
      // Load video jobs
      const jobRes = await fetch(`/api/shot-sets/${setId}/video-jobs`);
      const jobData = await jobRes.json().catch(() => ({ jobs: [] }));
      if (jobData.jobs) setVideoJobs(jobData.jobs);
    } catch { /* ignore */ }
  };

  const handleSelectSet = (setId: string) => {
    setSelectedSetId(setId);
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

  // Auto-fill template prompt on selection
  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplate(templateId);
    const tmpl = templates.find((t) => t.id === templateId);
    if (tmpl && !prompt.trim()) {
      setPrompt(tmpl.prompt);
    }
  };

  const handleCreateVideo = async (shotId: string) => {
    if (!selectedProvider || !prompt.trim()) {
      alert('请选择供应商并填写提示词');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`/api/shot-sets/${effectiveSetId}/video-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shotId,
          providerId: selectedProvider,
          templateId: selectedTemplate || undefined,
          prompt: prompt.trim(),
          durationSec: duration,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        await refreshJobs();
        setSelectedTemplate('');
        setPrompt('');
        setDuration(5);
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
    await fetch(`/api/video-jobs/${jobId}/retry`, { method: 'POST' });
    await refreshJobs();
  };

  const handleResumePoll = async (jobId: string) => {
    await fetch(`/api/video-jobs/${jobId}/resume-poll`, { method: 'POST' });
    await refreshJobs();
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
    <div className="mt-3 p-3 bg-gray-50 rounded-lg">
      <h4 className="text-sm font-medium mb-3 text-gray-700">🎬 视频生成</h4>

      {/* Per-shot panels */}
      {safeShots.map((shot) => {
        const shotVideos = videoJobs.filter((j) => j.shotId === shot.id);
        return (
          <div key={shot.id} className="mb-3 p-3 bg-white rounded border">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-xs font-medium text-gray-500">分镜 {shot.indexNum}</span>
              {shot.imageUrl && (
                <img src={shot.imageUrl} alt={`Shot ${shot.indexNum}`} className="w-10 h-10 object-cover rounded border" />
              )}
            </div>

            {/* Create video form */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
              <select
                value={selectedShot === shot.id ? selectedProvider : ''}
                onChange={(e) => { setSelectedShot(shot.id); setSelectedProvider(e.target.value); }}
                className="input-field text-xs"
              >
                <option value="">选择供应商</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <select
                value={selectedShot === shot.id ? selectedTemplate : ''}
                onChange={(e) => { setSelectedShot(shot.id); handleTemplateChange(e.target.value); }}
                className="input-field text-xs"
              >
                <option value="">运镜模板（可选）</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <input
                type="number"
                min={2}
                max={15}
                value={selectedShot === shot.id ? duration : 5}
                onChange={(e) => { setSelectedShot(shot.id); setDuration(Math.max(2, Math.min(15, Number(e.target.value) || 5))); }}
                className="input-field text-xs w-20"
                placeholder="秒"
              />
              <button
                onClick={() => handleCreateVideo(shot.id)}
                disabled={creating}
                className="btn-primary btn-sm text-xs"
              >
                {creating ? '创建中...' : `生成 ${duration} 秒视频`}
              </button>
            </div>
            {(selectedShot === shot.id) && (
              <textarea
                value={selectedShot === shot.id ? prompt : ''}
                onChange={(e) => { setSelectedShot(shot.id); setPrompt(e.target.value); }}
                rows={2}
                className="input-field text-xs font-mono mb-2"
                placeholder="视频生成提示词（运镜描述）"
              />
            )}

            {/* Existing video jobs for this shot */}
            {shotVideos.length > 0 && (
              <div className="space-y-1 mt-1">
                {shotVideos.map((job) => (
                  <div key={job.id} className="flex items-center gap-2 text-xs p-1.5 bg-gray-50 rounded">
                    <span className={`status-badge status-${job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' ? 'failed' : job.status === 'running' ? 'running' : 'pending'}`}>
                      {job.status === 'succeeded' ? '✅' : job.status === 'failed' ? '❌' : job.status === 'running' ? '⏳' : job.status === 'pending' ? '📋' : '⚠️'}
                    </span>
                    <span className="text-gray-600 truncate flex-1">
                      {job.providerName || '-'} / {job.templateName || '自定义'} / {job.durationSec}s
                    </span>
                    {job.status === 'succeeded' && job.filename && (
                      <a href={`/api/videos/videos/${encodeURIComponent(job.filename)}`} download className="text-blue-600 hover:underline">下载</a>
                    )}
                    {job.status === 'needs_check' && (
                      <button onClick={() => handleResumePoll(job.id)} className="text-purple-600 hover:underline">补抓结果</button>
                    )}
                    {(job.status === 'failed' || job.status === 'canceled') && (
                      <button onClick={() => handleRetry(job.id)} className="text-blue-600 hover:underline">重试</button>
                    )}
                    {job.errorMessage && (
                      <span className="text-red-400 truncate max-w-[120px]" title={job.errorMessage}>{job.errorMessage}</span>
                    )}
                  </div>
                ))}
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
