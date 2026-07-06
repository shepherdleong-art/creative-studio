'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TEMPLATE_OPTIONS, type CoverTemplateId } from '@/lib/final-video/cover-templates';

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
interface NarrationProviderOption { id: string; name: string; type: string; voices: string[] }
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
  { key: '3:4', label: '竖版 3:4 1440×1920', width: 1440, height: 1920 },
  { key: '16:9', label: '横版 1920×1080', width: 1920, height: 1080 },
  { key: '1:1', label: '方形 1080×1080', width: 1080, height: 1080 },
];

/** 封面标题默认字号；§5-A 把原先写死的魔法数 72 提到此常量。 */
const DEFAULT_COVER_TITLE_SIZE = 72;

/** 从预览分镜字幕中提取前 N 条非空短句作为封面卖点 */
function extractSellingPoints(segments: PreviewSegment[], maxLen = 20, maxItems = 3): string[] {
  const points: string[] = [];
  for (const seg of segments) {
    const t = (seg.subtitle || '').trim();
    if (!t) continue;
    points.push(t.length > maxLen ? t.slice(0, maxLen) + '…' : t);
    if (points.length >= maxItems) break;
  }
  return points;
}

export default function FinalVideoPanel({ projectId }: { projectId: string }) {
  const [shotSets, setShotSets] = useState<ShotSetOption[]>([]);
  const [selectedSetId, setSelectedSetId] = useState('');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [bgmFiles, setBgmFiles] = useState<BgmFile[]>([]);
  const [bgmDir, setBgmDir] = useState('');
  const [jobs, setJobs] = useState<FinalJob[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 包装配置表单
  const [resolution, setResolution] = useState('9:16');
  const [bgmPath, setBgmPath] = useState('');
  const [bgmVolume, setBgmVolume] = useState(0.25);
  const [ducking, setDucking] = useState(true);
  const [coverTitle, setCoverTitle] = useState('');
  const [titleSize, setTitleSize] = useState(DEFAULT_COVER_TITLE_SIZE);
  const [introSec, setIntroSec] = useState(0);
  const [subtitleEnabled, setSubtitleEnabled] = useState(true);
  const [subtitleSize, setSubtitleSize] = useState(56);
  const [narrationMode, setNarrationMode] = useState<'none' | 'tts'>('none');
  const [narrationProviders, setNarrationProviders] = useState<NarrationProviderOption[]>([]);
  const [narrationProviderId, setNarrationProviderId] = useState('');
  const [voice, setVoice] = useState('Cherry');
  const [speed, setSpeed] = useState(1.0);
  const [coverTemplate, setCoverTemplate] = useState<CoverTemplateId>('minimal-01');
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Feature 2: 标题脏标记 — 用 ref 避免预览请求返回时读取旧状态而覆盖用户输入
  const titleTouchedRef = useRef(false);
  const lastAutoTitleRef = useRef('');

  const loadBgm = useCallback(async () => {
    const resp = await fetch('/api/bgm');
    const data = await resp.json().catch(() => ({}));
    setBgmFiles(data.bgm ?? []);
    setBgmDir(data.dir ?? '');
  }, []);

  const loadNarrationProviders = useCallback(async () => {
    const resp = await fetch('/api/providers/narration');
    const data = await resp.json().catch(() => []);
    const configured: NarrationProviderOption[] = (Array.isArray(data) ? data : [])
      .filter((p: { configured?: boolean }) => p.configured)
      .map((p: { id: string; name: string; type: string; voices?: string[] }) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        voices: p.voices ?? [],
      }));
    setNarrationProviders(configured);
    setNarrationProviderId((prev) => (configured.some((p) => p.id === prev) ? prev : configured[0]?.id ?? ''));
  }, []);

  const loadJobs = useCallback(async () => {
    const resp = await fetch(`/api/projects/${projectId}/final-videos`);
    const data = await resp.json().catch(() => ({}));
    setJobs(data.jobs ?? []);
  }, [projectId]);

  // 挂载 / 切换项目时加载分镜组列表、BGM 列表、任务列表
  useEffect(() => {
    let active = true;
    (async () => {
      // 分镜组
      const setsResp = await fetch(`/api/projects/${projectId}/shot-sets`);
      const data = await setsResp.json().catch(() => []);
      const sets: ShotSetOption[] = (Array.isArray(data) ? data : []).map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }));
      if (active) {
        setShotSets(sets);
        setSelectedSetId((prev) => (sets.some((s) => s.id === prev) ? prev : sets[0]?.id ?? ''));
      }
      // BGM
      const bgmResp = await fetch('/api/bgm');
      const bgmData = await bgmResp.json().catch(() => ({}));
      if (active) {
        setBgmFiles(bgmData.bgm ?? []);
        setBgmDir(bgmData.dir ?? '');
      }
      // 口播供应商（只保留已配置的）
      if (active) await loadNarrationProviders();
      // 任务
      const jobsResp = await fetch(`/api/projects/${projectId}/final-videos`);
      const jobsData = await jobsResp.json().catch(() => ({}));
      if (active) setJobs(jobsData.jobs ?? []);
    })();
    return () => { active = false; };
  }, [projectId, loadNarrationProviders]);

  // 切换分镜组时重新加载预览
  useEffect(() => {
    let active = true;
    (async () => {
      if (!selectedSetId) { if (active) setPreview(null); return; }
      const resp = await fetch(`/api/projects/${projectId}/final-videos/preview?shotSetId=${encodeURIComponent(selectedSetId)}`);
      const p = await resp.json().catch(() => null) as PreviewData | null;
      if (active) {
        setPreview(p);
        if (!titleTouchedRef.current && p?.draft) {
          const newTitle = p.draft.title ?? '';
          lastAutoTitleRef.current = newTitle;
          setCoverTitle(newTitle);
        }
      }
    })();
    return () => { active = false; };
  }, [projectId, selectedSetId]);

  // 切换口播供应商时：若当前音色不在新供应商的音色列表中，回退到列表首项。
  // 用"渲染期间调整状态"而非 effect（同步 setState 会触发一次多余的级联渲染，见
  // react-hooks/set-state-in-effect），在同一次渲染内完成修正，不多产生一帧。
  const [voiceSyncedProviderId, setVoiceSyncedProviderId] = useState('');
  if (narrationProviderId !== voiceSyncedProviderId) {
    setVoiceSyncedProviderId(narrationProviderId);
    const p = narrationProviders.find((np) => np.id === narrationProviderId);
    if (p && p.voices.length > 0 && !p.voices.includes(voice)) {
      setVoice(p.voices[0]);
    }
  }

  // 有活跃任务时每 2s 轮询
  useEffect(() => {
    const active = jobs.some((j) => j.status === 'pending' || j.status === 'running');
    if (active && !pollTimer.current) {
      pollTimer.current = setInterval(() => {
        void loadJobs();
      }, 2000);
    }
    if (!active && pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [jobs, loadJobs]);

  const handleTitleChange = (value: string) => {
    setCoverTitle(value);
    titleTouchedRef.current = value !== '' && value !== lastAutoTitleRef.current;
  };

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
    const sellingPoints = preview ? extractSellingPoints(preview.segments) : [];
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
            cover: {
              titleText: coverTitle,
              titleSize,
              titleColor: '#ffffff',
              introDurationSec: introSec,
              templateId: coverTemplate,
              sellingPoints,
            },
            narration: { mode: narrationMode, voice, speed, providerId: narrationProviderId },
            subtitle: { enabled: subtitleEnabled, fontSize: subtitleSize, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 18 },
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
  }, [projectId, selectedSetId, resolution, bgmPath, bgmVolume, ducking, coverTitle, titleSize, introSec, subtitleEnabled, subtitleSize, narrationMode, narrationProviderId, voice, speed, loadJobs, preview, coverTemplate]);

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
            <label className="label">口播配音</label>
            <select
              value={narrationMode}
              onChange={(e) => setNarrationMode(e.target.value as 'none' | 'tts')}
              className="input-field text-sm"
            >
              <option value="none">不配音（仅画面+BGM）</option>
              <option value="tts" disabled={narrationProviders.length === 0}>AI 配音</option>
            </select>
            {narrationProviders.length === 0 && (
              <p className="mt-1 text-[10px] text-ink-tertiary">未配置任何口播供应商，请先在「设置」→「口播配音」配置</p>
            )}
            {narrationMode === 'tts' && narrationProviders.length > 0 && (
              <div className="mt-1 space-y-1">
                {narrationProviders.length > 1 && (
                  <select value={narrationProviderId} onChange={(e) => setNarrationProviderId(e.target.value)} className="input-field text-xs">
                    {narrationProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
                <div className="flex items-center gap-2 text-xs">
                  <select value={voice} onChange={(e) => setVoice(e.target.value)} className="input-field w-24 text-xs">
                    {(narrationProviders.find((p) => p.id === narrationProviderId)?.voices ?? []).map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  <span className="text-ink-tertiary">语速 {speed.toFixed(1)}x</span>
                  <input type="range" min={0.8} max={1.5} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
                </div>
              </div>
            )}
          </div>
          <div>
            <label className="label">BGM</label>
            <select value={bgmPath} onChange={(e) => setBgmPath(e.target.value)} className="input-field text-sm">
              <option value="">无 BGM</option>
              {bgmFiles.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
            </select>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <label className="btn-secondary btn-sm cursor-pointer">
                上传 BGM
                <input
                  type="file"
                  accept=".mp3,.m4a,.wav,.aac,.flac"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadBgm(f); e.target.value = ''; }}
                />
              </label>
              <button type="button" onClick={() => void loadBgm()} className="btn-secondary btn-sm">刷新列表</button>
            </div>
            {bgmDir && (
              <div className="mt-1 flex items-center gap-1 text-[10px] text-ink-tertiary">
                <span className="truncate">BGM 目录：{bgmDir}（全局共享，所有项目可用）</span>
                <button type="button" onClick={() => void navigator.clipboard.writeText(bgmDir)} className="shrink-0 text-accent underline">
                  复制
                </button>
              </div>
            )}
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

        {/* 封面 / 片头：标题、字号、模板、片头停留统一归组 */}
        <div className="rounded-md border border-hairline p-3">
          <p className="label">封面 / 片头</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">封面标题（留空则不加字）</label>
              <input value={coverTitle} onChange={(e) => handleTitleChange(e.target.value)} className="input-field text-sm" placeholder="如：三大亮点一次看完" />
              <span className="mt-1 flex items-center gap-1 text-xs text-ink-secondary">
                字号 <input type="number" min={32} max={120} value={titleSize} onChange={(e) => setTitleSize(Number(e.target.value) || DEFAULT_COVER_TITLE_SIZE)} className="input-field w-16 text-xs" />
              </span>
            </div>
            <div>
              <label className="label">封面片头停留</label>
              <select value={introSec} onChange={(e) => setIntroSec(Number(e.target.value))} className="input-field text-sm">
                <option value={0}>无</option><option value={1}>1 秒</option><option value={2}>2 秒</option><option value={3}>3 秒</option>
              </select>
              <p className="mt-1 text-[10px] text-ink-tertiary">在正片前把封面作为静帧停留 N 秒</p>
            </div>
          </div>
          <div className="mt-3">
            <label className="label">封面模板</label>
            <div className="grid grid-cols-3 gap-2">
              {TEMPLATE_OPTIONS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setCoverTemplate(t.id)}
                  className={`overflow-hidden rounded-lg border text-left ${coverTemplate === t.id ? 'border-accent ring-1 ring-accent' : 'border-hairline'}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.previewImage} alt={t.name} className="aspect-[9/16] w-full object-cover" />
                  <div className="px-1.5 py-1">
                    <p className="truncate text-xs">{t.name}</p>
                    <p className="truncate text-[10px] text-ink-tertiary">{t.elements.join(' · ')}</p>
                  </div>
                </button>
              ))}
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
