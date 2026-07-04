'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ShotSetOption { id: string; name: string }
interface PreviewSegment { shotIndex: number; subtitle: string; clipDurationSec: number }
interface PreviewIssue { shotIndex: number; reason: string }
interface PreviewData {
  draft: { id: string; title: string } | null;
  segments: PreviewSegment[];
  issues: PreviewIssue[];
  totalDurationSec: number;
}
interface BgmFile { name: string; path: string }
interface FinalJob {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  currentStep: string;
  progress: number;
  durationSec: number | null;
  errorMessage: string | null;
  createdAt: string;
  packageConfig: { outputName?: string };
  outputUrl: string;
  coverUrl: string;
}

const STEP_LABELS: Record<string, string> = {
  queued: '排队中', preparing: '准备素材', tts: '合成口播', narration: '拼装口播音轨',
  cover: '生成封面', subtitles: '生成字幕', render: '合成视频', finalize: '写入产物', done: '完成',
};

const RESOLUTIONS = [
  { key: '9:16', label: '竖版 1080×1920', width: 1080, height: 1920 },
  { key: '16:9', label: '横版 1920×1080', width: 1920, height: 1080 },
  { key: '1:1', label: '方形 1080×1080', width: 1080, height: 1080 },
];

export default function FinalVideoPanel({ projectId }: { projectId: string }) {
  const [shotSets, setShotSets] = useState<ShotSetOption[]>([]);
  const [selectedSetId, setSelectedSetId] = useState('');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [bgmFiles, setBgmFiles] = useState<BgmFile[]>([]);
  const [jobs, setJobs] = useState<FinalJob[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 包装配置表单
  const [resolution, setResolution] = useState('9:16');
  const [bgmPath, setBgmPath] = useState('');
  const [bgmVolume, setBgmVolume] = useState(0.25);
  const [ducking, setDucking] = useState(true);
  const [coverTitle, setCoverTitle] = useState('');
  const [introSec, setIntroSec] = useState(0);
  const [subtitleEnabled, setSubtitleEnabled] = useState(true);
  const [subtitleSize, setSubtitleSize] = useState(56);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadShotSets = useCallback(async () => {
    const resp = await fetch(`/api/projects/${projectId}/shot-sets`);
    const data = await resp.json().catch(() => []);
    // 与 VideoGenerationPanel.tsx 读取分镜组列表的解析保持一致：直接返回数组
    const sets: ShotSetOption[] = (Array.isArray(data) ? data : []).map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }));
    setShotSets(sets);
    if (sets.length > 0 && !selectedSetId) setSelectedSetId(sets[0].id);
  }, [projectId, selectedSetId]);

  const loadPreview = useCallback(async (setId: string) => {
    if (!setId) { setPreview(null); return; }
    const resp = await fetch(`/api/projects/${projectId}/final-videos/preview?shotSetId=${encodeURIComponent(setId)}`);
    setPreview(await resp.json().catch(() => null));
  }, [projectId]);

  const loadBgm = useCallback(async () => {
    const resp = await fetch('/api/bgm');
    const data = await resp.json().catch(() => ({}));
    setBgmFiles(data.bgm ?? []);
  }, []);

  const loadJobs = useCallback(async () => {
    const resp = await fetch(`/api/projects/${projectId}/final-videos`);
    const data = await resp.json().catch(() => ({}));
    setJobs(data.jobs ?? []);
  }, [projectId]);

  useEffect(() => {
    loadShotSets();
    loadBgm();
    loadJobs();
  }, [loadShotSets, loadBgm, loadJobs]);

  useEffect(() => {
    loadPreview(selectedSetId);
  }, [selectedSetId, loadPreview]);

  // 有活跃任务时每 2s 轮询
  useEffect(() => {
    const active = jobs.some((j) => j.status === 'pending' || j.status === 'running');
    if (active && !pollTimer.current) {
      pollTimer.current = setInterval(loadJobs, 2000);
    }
    if (!active && pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [jobs, loadJobs]);

  const handleUploadBgm = useCallback(async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch('/api/bgm', { method: 'POST', body: form });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { setError(data.error || '上传失败'); return; }
    await loadBgm();
    setBgmPath(data.path);
  }, [loadBgm]);

  const handleSubmit = useCallback(async () => {
    if (!selectedSetId) return;
    setSubmitting(true);
    setError('');
    const res = RESOLUTIONS.find((r) => r.key === resolution) ?? RESOLUTIONS[0];
    try {
      const resp = await fetch(`/api/projects/${projectId}/final-videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shotSetId: selectedSetId,
          packageConfig: {
            outputName: `final-${Date.now()}`,
            width: res.width,
            height: res.height,
            bgm: bgmPath ? { path: bgmPath, volume: bgmVolume, ducking } : null,
            cover: { titleText: coverTitle, titleSize: 72, titleColor: '#ffffff', introDurationSec: introSec },
            subtitle: { enabled: subtitleEnabled, fontSize: subtitleSize, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 10 },
          },
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || '提交失败');
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [projectId, selectedSetId, resolution, bgmPath, bgmVolume, ducking, coverTitle, introSec, subtitleEnabled, subtitleSize, loadJobs]);

  const handleRetry = useCallback(async (id: string) => {
    await fetch(`/api/final-video-jobs/${id}/retry`, { method: 'POST' });
    await loadJobs();
  }, [loadJobs]);

  const handleDelete = useCallback(async (id: string) => {
    await fetch(`/api/final-video-jobs/${id}`, { method: 'DELETE' });
    await loadJobs();
  }, [loadJobs]);

  return (
    <div className="mt-3 space-y-4">
      {/* ① 分镜组与匹配预览 */}
      <div className="rounded-lg border border-hairline p-4">
        <label className="label">选择分镜组</label>
        <select value={selectedSetId} onChange={(e) => setSelectedSetId(e.target.value)} className="input-field text-sm">
          {shotSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {shotSets.length === 0 && <p className="mt-1 text-xs text-ink-tertiary">暂无分镜组，请先完成分镜与视频生成。</p>}

        {preview && !preview.draft && (
          <p className="mt-2 text-xs text-ink-tertiary">该分镜组还没有匹配的脚本草稿，请先在「脚本生成」中生成。</p>
        )}
        {preview?.draft && (
          <div className="mt-3">
            <p className="text-xs text-ink-secondary">脚本：{preview.draft.title || preview.draft.id}　预计成片 ≈ {preview.totalDurationSec.toFixed(1)}s</p>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-ink-tertiary">
                  <th className="py-1 pr-2">分镜</th><th className="py-1 pr-2">字幕</th><th className="py-1">片段</th>
                </tr>
              </thead>
              <tbody>
                {preview.segments.map((s) => (
                  <tr key={s.shotIndex} className="border-t border-hairline">
                    <td className="py-1 pr-2">#{s.shotIndex}</td>
                    <td className="py-1 pr-2 text-ink-secondary">{s.subtitle || '—'}</td>
                    <td className="py-1">✓ {s.clipDurationSec.toFixed(1)}s</td>
                  </tr>
                ))}
                {preview.issues.map((i) => (
                  <tr key={`issue-${i.shotIndex}`} className="border-t border-hairline">
                    <td className="py-1 pr-2">#{i.shotIndex}</td>
                    <td className="py-1 pr-2 text-ink-tertiary">—</td>
                    <td className="py-1 text-red-500">✗ {i.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ② 包装配置 */}
      <div className="rounded-lg border border-hairline p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">画面比例</label>
            <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="input-field text-sm">
              {RESOLUTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">封面标题（留空则不加字）</label>
            <input value={coverTitle} onChange={(e) => setCoverTitle(e.target.value)} className="input-field text-sm" placeholder="如：三大亮点一次看完" />
          </div>
          <div>
            <label className="label">片头贴片</label>
            <select value={introSec} onChange={(e) => setIntroSec(Number(e.target.value))} className="input-field text-sm">
              <option value={0}>无</option><option value={1}>1 秒</option><option value={2}>2 秒</option>
            </select>
          </div>
          <div>
            <label className="label">BGM</label>
            <select value={bgmPath} onChange={(e) => setBgmPath(e.target.value)} className="input-field text-sm">
              <option value="">无 BGM</option>
              {bgmFiles.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
            </select>
            <div className="mt-1 flex items-center gap-2 text-xs text-ink-secondary">
              <input type="file" accept=".mp3,.m4a,.wav,.aac,.flac" className="text-xs"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadBgm(f); e.target.value = ''; }} />
            </div>
            {bgmPath && (
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="text-ink-tertiary">音量 {Math.round(bgmVolume * 100)}%</span>
                <input type="range" min={0.05} max={0.6} step={0.05} value={bgmVolume} onChange={(e) => setBgmVolume(Number(e.target.value))} />
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={ducking} onChange={(e) => setDucking(e.target.checked)} /> 口播时压低
                </label>
              </div>
            )}
          </div>
          <div>
            <label className="label">字幕</label>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={subtitleEnabled} onChange={(e) => setSubtitleEnabled(e.target.checked)} /> 烧录字幕
              </label>
              {subtitleEnabled && (
                <span className="flex items-center gap-1 text-ink-secondary">
                  字号 <input type="number" min={28} max={96} value={subtitleSize} onChange={(e) => setSubtitleSize(Number(e.target.value))} className="input-field w-16 text-xs" />
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={handleSubmit}
          disabled={submitting || !preview?.draft || (preview?.segments.length ?? 0) === 0}
          className="btn-primary btn-sm"
        >
          {submitting ? '提交中…' : '开始合成成片'}
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      {/* ③ 任务列表 */}
      <div className="space-y-2">
        {jobs.length === 0 && <p className="text-xs text-ink-tertiary">暂无成片任务。</p>}
        {jobs.map((job) => (
          <div key={job.id} className="rounded-lg border border-hairline p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{job.packageConfig.outputName || job.id}</p>
                <p className="text-xs text-ink-tertiary">
                  {STEP_LABELS[job.currentStep] || job.currentStep}
                  {job.status === 'succeeded' && job.durationSec ? ` · ${job.durationSec.toFixed(1)}s` : ''}
                  {job.status === 'failed' ? ' · 失败' : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {job.status === 'failed' && (
                  <button onClick={() => handleRetry(job.id)} className="btn-secondary btn-sm">重试</button>
                )}
                {job.status !== 'running' && job.status !== 'pending' && (
                  <button onClick={() => handleDelete(job.id)} className="btn-danger btn-sm">删除</button>
                )}
                {job.status === 'succeeded' && job.outputUrl && (
                  <a href={job.outputUrl} download className="btn-secondary btn-sm">下载</a>
                )}
              </div>
            </div>
            {(job.status === 'pending' || job.status === 'running') && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-surface-subtle">
                <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(job.progress)}%`, background: 'var(--color-accent)' }} />
              </div>
            )}
            {job.status === 'failed' && job.errorMessage && (
              <p className="mt-2 break-all text-xs text-red-500">{job.errorMessage}</p>
            )}
            {job.status === 'succeeded' && job.outputUrl && (
              <div className="mt-2 flex items-start gap-3">
                <video controls preload="metadata" src={job.outputUrl} poster={job.coverUrl || undefined} className="max-h-72 rounded-lg border border-hairline" />
                {job.coverUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={job.coverUrl} alt="封面" className="max-h-72 rounded-lg border border-hairline object-cover" />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
